'use strict';

// ============================================================================
// responseComposerService.js — Merges retrieval results + DeepSeek narrative
//
// Security invariant: DeepSeek only receives data the retrieval layer returned.
// The retrieval layer has already applied all permission gates.
// ============================================================================

const deepseekProvider         = require('../providers/deepseekProvider');
const { generateSuggestions }  = require('./followupSuggestionService');
const { buildTrace }           = require('../utils/queryTraceBuilder');
const {
  buildScopeBreakdownChart,
  buildEsgStatusChart,
  buildBarChart,
  buildPieChart,
  buildStackedBarChart,
} = require('../utils/chartSpecBuilder');
const { DENIAL_MESSAGES }      = require('../registry/promptRegistry');

/**
 * Compose the final API response from a retrieval result + query plan.
 */
async function compose(plan, retrievalResult, accessContext) {
  const { outputMode, supportsCharts, supportsTables, sections } = plan;
  const { data, exclusions: retrieverExclusions, recordCount } = retrievalResult;

  const allExclusions = [...(retrieverExclusions || [])];

  // ── Handle no-data case — skip DeepSeek entirely ─────────────────────────
  const hasData = recordCount > 0;

  if (!hasData) {
    const noDataMsg = allExclusions.length
      ? allExclusions.join(' ')
      : `No data was found for the requested query. Please check that data has been entered for this client.`;
    return {
      answer:            noDataMsg,
      outputMode:        'plain',
      tables:            [],
      charts:            [],
      exclusions:        allExclusions,
      followupQuestions: generateSuggestions(plan, retrievalResult),
      recordCount:       0,
      hasData:           false,
      trace:             buildTrace(plan),
      _aiMeta:  { tokensIn: 0, tokensOut: 0, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat' },
      _aiError: null,
    };
  }

  // ── Build structured context for DeepSeek ────────────────────────────────
  const structuredData = _sanitizeForLLM(_buildStructuredContext(plan, data, recordCount));

  // ── Call DeepSeek for narrative ───────────────────────────────────────────
  let aiAnswer = '';
  let aiUsage  = null;
  let aiError  = null;

  if (outputMode === 'report') {
    const reportResult = await deepseekProvider.generateReport({
      reportData: structuredData,
      sections,
      accessContext,
    });
    if (reportResult.error) {
      aiError  = reportResult.error;
      aiAnswer = DENIAL_MESSAGES.provider_error;
    } else {
      aiAnswer = reportResult.content;
      aiUsage  = reportResult.usage;
    }
  } else {
    const answerResult = await deepseekProvider.generateAnswer({
      userQuestion:   plan.originalQuestion || '',
      accessContext,
      queryPlan:      plan,
      structuredData,
      outputMode,
      exclusions:     allExclusions,
    });
    if (answerResult.error) {
      aiError  = answerResult.error;
      aiAnswer = DENIAL_MESSAGES.provider_error;
    } else {
      aiAnswer = answerResult.content;
      aiUsage  = answerResult.usage;
    }
  }

  // ── Build tables ──────────────────────────────────────────────────────────
  const tables = supportsTables ? _buildTables(plan, data) : [];

  // ── Build charts — skip when user explicitly said "no graph / text only" ──
  const charts = (supportsCharts && !plan.suppressCharts) ? _buildCharts(plan, data) : [];

  // ── Follow-up suggestions ─────────────────────────────────────────────────
  const followupQuestions = generateSuggestions(plan, retrievalResult);

  // ── Trace ─────────────────────────────────────────────────────────────────
  const trace = buildTrace(plan);

  return {
    answer:          aiAnswer,
    outputMode,
    tables,
    charts,
    exclusions:      allExclusions,
    followupQuestions,
    recordCount,
    hasData,
    trace,
    _aiMeta: {
      tokensIn:  aiUsage?.tokensIn  || 0,
      tokensOut: aiUsage?.tokensOut || 0,
      model:     process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    },
    _aiError: aiError || null,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _formatPeriod(period) {
  if (!period) return '—';
  if (period.label) return period.label;
  if (period.type === 'yearly'  && period.year)  return `Year ${period.year}`;
  if (period.type === 'monthly' && period.year && period.month) {
    const d = new Date(period.year, period.month - 1);
    return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  }
  const from = period.from || period.startDate;
  const to   = period.to   || period.endDate;
  if (from && to) {
    const fStr = new Date(from).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
    const tStr = new Date(to).toLocaleDateString('en-IN',   { month: 'short', year: 'numeric' });
    return `${fStr} – ${tStr}`;
  }
  return '—';
}

function _slimSummary(s) {
  const byScope = s.byScope && !Array.isArray(s.byScope)
    ? Object.fromEntries(
        Object.entries(s.byScope).map(([scope, v]) => [scope, { CO2e: v?.CO2e ?? 0 }])
      )
    : (Array.isArray(s.byScope) ? s.byScope.map((v) => ({ scope: v.scope, CO2e: v.CO2e ?? 0 })) : undefined);

  return {
    period:    _formatPeriod(s.period),
    totalCO2e: s.totalEmissions?.CO2e ?? s.totalEmissions ?? 0,
    unit:      s.metadata?.unit || 'tCO₂e',
    ...(byScope ? { byScope } : {}),
  };
}

function _slimReductionSummary(rs) {
  return {
    totalNetReduction:             rs.totalNetReduction ?? 0,
    entriesCount:                  rs.entriesCount ?? 0,
    totalTargetEmissionReduction:  rs.totalTargetEmissionReduction ?? 0,
    achievementPercentage:         rs.achievementPercentage ?? 0,
    dataCompletenessPercentage:    rs.dataCompletenessPercentage ?? 0,
    byProject: (rs.byProject || []).map((p) => ({
      projectName:       p.projectName || '—',
      category:          p.category    || '—',
      scope:             p.scope       || '—',
      location:          p.location    || '—',
      methodology:       p.methodology || '—',
      totalNetReduction: p.totalNetReduction ?? 0,
      entriesCount:      p.entriesCount ?? 0,
      totalInputValue:   p.totalInputValue ?? null,
    })),
    byScope:               rs.byScope        || {},
    byCategory:            rs.byCategory     || {},
    byMethodology:         rs.byMethodology  || {},
    byLocation:            rs.byLocation     || {},
    ghgMechanismSplit:     rs.ghgMechanismSplit     || {},
    topSources:            (rs.topSources            || []).slice(0, 10),
    periodComparison:      (rs.periodComparison      || []).slice(0, 10),
    categoryPriorities:    (rs.categoryPriorities    || []).slice(0, 10),
    dataCompletenessByProject: (rs.dataCompletenessByProject || []).slice(0, 10),
    m1Summary: rs.m1Summary ? {
      totalInputValue:   rs.m1Summary.totalInputValue   ?? 0,
      totalNetReduction: rs.m1Summary.totalNetReduction ?? 0,
      entriesCount:      rs.m1Summary.entriesCount      ?? 0,
    } : null,
    m2Summary: rs.m2Summary ? {
      totalNetReduction: rs.m2Summary.totalNetReduction ?? 0,
      entriesCount:      rs.m2Summary.entriesCount      ?? 0,
    } : null,
    m3Summary: rs.m3Summary ? {
      totalBE:         rs.m3Summary.totalBE ?? 0,
      totalPE:         rs.m3Summary.totalPE ?? 0,
      totalLE:         rs.m3Summary.totalLE ?? 0,
      totalNetWithoutUncertainty: rs.m3Summary.totalNetWithoutUncertainty ?? 0,
      entriesCount:    rs.m3Summary.entriesCount ?? 0,
    } : null,
    period: rs.period,
    meta:   rs.meta,
  };
}

function _slimUserData(ud) {
  if (!ud) return {};

  const slimClient = (c) => ({
    clientInfo:        c.clientInfo,
    assessmentDetails: c.assessmentDetails,
    userCounts:        c.userCounts,
    // Include up to 5 users per role to keep DeepSeek context small
    usersByRole: Object.fromEntries(
      Object.entries(c.usersByRole || {}).map(([role, users]) => [
        role,
        (users || []).slice(0, 5).map((u) => ({ name: u.name, email: u.email, isActive: u.isActive })),
      ])
    ),
  });

  const base = {
    type:    ud.type,
    summary: ud.summary,
  };

  if (ud.type === 'super_admin_view') {
    return {
      ...base,
      consultantAdmins: (ud.consultantAdmins || []).slice(0, 10).map((u) => ({ name: u.name, email: u.email, companyName: u.companyName, teamName: u.teamName })),
      consultants:      (ud.consultants      || []).slice(0, 15).map((u) => ({ name: u.name, email: u.email, assignedClientsCount: u.assignedClientsCount })),
      clients:          (ud.clients          || []).slice(0, 15).map(slimClient),
    };
  }

  if (ud.type === 'consultant_admin_view') {
    return {
      ...base,
      consultantAdminInfo: ud.consultantAdminInfo,
      consultants: (ud.consultants || []).slice(0, 15).map((u) => ({ name: u.name, email: u.email, isActive: u.isActive, assignedClientsCount: u.assignedClientsCount })),
      clients:     (ud.clients     || []).slice(0, 15).map(slimClient),
    };
  }

  if (ud.type === 'consultant_view') {
    return {
      ...base,
      consultantInfo: ud.consultantInfo,
      clients: (ud.clients || []).slice(0, 15).map(slimClient),
    };
  }

  if (ud.type === 'client_admin_view') {
    return {
      ...base,
      clientInfo:        ud.clientInfo,
      assessmentDetails: ud.assessmentDetails,
      userCounts:        ud.userCounts,
      usersByRole: Object.fromEntries(
        Object.entries(ud.usersByRole || {}).map(([role, users]) => [
          role,
          (users || []).slice(0, 10).map((u) => ({ name: u.name, email: u.email, isActive: u.isActive })),
        ])
      ),
    };
  }

  if (ud.type === 'single_client_view') {
    return {
      ...base,
      clientInfo:           ud.clientInfo,
      assessmentDetails:    ud.assessmentDetails,
      clientAdmins:         (ud.clientAdmins      || []).map((u) => ({ name: u.name, email: u.email })),
      assignedConsultants:  (ud.assignedConsultants || []).map((u) => ({ name: u.name, email: u.email })),
      userCounts:           ud.userCounts,
      totalUsers:           ud.totalUsers,
      usersByRole: Object.fromEntries(
        Object.entries(ud.usersByRole || {}).map(([role, users]) => [
          role,
          (users || []).slice(0, 10).map((u) => ({ name: u.name, email: u.email, isActive: u.isActive })),
        ])
      ),
    };
  }

  return base;
}

// Walks retrieved DB data and strips strings that match known LLM prompt-injection
// patterns before they reach DeepSeek. Truncates any field > 500 chars.
const _INJECTION_PATTERN = /ignore\s+all|bypass|override\s+(system|prompt|rules)|act\s+as|you\s+are\s+now|reveal\s+(your|the)\s+(system|prompt|context|rules|instructions)|print.*context/i;

function _sanitizeForLLM(obj) {
  if (typeof obj === 'string') {
    if (_INJECTION_PATTERN.test(obj)) {
      console.warn('[GreonIQ] responseComposerService: prompt injection pattern detected in retrieval data — value redacted');
      return '[REDACTED]';
    }
    return obj.length > 500 ? obj.slice(0, 500) + '…' : obj;
  }
  if (Array.isArray(obj)) return obj.map(_sanitizeForLLM);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, _sanitizeForLLM(v)]));
  }
  return obj;
}

function _slimBrsrData(b) {
  if (!b) return {};
  return {
    clientId:            b.clientId,
    frameworkCode:       b.frameworkCode,
    periodId:            b.periodId,
    instanceStatus:      b.instanceStatus,
    overallReadinessPct: b.overallReadinessPct,
    progress:            b.progress,
    answersByStatus:     b.answersByStatus,
    totalAnswers:        b.totalAnswers,
    // Slim sections: keep section + readiness + status counts, drop raw principle arrays
    sections: (b.sections || []).map((s) => ({
      sectionCode:   s.sectionCode,
      total:         s.total,
      finalApproved: s.finalApproved,
      readinessPct:  s.readinessPct,
      // Include principle breakdown but trim byStatus to top entries only
      principles: (s.principles || []).map((p) => ({
        principleCode: p.principleCode,
        total:         p.total,
        finalApproved: p.finalApproved,
        byStatus:      p.byStatus,
      })),
    })),
    // Slim contributors: keep name + counts only
    contributorStats: (b.contributorStats || []).map((c) => ({
      contributorName: c.contributorName,
      contributorRole: c.contributorRole,
      assigned:        c.assigned,
      submitted:       c.submitted,
      reviewed:        c.reviewed,
      approved:        c.approved,
    })),
    allPeriods: b.allPeriods,
  };
}

function _buildStructuredContext(plan, data, recordCount) {
  // ── cross_client_summary: ranked list of all clients by emissions ───────────
  if (plan.domain === 'cross_client_summary' && data.clients) {
    return {
      domain:     plan.domain,
      product:    plan.product,
      dateRange:  plan.dateRange ? { label: plan.dateRange.label } : null,
      recordCount,
      data: {
        totalClientsChecked: data.totalClientsChecked,
        rankedClients: data.clients.slice(0, 20).map((c, i) => ({
          rank:       i + 1,
          client:     c.companyName,
          clientId:   c.clientId,
          period:     _formatPeriod(c.period),
          totalCO2e:  c.totalCO2e,
          unit:       'tCO₂e',
        })),
      },
    };
  }

  // ── client_comparison: slim each client's latest summary ────────────────────
  if (plan.domain === 'client_comparison' && data.clients) {
    const clientSummaries = {};
    const clientIds = data.clientIds || Object.keys(data.clients);
    for (const id of clientIds) {
      const c = data.clients[id];
      const s = c?.summaries?.[0];
      clientSummaries[c?.companyName || id] = {
        clientId:        id,
        latestPeriod:    s ? _formatPeriod(s.period) : 'no data',
        totalCO2e:       s ? (s.totalEmissions?.CO2e ?? s.totalEmissions ?? 0) : 0,
        unit:            'tCO₂e',
        byScope: s?.byScope
          ? Object.fromEntries(
              Object.entries(s.byScope).map(([scope, v]) => [
                `Scope ${scope}`,
                { CO2e: v?.CO2e ?? v ?? 0 },
              ])
            )
          : null,
      };
    }
    return {
      domain:      plan.domain,
      product:     plan.product,
      dateRange:   plan.dateRange ? { label: plan.dateRange.label } : null,
      recordCount,
      data:        { clientComparison: clientSummaries },
    };
  }

  let simplified = data.summaries?.length
    ? { ...data, summaries: data.summaries.map(_slimSummary) }
    : data;

  if (data.reductionSummary) {
    simplified = { ...simplified, reductionSummary: _slimReductionSummary(data.reductionSummary) };
  }

  if (data.userData) {
    simplified = { ...simplified, userData: _slimUserData(data.userData) };
  }

  if (data.brsrData) {
    simplified = { ...simplified, brsrData: _slimBrsrData(data.brsrData) };
  }

  return {
    domain:     plan.domain,
    product:    plan.product,
    dateRange:  plan.dateRange ? { label: plan.dateRange.label } : null,
    recordCount,
    data:       simplified,
  };
}

function _col(key, label) { return { key, label }; }

// ── Table builders ────────────────────────────────────────────────────────────

function _buildTables(plan, data) {
  const tables = [];
  const domain = plan.domain;

  // ── Cross-client ranking table ────────────────────────────────────────────
  if (domain === 'cross_client_summary' && data.clients?.length) {
    tables.push({
      title:   'Client Emission Rankings',
      columns: [
        _col('rank',      'Rank'),
        _col('client',    'Client'),
        _col('period',    'Latest Period'),
        _col('totalCO2e', 'Total CO₂e (tCO₂e)'),
      ],
      rows: data.clients.map((c, i) => ({
        rank:      `#${i + 1}`,
        client:    c.companyName,
        period:    _formatPeriod(c.period),
        totalCO2e: c.totalCO2e,
      })),
      totalRows:  data.clients.length,
      exportable: true,
    });
    return tables;
  }

  // ── Client comparison table ───────────────────────────────────────────────
  if (domain === 'client_comparison' && data.clients) {
    const clientIds = data.clientIds || Object.keys(data.clients);
    const rows = clientIds.map((id) => {
      const c = data.clients[id];
      const s = c?.summaries?.[0];
      const byScopeRaw = s?.byScope || {};
      const getScope = (key) => {
        const v = byScopeRaw[key] ?? byScopeRaw[`Scope ${key}`];
        return v !== undefined ? (v?.CO2e ?? v) : '—';
      };
      return {
        client:    c?.companyName || id,
        period:    s ? _formatPeriod(s.period) : '—',
        totalCO2e: s ? (s.totalEmissions?.CO2e ?? s.totalEmissions ?? '—') : '—',
        scope1:    getScope('1'),
        scope2:    getScope('2'),
        scope3:    getScope('3'),
      };
    });
    tables.push({
      title:    'Client Emissions Comparison',
      columns:  [
        _col('client',    'Client'),
        _col('period',    'Period'),
        _col('totalCO2e', 'Total CO₂e (tCO₂e)'),
        _col('scope1',    'Scope 1'),
        _col('scope2',    'Scope 2'),
        _col('scope3',    'Scope 3'),
      ],
      rows,
      totalRows:  rows.length,
      exportable: true,
    });
    return tables;
  }

  // ── ZeroCarbon: Emission summaries ────────────────────────────────────────
  if (data.summaries?.length) {
    tables.push({
      title:    'Emission Summaries',
      columns:  [_col('period', 'Period'), _col('totalEmissions', 'Total CO₂e (tCO₂e)'), _col('unit', 'Unit')],
      rows:     data.summaries.map((s) => ({
        period:         _formatPeriod(s.period),
        totalEmissions: s.totalEmissions?.CO2e ?? s.totalEmissions ?? '—',
        unit:           s.metadata?.unit || 'tCO₂e',
      })),
      totalRows:  data.summaries.length,
      exportable: true,
    });
  }

  // ── ZeroCarbon: Data entries (non-ESG) ────────────────────────────────────
  if (data.dataEntries?.records?.length && !domain?.startsWith('esg')) {
    const records = data.dataEntries.records;
    tables.push({
      title:    'Data Entries',
      columns:  [_col('node', 'Node'), _col('scope', 'Scope'), _col('type', 'Type'), _col('status', 'Status'), _col('date', 'Date')],
      rows:     records.map((r) => ({
        node:   r.nodeId   || '—',
        scope:  r.scopeIdentifier || '—',
        type:   r.inputType       || '—',
        status: r.status          || '—',
        date:   r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-IN') : '—',
      })),
      totalRows:  data.dataEntries.totalCount,
      exportable: true,
    });
  }

  // ── User data: single specific client full detail ─────────────────────────
  if (data.userData?.type === 'single_client_view') {
    const ud = data.userData;

    // Client overview card
    const ci = ud.clientInfo || {};
    const ad = ud.assessmentDetails || {};
    tables.push({
      title:   `Client Overview — ${ci.companyName || ci.clientId}`,
      columns: [_col('field', 'Field'), _col('value', 'Value')],
      rows: [
        { field: 'Client ID',            value: ci.clientId      || '—' },
        { field: 'Company Name',         value: ci.companyName   || '—' },
        { field: 'Contact Person',       value: ci.contactPerson || '—' },
        { field: 'Contact Email',        value: ci.contactEmail  || '—' },
        { field: 'Industry',             value: ci.industrySector || '—' },
        { field: 'Company Address',      value: ci.companyAddress || '—' },
        { field: 'Assessment Level',     value: (ad.assessmentLevel || []).join(', ') || '—' },
        { field: 'ESG Assessment Level', value: ad.esgAssessmentLevel?.module || '—' },
        { field: 'ESG Frameworks',       value: (ad.esgAssessmentLevel?.frameworks || []).join(', ') || '—' },
        { field: 'Accessible Modules',   value: (ad.accessibleModules || []).join(', ') || '—' },
        { field: 'Total Users',          value: ud.totalUsers ?? 0 },
      ],
      totalRows: 11,
      exportable: true,
    });

    // User counts by role
    if (ud.userCounts) {
      const roleLabels = {
        client_employee_head: 'Employee Heads',
        employee:             'Employees',
        contributor:          'Contributors',
        reviewer:             'Reviewers',
        approver:             'Approvers',
        auditor:              'Auditors',
        viewer:               'Viewers',
      };
      tables.push({
        title:   'User Count by Role',
        columns: [_col('role', 'Role'), _col('count', 'Count')],
        rows: Object.entries(ud.userCounts).map(([role, count]) => ({
          role:  roleLabels[role] || role,
          count,
        })),
        totalRows:  Object.keys(ud.userCounts).length,
        exportable: true,
      });
    }

    // Client admins
    if (ud.clientAdmins?.length) {
      tables.push({
        title:   'Client Admin(s)',
        columns: [_col('name', 'Name'), _col('email', 'Email'), _col('isActive', 'Active')],
        rows: ud.clientAdmins.map((u) => ({ name: u.name, email: u.email, isActive: u.isActive ? 'Yes' : 'No' })),
        totalRows:  ud.clientAdmins.length,
        exportable: true,
      });
    }

    // Consultant admin
    if (ud.consultantAdminInfo) {
      tables.push({
        title:   'Consultant Admin',
        columns: [_col('field', 'Field'), _col('value', 'Value')],
        rows: [
          { field: 'Name',        value: ud.consultantAdminInfo.name        || '—' },
          { field: 'Email',       value: ud.consultantAdminInfo.email       || '—' },
          { field: 'Company',     value: ud.consultantAdminInfo.companyName || '—' },
          { field: 'Team',        value: ud.consultantAdminInfo.teamName    || '—' },
        ],
        totalRows: 4, exportable: true,
      });
    }

    // Assigned consultants
    if (ud.assignedConsultants?.length) {
      tables.push({
        title:   'Assigned Consultants',
        columns: [_col('name', 'Name'), _col('email', 'Email')],
        rows: ud.assignedConsultants.map((c) => ({ name: c.name, email: c.email })),
        totalRows:  ud.assignedConsultants.length,
        exportable: true,
      });
    }

    // Users by role
    const allUsers = Object.entries(ud.usersByRole || {})
      .flatMap(([role, users]) => (users || []).map((u) => ({ ...u, role })));
    if (allUsers.length) {
      tables.push({
        title:   'All Users',
        columns: [_col('name', 'Name'), _col('email', 'Email'), _col('role', 'Role'), _col('isActive', 'Active')],
        rows: allUsers.map((u) => ({ name: u.name, email: u.email, role: u.role, isActive: u.isActive ? 'Yes' : 'No' })),
        totalRows:  allUsers.length,
        exportable: true,
      });
    }
  }

  // ── User data: client list ────────────────────────────────────────────────
  if (data.userData?.clients?.length) {
    tables.push({
      title:   'Clients',
      columns: [
        _col('companyName',      'Company'),
        _col('assessmentLevel',  'Assessment Level'),
        _col('modules',          'Accessible Modules'),
        _col('totalUsers',       'Total Users'),
        _col('employee_head',    'Emp. Head'),
        _col('employee',         'Employees'),
        _col('contributor',      'Contributors'),
        _col('reviewer',         'Reviewers'),
        _col('approver',         'Approvers'),
        _col('auditor',          'Auditors'),
        _col('viewer',           'Viewers'),
      ],
      rows: data.userData.clients.map((c) => ({
        companyName:     c.clientInfo?.companyName || c.clientInfo?.clientId || '—',
        assessmentLevel: (c.assessmentDetails?.assessmentLevel || []).join(', ') || '—',
        modules:         (c.assessmentDetails?.accessibleModules || []).join(', ') || '—',
        totalUsers:      Object.values(c.userCounts || {}).reduce((s, n) => s + n, 0),
        employee_head:   c.userCounts?.client_employee_head ?? 0,
        employee:        c.userCounts?.employee             ?? 0,
        contributor:     c.userCounts?.contributor          ?? 0,
        reviewer:        c.userCounts?.reviewer             ?? 0,
        approver:        c.userCounts?.approver             ?? 0,
        auditor:         c.userCounts?.auditor              ?? 0,
        viewer:          c.userCounts?.viewer               ?? 0,
      })),
      totalRows:  data.userData.clients.length,
      exportable: true,
    });
  }

  // ── User data: consultant list ────────────────────────────────────────────
  if (data.userData?.consultants?.length) {
    tables.push({
      title:   'Consultants',
      columns: [
        _col('name',                 'Name'),
        _col('email',                'Email'),
        _col('isActive',             'Active'),
        _col('assignedClientsCount', 'Assigned Clients'),
        _col('createdAt',            'Created'),
      ],
      rows: data.userData.consultants.map((c) => ({
        name:                 c.name    || '—',
        email:                c.email   || '—',
        isActive:             c.isActive ? 'Yes' : 'No',
        assignedClientsCount: c.assignedClientsCount ?? '—',
        createdAt:            c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-IN') : '—',
      })),
      totalRows:  data.userData.consultants.length,
      exportable: true,
    });
  }

  // ── User data: consultant admins (super_admin view) ────────────────────────
  if (data.userData?.consultantAdmins?.length) {
    tables.push({
      title:   'Consultant Admins',
      columns: [
        _col('name',        'Name'),
        _col('email',       'Email'),
        _col('companyName', 'Company'),
        _col('teamName',    'Team'),
        _col('isActive',    'Active'),
      ],
      rows: data.userData.consultantAdmins.map((c) => ({
        name:        c.name        || '—',
        email:       c.email       || '—',
        companyName: c.companyName || '—',
        teamName:    c.teamName    || '—',
        isActive:    c.isActive ? 'Yes' : 'No',
      })),
      totalRows:  data.userData.consultantAdmins.length,
      exportable: true,
    });
  }

  // ── User data: users by role (client_admin view) ──────────────────────────
  if (data.userData?.usersByRole) {
    const roleLabels = {
      client_employee_head: 'Employee Heads',
      employee:             'Employees',
      contributor:          'Contributors',
      reviewer:             'Reviewers',
      approver:             'Approvers',
      auditor:              'Auditors',
      viewer:               'Viewers',
    };
    const allUsers = Object.entries(data.userData.usersByRole)
      .flatMap(([role, users]) => (users || []).map((u) => ({ ...u, roleLabel: roleLabels[role] || role })));

    if (allUsers.length) {
      tables.push({
        title:   'Users by Role',
        columns: [
          _col('name',      'Name'),
          _col('email',     'Email'),
          _col('roleLabel', 'Role'),
          _col('isActive',  'Active'),
        ],
        rows: allUsers.map((u) => ({
          name:      u.name     || '—',
          email:     u.email    || '—',
          roleLabel: u.roleLabel,
          isActive:  u.isActive ? 'Yes' : 'No',
        })),
        totalRows:  allUsers.length,
        exportable: true,
      });
    }
  }

  // ── ZeroCarbon: Reduction summary — per-project breakdown ────────────────
  if (data.reductionSummary?.byProject?.length) {
    tables.push({
      title:   'Reduction Projects',
      columns: [
        _col('projectName', 'Project'),
        _col('category',    'Category'),
        _col('scope',       'Scope'),
        _col('location',    'Location'),
        _col('methodology', 'Methodology'),
        _col('netReduction','Net Reduction (tCO₂e)'),
        _col('entries',     'Entries'),
      ],
      rows: data.reductionSummary.byProject.map((p) => ({
        projectName: p.projectName || '—',
        category:    p.category    || '—',
        scope:       p.scope       || '—',
        location:    p.location    || '—',
        methodology: p.methodology || '—',
        netReduction: p.totalNetReduction ?? 0,
        entries:     p.entriesCount ?? 0,
      })),
      totalRows:  data.reductionSummary.byProject.length,
      exportable: true,
    });
  }

  // ── ZeroCarbon: Reduction summary — top sources ───────────────────────────
  if (data.reductionSummary?.topSources?.length) {
    tables.push({
      title:   'Top Reduction Sources',
      columns: [
        _col('source',     'Source'),
        _col('type',       'Type'),
        _col('category',   'Category'),
        _col('reduction',  'Emission Reduction (tCO₂e)'),
      ],
      rows: data.reductionSummary.topSources.map((s) => ({
        source:    s.source    || '—',
        type:      s.type      || '—',
        category:  s.category  || '—',
        reduction: s.emissionReduction ?? 0,
      })),
      totalRows:  data.reductionSummary.topSources.length,
      exportable: true,
    });
  }

  // ── ZeroCarbon: Reduction summary — period comparison ────────────────────
  if (data.reductionSummary?.periodComparison?.length) {
    tables.push({
      title:   'Period Comparison',
      columns: [
        _col('project',   'Project'),
        _col('current',   'Current Reduction (tCO₂e)'),
        _col('previous',  'Previous Reduction (tCO₂e)'),
        _col('delta',     'Delta (tCO₂e)'),
        _col('deltaPct',  'Change (%)'),
      ],
      rows: data.reductionSummary.periodComparison.map((p) => ({
        project:  p.project  || '—',
        current:  p.emissionReduction         ?? 0,
        previous: p.previousEmissionReduction ?? 0,
        delta:    p.delta       ?? 0,
        deltaPct: p.deltaPercent != null ? `${p.deltaPercent}%` : '—',
      })),
      totalRows:  data.reductionSummary.periodComparison.length,
      exportable: true,
    });
  }

  // ── ZeroCarbon: Reduction summary — data completeness ────────────────────
  if (data.reductionSummary?.dataCompletenessByProject?.length) {
    tables.push({
      title:   'Data Completeness by Project',
      columns: [
        _col('projectName',  'Project'),
        _col('completeness', 'Completeness (%)'),
      ],
      rows: data.reductionSummary.dataCompletenessByProject.map((p) => ({
        projectName:  p.projectName || '—',
        completeness: p.percentage  ?? 0,
      })),
      totalRows:  data.reductionSummary.dataCompletenessByProject.length,
      exportable: true,
    });
  }

  // ── ZeroCarbon: Reduction summary — category priorities ──────────────────
  if (data.reductionSummary?.categoryPriorities?.filter((c) => c.category !== '—').length) {
    tables.push({
      title:   'Category Priorities',
      columns: [
        _col('category',   'Category'),
        _col('total',      'Total Reduction (tCO₂e)'),
        _col('share',      'Share (%)'),
      ],
      rows: data.reductionSummary.categoryPriorities
        .filter((c) => c.category !== '—')
        .map((c) => ({
          category: c.category || '—',
          total:    c.totalEmissionReduction ?? 0,
          share:    c.sharePercent != null ? `${c.sharePercent}%` : '—',
        })),
      totalRows:  data.reductionSummary.categoryPriorities.length,
      exportable: true,
    });
  }

  // ── ZeroCarbon: M3 targets (decarbonization domain) ──────────────────────
  if (data.targets?.length) {
    tables.push({
      title:    'Net Zero / SBTi Targets',
      columns:  [
        _col('code',       'Target Code'),
        _col('framework',  'Framework'),
        _col('baseYear',   'Base Year'),
        _col('targetYear', 'Target Year'),
        _col('reduction',  'Reduction %'),
        _col('scope',      'Scope'),
        _col('status',     'Status'),
      ],
      rows:     data.targets.map((t) => ({
        code:       t.target_code          || '—',
        framework:  t.framework_name       || t.target_family || '—',
        baseYear:   t.base_year            || '—',
        targetYear: t.target_year          || '—',
        reduction:  t.target_reduction_pct != null ? `${t.target_reduction_pct}%` : '—',
        scope:      Array.isArray(t.scope_boundary) ? t.scope_boundary.join(', ') : (t.scope_boundary || '—'),
        status:     t.lifecycle_status     || t.approval_status || '—',
      })),
      totalRows:  data.targets.length,
      exportable: true,
    });
  }

  // ── ZeroCarbon: Org flowchart nodes ──────────────────────────────────────
  if (domain === 'organization_flowchart' && data.flowchart?.nodes?.length) {
    tables.push({
      title:    'Organisation Nodes',
      columns:  [_col('label', 'Node Name'), _col('type', 'Type'), _col('department', 'Department'), _col('location', 'Location'), _col('entries', 'Data Entries')],
      rows:     data.flowchart.nodes.map((n) => ({
        label:      n.label      || '—',
        type:       n.type       || '—',
        department: n.department || '—',
        location:   n.location   || '—',
        entries:    data.dataEntryCounts?.byNode?.[String(n.id)] ?? 0,
      })),
      totalRows:  data.flowchart.totalNodes,
      exportable: true,
    });
  }

  // ── BRSR: Overall progress summary ───────────────────────────────────────
  if (domain === 'brsr_summary' && data.brsrData) {
    const b = data.brsrData;
    const p = b.progress || {};

    // Progress overview table
    tables.push({
      title:   `BRSR Progress — ${b.clientId} (Period: ${b.periodId})`,
      columns: [_col('metric', 'Metric'), _col('value', 'Value')],
      rows: [
        { metric: 'Period',                    value: b.periodId                    || '—' },
        { metric: 'Instance Status',           value: b.instanceStatus              || '—' },
        { metric: 'Overall Readiness (%)',     value: `${b.overallReadinessPct ?? 0}%` },
        { metric: 'Total Questions',           value: p.totalQuestions              ?? 0  },
        { metric: 'Not Started',               value: p.notStarted                  ?? 0  },
        { metric: 'Answered by Contributor',   value: p.answeredByContributor       ?? 0  },
        { metric: 'Reviewed',                  value: p.reviewed                    ?? 0  },
        { metric: 'Approver Approved',         value: p.approverApproved            ?? 0  },
        { metric: 'Metric-Linked Questions',   value: p.metricLinked                ?? 0  },
        { metric: 'Metric Data Approved',      value: p.metricDataApproved          ?? 0  },
        { metric: 'Consultant Final Done',     value: p.consultantFinalDone ? 'Yes' : 'No' },
      ],
      totalRows:  11,
      exportable: true,
    });

    // Section breakdown table
    if (b.sections?.length) {
      tables.push({
        title:   'BRSR Section Breakdown',
        columns: [
          _col('section',       'Section'),
          _col('total',         'Total Questions'),
          _col('finalApproved', 'Final Approved'),
          _col('readinessPct',  'Readiness (%)'),
        ],
        rows: b.sections.map((s) => ({
          section:       s.sectionCode,
          total:         s.total,
          finalApproved: s.finalApproved,
          readinessPct:  `${s.readinessPct ?? 0}%`,
        })),
        totalRows:  b.sections.length,
        exportable: true,
      });
    }

    // Answer workflow status distribution table
    if (b.answersByStatus && Object.keys(b.answersByStatus).length) {
      tables.push({
        title:   'Answers by Workflow Stage',
        columns: [_col('stage', 'Stage'), _col('count', 'Count')],
        rows: Object.entries(b.answersByStatus).map(([stage, count]) => ({ stage, count })),
        totalRows:  Object.keys(b.answersByStatus).length,
        exportable: true,
      });
    }

    // Per-contributor table
    if (b.contributorStats?.length) {
      tables.push({
        title:   'Contributor Progress',
        columns: [
          _col('contributorName', 'Contributor'),
          _col('contributorRole', 'Role'),
          _col('assigned',        'Assigned'),
          _col('submitted',       'Submitted'),
          _col('reviewed',        'Reviewed'),
          _col('approved',        'Approved'),
        ],
        rows: b.contributorStats.map((c) => ({
          contributorName: c.contributorName,
          contributorRole: c.contributorRole,
          assigned:        c.assigned,
          submitted:       c.submitted,
          reviewed:        c.reviewed,
          approved:        c.approved,
        })),
        totalRows:  b.contributorStats.length,
        exportable: true,
      });
    }
  }

  // ── ESG: Boundary node structure ─────────────────────────────────────────
  if (domain === 'esg_boundary' && data.boundary?.nodes?.length) {
    tables.push({
      title:    'ESG Boundary Nodes',
      columns:  [_col('label', 'Node Name'), _col('type', 'Type'), _col('department', 'Department'), _col('location', 'Location'), _col('metrics', 'Mapped Metrics')],
      rows:     data.boundary.nodes.map((n) => ({
        label:      n.label      || '—',
        type:       n.type       || '—',
        department: n.department || '—',
        location:   n.location   || '—',
        metrics:    n.metricCount ?? 0,
      })),
      totalRows:  data.boundary.totalNodes,
      exportable: true,
    });
  }

  // ── ESG: Metric node mappings ─────────────────────────────────────────────
  if (data.metricMappings?.records?.length) {
    const records = data.metricMappings.records;
    tables.push({
      title:    'Metric-Node Mappings',
      columns:  [_col('node', 'Node'), _col('status', 'Status'), _col('frequency', 'Frequency'), _col('scope', 'Boundary Scope')],
      rows:     records.map((m) => ({
        node:      m.boundaryNodeId  || '—',
        status:    m.mappingStatus   || '—',
        frequency: m.frequency       || '—',
        scope:     m.boundaryScope   || '—',
      })),
      totalRows:  data.metricMappings.totalCount,
      exportable: true,
    });
  }

  // ── ESG: Metric library ────────────────────────────────────────────────────
  if (data.metricLibrary?.records?.length) {
    const records = data.metricLibrary.records;
    tables.push({
      title:    'ESG Metric Library',
      columns:  [_col('code', 'Code'), _col('name', 'Metric Name'), _col('category', 'Category'), _col('type', 'Type'), _col('unit', 'Unit')],
      rows:     records.map((m) => ({
        code:     m.metricCode      || '—',
        name:     m.metricName      || '—',
        category: m.esgCategory     || '—',
        type:     m.metricType      || '—',
        unit:     m.primaryUnit     || '—',
      })),
      totalRows:  data.metricLibrary.totalCount,
      exportable: true,
    });
  }

  // ── ESG: Boundary summaries (pre-computed rollups) ─────────────────────────
  if (data.boundarySummaries?.records?.length) {
    const records = data.boundarySummaries.records;
    tables.push({
      title:    'ESG Boundary Summaries',
      columns:  [
        _col('period',     'Period'),
        _col('totalE',     'Environmental (E)'),
        _col('totalS',     'Social (S)'),
        _col('totalG',     'Governance (G)'),
        _col('entries',    'Total Entries'),
        _col('computed',   'Last Computed'),
      ],
      rows: records.map((s) => {
        const appT   = s.approvedSummary?.totals;
        const draftT = s.draftSummary?.totals;
        const hasApproved = appT && ((appT.E || 0) + (appT.S || 0) + (appT.G || 0)) > 0;
        const totals = hasApproved ? appT : (draftT || {});
        return {
          period:   s.periodKey || String(s.periodYear || '—'),
          totalE:   totals.E ?? '—',
          totalS:   totals.S ?? '—',
          totalG:   totals.G ?? '—',
          entries:  s.totalEntries ?? '—',
          computed: s.lastComputedAt ? new Date(s.lastComputedAt).toLocaleDateString('en-IN') : '—',
        };
      }),
      totalRows:  data.boundarySummaries.totalCount,
      exportable: true,
    });
  }

  // ── ESG: Raw data entries (fallback when pre-computed summary is empty) ────
  if (data.rawEntries?.records?.length) {
    const records = data.rawEntries.records;
    tables.push({
      title:    'ESG Data Entries (Raw)',
      columns:  [_col('node', 'Node'), _col('period', 'Period'), _col('status', 'Status'), _col('value', 'Value'), _col('unit', 'Unit')],
      rows:     records.map((r) => ({
        node:   r.nodeId                              || '—',
        period: r.period?.periodLabel || String(r.period?.year || '—'),
        status: r.workflowStatus                      || '—',
        value:  r.calculatedValue ?? '—',
        unit:   r.unitOfMeasurement                   || '—',
      })),
      totalRows:  data.rawEntries.totalCount,
      exportable: true,
    });
  }

  // ── ESG: Data entries (esg_data_entry domain) ─────────────────────────────
  if (data.dataEntries?.records?.length && domain?.startsWith('esg')) {
    const records = data.dataEntries.records;
    tables.push({
      title:    'ESG Data Entries',
      columns:  [_col('node', 'Node'), _col('period', 'Period'), _col('status', 'Status'), _col('value', 'Value'), _col('unit', 'Unit')],
      rows:     records.map((r) => ({
        node:   r.nodeId                              || '—',
        period: r.period?.periodLabel || String(r.period?.year || '—'),
        status: r.workflowStatus                      || '—',
        value:  r.calculatedValue ?? '—',
        unit:   r.unitOfMeasurement                   || '—',
      })),
      totalRows:  data.dataEntries.totalCount,
      exportable: true,
    });
  }

  return tables;
}

// ── Chart builders ────────────────────────────────────────────────────────────

function _buildCharts(plan, data) {
  const charts = [];
  const domain = plan.domain;

  // ── Cross-client ranking chart ────────────────────────────────────────────
  if (domain === 'cross_client_summary' && data.clients?.length) {
    const topN = data.clients.slice(0, 15);
    charts.push(buildBarChart(
      `Clients Ranked by Total Emissions — Top ${topN.length} (tCO₂e)`,
      topN.map((c) => ({ label: c.companyName, value: c.totalCO2e })),
      { yLabel: 'Total CO₂e (tCO₂e)', unit: 'tCO₂e' }
    ));
    return charts;
  }

  // ── Client comparison charts ─────────────────────────────────────────────
  if (domain === 'client_comparison' && data.clients) {
    const clientIds = data.clientIds || Object.keys(data.clients);

    // Chart 1: Total emissions bar — one bar per client
    const totalPoints = clientIds.map((id) => {
      const c = data.clients[id];
      const s = c?.summaries?.[0];
      return {
        label: c?.companyName || id,
        value: s ? (s.totalEmissions?.CO2e ?? s.totalEmissions ?? 0) : 0,
      };
    });
    if (totalPoints.some((p) => p.value > 0)) {
      charts.push(buildBarChart(
        'Total Emissions Comparison (tCO₂e)',
        totalPoints,
        { yLabel: 'CO₂e (tCO₂e)', unit: 'tCO₂e' }
      ));
    }

    // Chart 2: Scope breakdown stacked bar — scopes as series, clients on x-axis
    const clientsWithScope = clientIds.map((id) => ({
      id,
      companyName: data.clients[id]?.companyName || id,
      byScope: data.clients[id]?.summaries?.[0]?.byScope || null,
    }));
    const hasScope = clientsWithScope.some((c) => c.byScope && Object.keys(c.byScope).length > 0);
    if (hasScope) {
      const allScopeKeys = [...new Set(
        clientsWithScope.flatMap((c) => Object.keys(c.byScope || {}))
      )].sort();
      const categories = clientsWithScope.map((c) => c.companyName);
      const series = allScopeKeys.map((scopeKey) => ({
        seriesName: `Scope ${scopeKey}`,
        values: clientsWithScope.map((c) => {
          const v = c.byScope?.[scopeKey];
          return typeof v === 'object' ? (v?.CO2e ?? 0) : (v ?? 0);
        }),
      }));
      charts.push(buildStackedBarChart(
        'Scope Breakdown by Client (tCO₂e)',
        categories,
        series,
        { yLabel: 'CO₂e (tCO₂e)', unit: 'tCO₂e' }
      ));
    }

    return charts;
  }

  // ── ZeroCarbon: Emission summary scope breakdown + trend ─────────────────
  if (domain === 'emission_summary' && data.summaries?.length) {
    const firstSummary = data.summaries[0];
    const byScopeRaw   = firstSummary?.byScope;
    if (byScopeRaw && typeof byScopeRaw === 'object' && !Array.isArray(byScopeRaw)) {
      const byScopeArray = Object.entries(byScopeRaw).map(([scope, d]) => ({
        scope, CO2e: d?.CO2e || 0, ...d,
      }));
      if (byScopeArray.length) charts.push(buildScopeBreakdownChart(byScopeArray));
    } else if (Array.isArray(byScopeRaw) && byScopeRaw.length) {
      charts.push(buildScopeBreakdownChart(byScopeRaw));
    }
    if (data.summaries.length > 1) {
      const trend = data.summaries.slice().reverse().map((s) => ({
        label: _formatPeriod(s.period),
        value: s.totalEmissions?.CO2e ?? s.totalEmissions ?? 0,
      }));
      charts.push({ type: 'trend', title: 'Emission Trend', data: trend, unit: 'tCO₂e' });
    }
  }

  // ── ZeroCarbon: Reduction summary charts ─────────────────────────────────
  if (domain === 'reduction' && data.reductionSummary) {
    const rs = data.reductionSummary;

    // Per-project net reduction bar
    if (rs.byProject?.length) {
      const hasMeaningfulData = rs.byProject.some((p) => (p.totalNetReduction ?? 0) > 0);
      if (hasMeaningfulData) {
        charts.push(buildBarChart(
          'Net Reduction by Project (tCO₂e)',
          rs.byProject.map((p) => ({ label: p.projectName || '—', value: p.totalNetReduction || 0 })),
          { yLabel: 'tCO₂e', unit: 'tCO₂e' }
        ));
      }
    }

    // By category pie
    const byCat = rs.byCategory || {};
    const catEntries = Object.entries(byCat).filter(([, v]) => (v.totalNetReduction || 0) > 0);
    if (catEntries.length) {
      charts.push(buildPieChart(
        'Reduction by Category (tCO₂e)',
        catEntries.map(([label, v]) => ({ label, value: v.totalNetReduction || 0 })),
        { unit: 'tCO₂e' }
      ));
    }

    // Monthly trend line (only if more than one data point with actual values)
    const monthlyTrend = (rs.trendChart?.monthly || []).filter((m) => (m.emissionReductionValue || 0) > 0);
    if (monthlyTrend.length > 1) {
      charts.push({
        type:  'trend',
        title: 'Monthly Reduction Trend',
        data:  monthlyTrend.map((m) => ({ label: m.periodKey, value: m.emissionReductionValue || 0 })),
        unit:  'tCO₂e',
      });
    }

    // GHG mechanism split (Reduction vs Removal)
    const ghg = rs.ghgMechanismSplit || {};
    if ((ghg.totalReduction || 0) > 0 || (ghg.totalRemoval || 0) > 0) {
      charts.push(buildPieChart('GHG Mechanism Split', [
        { label: 'Reduction', value: ghg.totalReduction || 0 },
        { label: 'Removal',   value: ghg.totalRemoval   || 0 },
      ], { unit: 'tCO₂e' }));
    }

    // By scope bar
    const byScope = rs.byScope || {};
    const scopeEntries = Object.entries(byScope).filter(([, v]) => (v.totalNetReduction || 0) > 0);
    if (scopeEntries.length) {
      charts.push(buildBarChart(
        'Reduction by Scope (tCO₂e)',
        scopeEntries.map(([label, v]) => ({ label, value: v.totalNetReduction || 0 })),
        { yLabel: 'tCO₂e', unit: 'tCO₂e' }
      ));
    }
  }

  // ── ZeroCarbon: Data entry type breakdown ─────────────────────────────────
  if (domain === 'data_entry' && data.dataEntries?.stats?.byInputType) {
    charts.push(buildBarChart('Entries by Input Type',
      Object.entries(data.dataEntries.stats.byInputType).map(([label, value]) => ({ label, value })),
      { yLabel: 'Count' }
    ));
  }

  // ── BRSR: Progress stage breakdown chart ─────────────────────────────────
  if (domain === 'brsr_summary' && data.brsrData?.progress) {
    const p = data.brsrData.progress;
    const total = p.totalQuestions || 0;
    if (total > 0) {
      charts.push(buildBarChart(
        'BRSR Question Progress by Stage',
        [
          { label: 'Not Started',           value: p.notStarted           ?? 0 },
          { label: 'Answered',              value: p.answeredByContributor ?? 0 },
          { label: 'Reviewed',              value: p.reviewed              ?? 0 },
          { label: 'Approver Approved',     value: p.approverApproved      ?? 0 },
        ],
        { yLabel: 'Questions', unit: 'questions' }
      ));
    }

    // Section readiness bar chart
    if (data.brsrData.sections?.length) {
      charts.push(buildBarChart(
        'BRSR Readiness by Section (%)',
        data.brsrData.sections.map((s) => ({ label: s.sectionCode, value: s.readinessPct ?? 0 })),
        { yLabel: 'Readiness (%)', unit: '%' }
      ));
    }
  }

  // ── ESG: Data entry workflow status ───────────────────────────────────────
  // esg_data_entry domain — stats in data.dataEntries.stats
  if (domain === 'esg_data_entry' && data.dataEntries?.stats?.byStatus) {
    charts.push(buildEsgStatusChart(data.dataEntries.stats.byStatus));
  }

  // ── ESG: Summary inline stats (fallback when pre-computed summary empty) ──
  if (domain === 'esg_summary' && data.inlineStats?.byStatus) {
    charts.push(buildEsgStatusChart(data.inlineStats.byStatus));
  }

  // ── ESG: Summary ESG category totals ─────────────────────────────────────
  if (domain === 'esg_summary' && data.boundarySummaries?.records?.length) {
    const latest = data.boundarySummaries.records[0];
    // approvedSummary.totals is always a truthy object {E:0,S:0,G:0} even when empty,
    // so we must check whether any value is non-zero before using it.
    const appT   = latest?.approvedSummary?.totals;
    const draftT = latest?.draftSummary?.totals;
    const hasApproved = appT && ((appT.E || 0) + (appT.S || 0) + (appT.G || 0)) > 0;
    const totals = hasApproved ? appT : draftT;
    if (totals && ((totals.E || 0) + (totals.S || 0) + (totals.G || 0)) > 0) {
      charts.push(buildPieChart('ESG Category Totals', [
        { label: 'Environmental (E)', value: totals.E || 0 },
        { label: 'Social (S)',        value: totals.S || 0 },
        { label: 'Governance (G)',    value: totals.G || 0 },
      ]));
    }
  }

  return charts;
}

module.exports = { compose };
