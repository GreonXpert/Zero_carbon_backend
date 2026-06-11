'use strict';

// ============================================================================
// queryController.js — POST /api/greon-iq/query
//
// Gate 4 — client resolution order for multi-client roles:
//   1. body.clientId sent explicitly (frontend passes this only on first message)
//   2. Existing session.clientId  (follow-up messages reuse the session's client)
//   3. Client extracted from message text  ("show Greon008 data" / "Acme Corp")
//   4. Nothing found → inline CLIENT_RESOLUTION_NEEDED prompt
//
// PERMISSION DENIALS inside gates 7-10 return HTTP 200 restricted:true so the
// frontend renders them as chat bubbles instead of toast errors.
// ============================================================================

const { resolveClientScope, resolveAccessibleClients, SINGLE_CLIENT_ROLES } = require('../services/clientScopeResolver');
const { extractClientFromQuestion, extractClientFromDB, detectCrossClientAttempt } = require('../services/clientExtractorService');
const { buildAccessContext }      = require('../services/accessContextService');
const { classifyIntent, resolveAmbiguousIntent } = require('../services/intentRouterService');
const { buildQueryPlan }          = require('../services/queryPlannerService');
const { compose }                 = require('../services/responseComposerService');
const { isGreonIQEnabled }        = require('../services/quotaResolutionService');
const { checkQuota, deductQuota } = require('../services/quotaUsageService');
const { saveMessage, getOrCreateSession, updateContextState } = require('../services/chatSessionService');
const { writeAuditLog }           = require('../services/auditService');
const { getBaseCredits }          = require('../utils/quotaMathHelpers');
const { explainQuotaExhausted, explainGreonIQDisabled } = require('../utils/permissionExplainer');
const { DENIAL_MESSAGES }         = require('../registry/promptRegistry');
const ChatSession                 = require('../models/ChatSession');

const RETRIEVERS = {
  emissionSummaryRetriever:    require('../retrievers/emissionSummaryRetriever'),
  dataEntryRetriever:          require('../retrievers/dataEntryRetriever'),
  reductionRetriever:          require('../retrievers/reductionRetriever'),
  sbtiRetriever:               require('../retrievers/m3Retriever'),
  m3Retriever:                 require('../retrievers/m3Retriever'),
  esgRetriever:                require('../retrievers/esgRetriever'),
  brsrRetriever:               require('../retrievers/brsrRetriever'),
  vectorRetriever:             require('../retrievers/vectorRetriever'),
  userDataRetriever:           require('../retrievers/userDataRetriever'),
  clientComparisonRetriever:     require('../retrievers/clientComparisonRetriever'),
  crossClientSummaryRetriever:   require('../retrievers/crossClientSummaryRetriever'),
};

// Only these roles bypass the credit wallet — client_admin uses a wallet.
const UNLIMITED_ROLES    = ['super_admin', 'consultant_admin'];
const MULTI_CLIENT_ROLES = ['super_admin', 'consultant_admin', 'consultant'];

async function query(req, res) {
  const startTime = Date.now();
  const user      = req.user;
  const body      = req.body || {};
  const question  = (body.question || '').trim();
  const sessionId = body.sessionId || null;

  if (!question) {
    return res.status(400).json({ success: false, code: 'MISSING_QUESTION', message: 'question is required.' });
  }

  if (question.length > 2000) {
    return res.status(400).json({ success: false, code: 'QUESTION_TOO_LONG', message: 'Question must be under 2000 characters.' });
  }

  let auditPayload = {
    userId:        user._id,
    userType:      user.userType,
    clientId:      null,
    question,
    status:        'invalid_request',
    durationMs:    0,
    quotaConsumed: 0,
  };

  try {
    // ── Gate 4: Resolve the active client ────────────────────────────────────
    //
    // Resolution order for multi-client roles:
    //  1. body.clientId  — frontend sends this only for the FIRST message of a
    //                      new session (sessionId is null).
    //  2. session.clientId — follow-up messages reuse whatever client was set
    //                        when the session was created.  This prevents a stale
    //                        resolvedClientId from a previous chat from polluting
    //                        a new chat that happens to share the same Redux store.
    //  3. Message extraction — if the user says "show me Greon008 emissions" or
    //                          "ESG data for Acme Corp", extract and validate.
    //  4. Ask inline — return CLIENT_RESOLUTION_NEEDED with selectable chips.

    let bodyClientId = body.clientId || null;

    // ── Step 2: pull from existing session ───────────────────────────────────
    if (!bodyClientId && sessionId && MULTI_CLIENT_ROLES.includes(user.userType)) {
      try {
        const existingSession = await ChatSession.findOne(
          { _id: sessionId, userId: user._id },
          { clientId: 1 }
        ).lean();
        if (existingSession?.clientId) {
          // B6: Validate the stored session clientId is still within the user's scope.
          // Prevents a tampered session document from granting cross-client access.
          const sessionValidation = await resolveClientScope(user, existingSession.clientId);
          if (!sessionValidation.error && !sessionValidation.needsClientResolution) {
            bodyClientId = existingSession.clientId;
          }
          // If validation fails, fall through to step 3 (question extraction) or step 4 (ask user)
        }
      } catch (_) { /* non-fatal */ }
    }

    // ── Step 3: extract from question text ────────────────────────────────────
    // Resolution sub-steps for multi-client roles when message text is present:
    //   3a. Check accessible clients list — fast, no extra DB call
    //   3b. For super_admin: try full-DB extraction (they can access any client)
    //   3c. For consultant/consultant_admin: if message mentions a client that is
    //       in the DB but NOT in their assigned list → specific "not assigned"
    //       restriction instead of the generic client-selection list.
    //
    // IMPORTANT — Mid-session client switch:
    //   Even when the session already has a stored clientId, the user may ask
    //   about a DIFFERENT client in the same message (e.g., previous session was
    //   Greon012 but user now asks "give me details of Greon008").
    //   We detect this by checking whether the question looks like it names a
    //   clientId pattern ([letters ≥3][digits ≥2]). If it does, we run the full
    //   extraction even when bodyClientId is already set, and override if the
    //   extracted client differs from the session's client.
    let accessibleClientsCache = null;

    // Quick pre-check: does the question contain something that looks like a clientId?
    // This avoids calling resolveAccessibleClients() on every plain follow-up message.
    const questionMentionsClientPattern = /\b[A-Za-z]{3,}\d{2,}\b/.test(question);

    // B5: Skip DB-based clientId extraction for very long questions (>80 words).
    // Extremely long inputs are unlikely to contain a reliable clientId reference and
    // trigger expensive resolveAccessibleClients + extractClientFromDB calls.
    // If no clientId is set, the system will fall through to CLIENT_RESOLUTION_NEEDED.
    const questionWordCount = question.split(/\s+/).length;
    const skipClientExtraction = questionWordCount > 80 && !bodyClientId;

    if ((!bodyClientId || questionMentionsClientPattern) && MULTI_CLIENT_ROLES.includes(user.userType) && !skipClientExtraction) {
      accessibleClientsCache = await resolveAccessibleClients(user);

      // 3a: Try to match against the user's own accessible clients list.
      //     If the question explicitly names a client, ALWAYS use it — even if
      //     the session already has a different clientId stored (mid-session switch).
      const extracted = extractClientFromQuestion(question, accessibleClientsCache);
      if (extracted) {
        const validation = await resolveClientScope(user, extracted.clientId);
        if (!validation.error && !validation.needsClientResolution) {
          bodyClientId = extracted.clientId;  // overrides session client if different
        }
      }

      // 3b: super_admin — try full-DB extraction (all clients are accessible).
      //     Run when no clientId is set OR when question names a different client.
      if (user.userType === 'super_admin' && (!bodyClientId || questionMentionsClientPattern)) {
        const dbExtracted = await extractClientFromDB(question);
        if (dbExtracted && dbExtracted.clientId !== bodyClientId) {
          bodyClientId = dbExtracted.clientId; // super_admin: no validation needed
        }
      }

      // 3c: consultant / consultant_admin — detect if message mentions a client
      //     that EXISTS in the DB but is NOT in their assigned list.
      //     Also handles mid-session switch to a different assigned client.
      if (user.userType !== 'super_admin' && (!bodyClientId || questionMentionsClientPattern)) {
        const dbExtracted = await extractClientFromDB(question);
        if (dbExtracted && dbExtracted.clientId !== bodyClientId) {
          // Validate whether this consultant has authority over that client
          const validation = await resolveClientScope(user, dbExtracted.clientId);
          if (validation.error || validation.needsClientResolution) {
            // Client exists in DB but NOT assigned to this consultant
            auditPayload.status            = 'access_restricted';
            auditPayload.restrictionCode   = 'CLIENT_NOT_ASSIGNED';
            auditPayload.attemptedClientId = dbExtracted.clientId;
            auditPayload.durationMs        = Date.now() - startTime;
            await writeAuditLog(auditPayload);

            const clientsText = accessibleClientsCache?.length
              ? '\n\nYour accessible clients:\n' +
                accessibleClientsCache.map((c) => {
                  const name = c.companyName && c.companyName !== c.clientId
                    ? `**${c.companyName}** (\`${c.clientId}\`)`
                    : `\`${c.clientId}\``;
                  return `• ${name}`;
                }).join('\n')
              : '';

            return res.status(200).json({
              success:           true,
              restricted:        true,
              restrictionCode:   'CLIENT_NOT_ASSIGNED',
              answer:
                `⚠️ **Access Restricted**\n\n` +
                `You asked about **${dbExtracted.companyName}** (\`${dbExtracted.clientId}\`), ` +
                `but this client is not assigned to your account.\n\n` +
                `Please contact your administrator if you need access to this client.` +
                clientsText,
              accessibleClients: accessibleClientsCache || [],
              quotaConsumed:     0,
              sessionId:         null,
            });
          } else {
            // Validation passed — use the extracted client
            bodyClientId = dbExtracted.clientId;
          }
        }
      }
    }

    // ── Step 3b: cross-client text detection for single-client roles ─────────
    // Catches BOTH registered clients (DB match) AND external company names
    // (e.g. "give me Infosys data" when user belongs to SunGrow).
    if (!bodyClientId && SINGLE_CLIENT_ROLES.includes(user.userType) && user.clientId) {
      const crossMention = await detectCrossClientAttempt(
        question,
        user.clientId,
        user.companyName || ''
      );

      if (crossMention) {
        auditPayload.clientId          = user.clientId;
        auditPayload.status            = 'access_restricted';
        auditPayload.restrictionCode   = 'CROSS_CLIENT_ACCESS_DENIED';
        auditPayload.restrictionReason = crossMention.notInSystem
          ? `Mentioned external company "${crossMention.companyName}" not registered in platform`
          : `Attempted to access client ${crossMention.clientId} (${crossMention.companyName})`;
        auditPayload.attemptedClientId = crossMention.notInSystem ? null : crossMention.clientId;
        auditPayload.durationMs        = Date.now() - startTime;
        await writeAuditLog(auditPayload);

        const ownName = user.companyName || `your organisation (${user.clientId})`;
        const answer  = crossMention.notInSystem
          ? `⚠️ **Access Restricted**\n\n` +
            `You asked about **${crossMention.companyName}**, but your account is restricted ` +
            `to your own organisation's data (**${ownName}**).\n\n` +
            `GreOn IQ can only answer questions about your own company's data. ` +
            `Please rephrase your question without specifying another company name.`
          : `⚠️ **Access Restricted**\n\n` +
            `Your account is restricted to your own organisation's data (**${ownName}**). ` +
            `You do not have permission to query data for **${crossMention.companyName}**.\n\n` +
            `If you need access to multiple clients, please contact your consultant or administrator.`;

        return res.status(200).json({
          success:         true,
          restricted:      true,
          restrictionCode: 'CROSS_CLIENT_ACCESS_DENIED',
          answer,
          quotaConsumed:   0,
          sessionId:       null,
        });
      }
    }

    // ── Step 4: normal scope resolution (handles single-client roles too) ────
    const scopeResult = await resolveClientScope(user, bodyClientId);

    // ── crossClientAttempt: body.clientId explicitly targeted another client ──
    // resolveClientScope detected the mismatch and set this flag.
    if (scopeResult.crossClientAttempt) {
      auditPayload.clientId          = scopeResult.clientId;
      auditPayload.status            = 'access_restricted';
      auditPayload.restrictionCode   = 'CROSS_CLIENT_ACCESS_DENIED';
      auditPayload.restrictionReason = `Attempted to access client ${scopeResult.crossClientAttempt} via body.clientId`;
      auditPayload.attemptedClientId = scopeResult.crossClientAttempt;
      auditPayload.durationMs        = Date.now() - startTime;
      await writeAuditLog(auditPayload);

      return res.status(200).json({
        success:         true,
        restricted:      true,
        restrictionCode: 'CROSS_CLIENT_ACCESS_DENIED',
        answer:
          `⚠️ **Access Restricted**\n\n` +
          `Your account (${user.userType}) is restricted to your own organisation's data ` +
          `(\`${scopeResult.clientId}\`). ` +
          `You cannot query data for other clients.\n\n` +
          `If you need access to multiple clients, please contact your administrator.`,
        quotaConsumed: 0,
        sessionId:     null,
      });
    }

    // ── user_data bypass: management questions (show my clients, how many users…)
    // do not need a specific client context for multi-client roles.
    // Detect early and override the needsClientResolution flag so the
    // client-selection prompt is skipped entirely.
    if (scopeResult.needsClientResolution && MULTI_CLIENT_ROLES.includes(user.userType)) {
      const earlyIntent = classifyIntent(question).intent;
      if (earlyIntent === 'user_data') {
        scopeResult.needsClientResolution = false;
        scopeResult.clientId = '__user_scope__';
      } else if (earlyIntent === 'cross_client_summary') {
        // Cross-client ranking: no single clientId needed — retriever fetches all accessible clients.
        scopeResult.needsClientResolution = false;
        scopeResult.clientId = '__cross_client__';
      }
    }

    // ── needsClientResolution → ask inline with selectable chips ─────────────
    if (scopeResult.needsClientResolution) {
      const clients = accessibleClientsCache || scopeResult.accessibleClients || [];

      let promptText;
      if (clients.length === 0) {
        promptText =
          'You are not currently assigned to any client. ' +
          'Please contact your administrator to be assigned to a client before using GreOn IQ.';
      } else {
        const list = clients
          .map((c) => {
            const hasDistinctName = c.companyName && c.companyName !== c.clientId;
            return hasDistinctName
              ? `• **${c.companyName}** — \`${c.clientId}\``
              : `• \`${c.clientId}\``;
          })
          .join('\n');
        promptText =
          'To answer your question I need to know which client\'s data to query.\n\n' +
          '💡 **Tip:** You can mention the client name or ID directly in your message ' +
          '(e.g. *"show emissions for Greon008"*) to skip this step next time.\n\n' +
          'Your accessible clients:\n\n' +
          list + '\n\n' +
          'Select a client below or type the client name/ID in your question.';
      }

      auditPayload.status     = 'client_resolution_needed';
      auditPayload.durationMs = Date.now() - startTime;
      await writeAuditLog(auditPayload);

      return res.status(200).json({
        success:           true,
        restricted:        true,
        restrictionCode:   'CLIENT_RESOLUTION_NEEDED',
        answer:            promptText,
        accessibleClients: clients,
        quotaConsumed:     0,
        sessionId:         null,
      });
    }

    if (scopeResult.error) {
      return res.status(400).json({ success: false, code: scopeResult.code, message: scopeResult.error });
    }

    const { clientId } = scopeResult;
    auditPayload.clientId = clientId;

    // ── Gate 2: greonIQEnabled ───────────────────────────────────────────────
    // user_data queries (management lookups) are treated as unlimited — they
    // work across all clients and the quota system expects a real clientId.
    const isUserDataQuery   = clientId === '__user_scope__';
    const isBypassQuery     = isUserDataQuery || clientId === '__cross_client__';
    const enabledCheck = UNLIMITED_ROLES.includes(String(user.userType || '')) || isBypassQuery
      ? { enabled: true, isUnlimited: true, allocation: null, monthlyLimit: null, weeklyLimit: null, dailyLimit: null }
      : await isGreonIQEnabled(user, clientId);

    if (!enabledCheck.enabled) {
      auditPayload.status = 'greon_iq_disabled';
      await writeAuditLog(auditPayload);
      return res.status(403).json({
        success: false,
        code:    'GREON_IQ_DISABLED',
        message: explainGreonIQDisabled(),
      });
    }

    // ── Gate 3: Quota check ──────────────────────────────────────────────────
    const quotaCheck = await checkQuota(user._id, clientId, enabledCheck);
    if (!quotaCheck.allowed) {
      auditPayload.status = 'quota_exhausted';
      await writeAuditLog(auditPayload);
      return res.status(429).json({
        success:              false,
        code:                 'QUOTA_EXHAUSTED',
        message:              explainQuotaExhausted(quotaCheck.period, quotaCheck.resetAt),
        resetAt:              quotaCheck.resetAt,
        historyAccessAllowed: true,
      });
    }

    // ── Build access context (Gates 7–10 inputs) ─────────────────────────────
    const accessContext = await buildAccessContext(user, clientId);

    // ── Gate 5: Intent classification ────────────────────────────────────────
    const session = sessionId
      ? await getOrCreateSession(user._id, clientId, sessionId)
      : await getOrCreateSession(user._id, clientId);

    const contextState = session?.contextState || {};
    const { intent }   = classifyIntent(question);

    let resolvedIntent = intent;
    if (intent === 'ambiguous') {
      resolvedIntent = resolveAmbiguousIntent(question, contextState) || 'ambiguous';
    }

    if (resolvedIntent === 'out_of_system') {
      auditPayload.normalizedIntent = 'out_of_system';
      auditPayload.status           = 'out_of_system';
      await writeAuditLog(auditPayload);
      return res.status(200).json({
        success:       false,
        code:          'OUT_OF_SYSTEM',
        message:       DENIAL_MESSAGES.out_of_system,
        quotaConsumed: 0,
      });
    }

    // ── Gates 6-10: Query planning ────────────────────────────────────────────
    const planResult = buildQueryPlan({
      intent:    resolvedIntent,
      question,
      accessContext,
      contextState,
    });

    // ── In-chat restriction (domain denied, assessment level, ambiguous) ──────
    if (planResult.restrictionMessage) {
      const restrictionCode = planResult.restrictionCode || 'ACCESS_RESTRICTED';
      const attemptedDomain = planResult.attemptedDomain || resolvedIntent;

      auditPayload.normalizedIntent  = resolvedIntent;
      auditPayload.status            = 'access_restricted';
      auditPayload.restrictionCode   = restrictionCode;
      auditPayload.restrictionReason = planResult.restrictionMessage;
      auditPayload.attemptedDomain   = attemptedDomain;
      auditPayload.attemptedClientId = clientId;
      auditPayload.durationMs        = Date.now() - startTime;
      await writeAuditLog(auditPayload);

      try {
        await saveMessage(session._id, {
          userId:           user._id,
          clientId,
          userQuestion:     question,
          answer:           planResult.restrictionMessage,
          outputMode:       'plain',
          tables:           [],
          charts:           [],
          exclusions:       [],
          followupQuestions:[],
          quotaUsed:        0,
          aiMeta:           {},
          trace:            { restricted: true, restrictionCode },
        });
      } catch (_) {}

      return res.status(200).json({
        success:       true,
        restricted:    true,
        restrictionCode,
        answer:        planResult.restrictionMessage,
        sessionId:     session._id,
        quotaConsumed: 0,
      });
    }

    if (planResult.error) {
      auditPayload.normalizedIntent = resolvedIntent;
      auditPayload.status           = 'permission_denied';
      await writeAuditLog(auditPayload);
      return res.status(403).json({
        success: false,
        code:    planResult.code || 'PERMISSION_DENIED',
        message: planResult.error,
      });
    }

    // For user_data queries, pass the full user so the retriever can build
    // role-scoped DB queries (assignedClients, consultantAdminId, etc.).
    const _needsRequestingUser = ['user_data', 'cross_client_summary'].includes(planResult.plan.domain);
    const plan = {
      ...planResult.plan,
      originalQuestion: question,
      requestingUser:   _needsRequestingUser ? user : undefined,
    };

    // ── client_comparison: resolve all mentioned clients and inject into plan ──
    if (resolvedIntent === 'client_comparison') {
      if (!MULTI_CLIENT_ROLES.includes(user.userType)) {
        return res.status(200).json({
          success:         true,
          restricted:      true,
          restrictionCode: 'PERMISSION_DENIED',
          answer:          '⚠️ Client comparison is only available for consultant and administrator roles.',
          sessionId:       session._id,
          quotaConsumed:   0,
        });
      }

      const comparisonClients = await _resolveComparisonClients(
        question, user, accessibleClientsCache
      );

      if (comparisonClients.length < 2) {
        const accessible = (accessibleClientsCache || []).slice(0, 8)
          .map((c) => `• **${c.companyName && c.companyName !== c.clientId ? c.companyName : c.clientId}** (\`${c.clientId}\`)`)
          .join('\n');
        return res.status(200).json({
          success:       true,
          sessionId:     session._id,
          messageId:     null,
          answer:
            `To compare client emissions, mention two or more client IDs or names in your question.\n\n` +
            `**Example:** *"Compare Greon008 and Greon009 emissions"*\n\n` +
            (accessible ? `Your accessible clients:\n${accessible}` : ''),
          outputMode:        'plain',
          tables:            [],
          charts:            [],
          exclusions:        [],
          followupQuestions: [],
          quotaConsumed:     0,
          quotaUsed:         0,
        });
      }

      plan.clientIds   = comparisonClients.map((c) => c.clientId);
      plan.clientNames = Object.fromEntries(comparisonClients.map((c) => [c.clientId, c.companyName]));
      plan.outputMode  = 'chart';
    }

    // ── Retrieval ─────────────────────────────────────────────────────────────
    const retrieverKey = plan.retriever;
    const retriever    = RETRIEVERS[retrieverKey];
    if (!retriever) {
      // No retriever registered for this intent — return a friendly in-chat message
      // without calling DeepSeek or deducting quota.
      const domainHint = plan.domain || plan.intent || 'that topic';
      const friendlyMsg =
        plan.intent === 'report'
          ? "I can help you generate a report — please use the Reports section, or ask about emissions or reduction data for a specific period."
          : plan.intent === 'ticket'
          ? "Ticket data is not yet available in Greon IQ. Please use the Tickets section directly."
          : `I don't have access to '${domainHint}' data yet. You can ask about emissions, reductions, data entries, users, or ESG metrics.`;

      auditPayload = {
        ...auditPayload,
        normalizedIntent: resolvedIntent,
        detectedProduct:  plan.product,
        queryPlan:        _safeAuditPlan(plan),
        durationMs:       Date.now() - startTime,
        status:           'permission_denied',
        errorCode:        'RETRIEVER_NOT_FOUND',
      };
      await writeAuditLog(auditPayload).catch(() => {});

      return res.status(200).json({
        success:          true,
        sessionId:        session._id,
        messageId:        null,
        resolvedClientId: clientId,
        answer:           friendlyMsg,
        outputMode:       'plain',
        tables:           [],
        charts:           [],
        exclusions:       [],
        followupQuestions:[],
        recordCount:      0,
        hasData:          false,
        quotaConsumed:    0,
        tokensIn:         0,
        tokensOut:        0,
      });
    }

    const retrievalResult = await retriever.retrieve(plan, accessContext);

    // ── Response composition (calls DeepSeek) ────────────────────────────────
    const composed = await compose(plan, retrievalResult, accessContext);

    // ── Credit deduction ──────────────────────────────────────────────────────
    const baseCredits  = getBaseCredits(plan.outputMode === 'report' ? 'report_preview' : _creditKey(plan));
    const tokensIn     = composed._aiMeta?.tokensIn  || 0;
    const tokensOut    = composed._aiMeta?.tokensOut || 0;
    const deductResult = await deductQuota(user._id, clientId, {
      sessionId:   session._id,
      actionType:  plan.outputMode === 'report' ? 'report_preview' : _creditKey(plan),
      baseCredits,
      tokensIn,
      tokensOut,
      enabledCheck,
    });

    auditPayload = {
      ...auditPayload,
      normalizedIntent:    resolvedIntent,
      detectedProduct:     plan.product,
      queryPlan:           _safeAuditPlan(plan),
      modulesUsed:         [plan.domain],
      recordsTouchedCount: retrievalResult.recordCount,
      excludedDomains:     composed.exclusions,
      aiRequestMeta:       { model: composed._aiMeta?.model, durationMs: Date.now() - startTime },
      aiResponseMeta:      { tokensIn, tokensOut },
      durationMs:          Date.now() - startTime,
      quotaConsumed:       deductResult.creditsUsed ?? baseCredits,
      status:              'success',
    };
    await writeAuditLog(auditPayload);

    const { assistantMsg } = await saveMessage(session._id, {
      userId:            user._id,
      clientId,
      userQuestion:      question,
      answer:            composed.answer,
      outputMode:        composed.outputMode,
      tables:            composed.tables,
      charts:            composed.charts,
      exclusions:        composed.exclusions,
      followupQuestions: composed.followupQuestions,
      quotaUsed:         deductResult.creditsUsed ?? baseCredits,
      aiMeta:            composed._aiMeta,
      trace:             composed.trace,
    });

    await updateContextState(session._id, {
      lastIntent:    resolvedIntent,
      lastDomain:    plan.domain,
      lastProduct:   plan.product,
      lastDateRange: plan.dateRange || null,
    }).catch(() => {});

    const { _aiMeta, _aiError, ...publicComposed } = composed;
    return res.status(200).json({
      success:       true,
      sessionId:     session._id,
      messageId:     assistantMsg._id,
      resolvedClientId: clientId,   // let frontend know which client was used
      ...publicComposed,
      quotaConsumed:     deductResult.creditsUsed ?? baseCredits,
      quotaUsed:         deductResult.creditsUsed ?? baseCredits,   // alias for frontend quota counter
      creditsRemaining:  deductResult.newBalance ?? null,           // live wallet balance after deduction
      isUnlimited:       enabledCheck.isUnlimited || false,         // true for super_admin / consultant_admin
      tokensIn,
      tokensOut,
    });

  } catch (err) {
    auditPayload.durationMs = Date.now() - startTime;
    auditPayload.status     = 'provider_error';
    await writeAuditLog(auditPayload).catch(() => {});
    console.error('[GreOnIQ] query error:', err.message);
    return res.status(500).json({
      success: false,
      code:    'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
  }
}

/**
 * Find all accessible clients mentioned in a comparison question.
 * Returns an array of { clientId, companyName } — may be empty or have 1 item
 * if the question doesn't name two distinct accessible clients.
 */
async function _resolveComparisonClients(question, user, accessibleClientsCache) {
  const Client = require('../../client-management/client/Client');

  // Extract all tokens that match the clientId pattern ([alpha 2+][digit 2+])
  const tokens = [...new Set((question.match(/\b[A-Za-z]{2,}\d{2,}\b/g) || []))];
  if (tokens.length === 0) return [];

  const results = [];
  const seen    = new Set();

  // ── Step 1: match against pre-fetched accessible clients list ────────────────
  if (Array.isArray(accessibleClientsCache)) {
    for (const token of tokens) {
      const match = accessibleClientsCache.find(
        (c) => c.clientId.toLowerCase() === token.toLowerCase()
      );
      if (match && !seen.has(match.clientId)) {
        results.push({ clientId: match.clientId, companyName: match.companyName || match.clientId });
        seen.add(match.clientId);
      }
    }
  }

  // ── Step 2: super_admin — DB lookup for tokens not yet found ─────────────────
  if (user.userType === 'super_admin') {
    const remaining = tokens.filter((t) => !seen.has(t) && !seen.has(t.toUpperCase()));
    if (remaining.length) {
      const dbDocs = await Client.find(
        { clientId: { $in: remaining }, isDeleted: { $ne: true } },
        { clientId: 1, 'leadInfo.companyName': 1 }
      ).lean().catch(() => []);

      for (const doc of dbDocs) {
        if (!seen.has(doc.clientId)) {
          results.push({ clientId: doc.clientId, companyName: doc.leadInfo?.companyName || doc.clientId });
          seen.add(doc.clientId);
        }
      }
    }
  }

  // ── Step 3: consultant / consultant_admin — validate each via scope resolver ──
  if (user.userType !== 'super_admin') {
    const validated = [];
    for (const c of results) {
      const v = await resolveClientScope(user, c.clientId);
      if (!v.error && !v.needsClientResolution) {
        validated.push(c);
      }
    }
    return validated;
  }

  return results;
}

function _creditKey(plan) {
  if (plan.supportsCharts && plan.supportsTables) return 'qa_chart_table';
  if (plan.supportsTables)                        return 'qa_table';
  if (plan.crossModule)                           return 'cross_module';
  return 'simple_qa';
}

function _safeAuditPlan(plan) {
  return {
    intent:     plan.intent,
    product:    plan.product,
    domain:     plan.domain,
    outputMode: plan.outputMode,
    dateRange:  plan.dateRange ? { label: plan.dateRange.label } : null,
    filtersApplied: {
      hasNodeFilter:    !!(plan.filters?.nodeIds?.length),
      hasScopeFilter:   !!(plan.filters?.scopeIdentifiers?.length),
      hasProjectFilter: !!(plan.filters?.reductionProjectIds?.length),
    },
  };
}

module.exports = { query };
