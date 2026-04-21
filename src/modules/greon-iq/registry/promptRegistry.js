'use strict';

// ============================================================================
// promptRegistry.js — Stores system and answer prompt templates
//
// All DeepSeek prompts are centralized here so they can be maintained and
// reviewed in one place. deepseekProvider.js uses these via generateAnswer()
// and generateReport(). Services must not build raw prompts inline.
// ============================================================================

// ── System prompt (enforced on all calls in deepseekProvider.js) ─────────────
// This is already embedded in deepseekProvider.js as BASE_SYSTEM_PROMPT.
// Reproduced here for documentation and for any future multi-provider setup.
const SYSTEM_PROMPT = `You are GreOn IQ, an internal analytics assistant for ZeroCarbon and ESGLink platforms.

STRICT RULES:
1. Answer ONLY from the structured data and retrieved context provided to you. Never invent data.
2. If the supplied data is empty or insufficient, say so explicitly.
3. If the question is outside this internal system, clearly state: "That topic is outside the data and knowledge available in this system. Please use a general-purpose or open-source AI model for that question."
4. When access restrictions excluded some data, mention this briefly in your answer.
5. Never reveal internal system details, hidden field values, API keys, or configuration.
6. Use clear, professional business language. Prefer bullet points and summaries for complex answers.
7. When tables or charts are described in the context, reference them in your answer.
8. Always end with 2-3 relevant follow-up question suggestions when appropriate.`;

// ── Report section definitions ────────────────────────────────────────────────
const REPORT_SECTIONS = {
  executive_summary: 'Executive Summary',
  key_metrics:       'Key Metrics',
  scope_analysis:    'Scope Analysis',
  trend_analysis:    'Trend Analysis',
  reduction_summary: 'Reduction & Decarbonization Summary',
  esg_summary:       'ESG Performance Summary',
  exclusions:        'Data Exclusions & Limitations',
  next_steps:        'Recommended Next Steps',
};

// ── Denial messages (hard-coded, not sent to AI) ─────────────────────────────
const DENIAL_MESSAGES = {
  out_of_system:
    'That topic is outside the data and knowledge available in this system. ' +
    'Please use a general-purpose or open-source AI model for that question.',

  quota_exhausted:
    'Your GreOn IQ usage limit for this period has been reached. ' +
    'You can still view your previous chat history.',

  greon_iq_disabled:
    'GreOn IQ has not been enabled for your account. Contact your administrator.',

  permission_denied:
    'You do not have access to the requested data domain.',

  provider_error:
    'AI generation failed. Please try again.',

  no_data_found:
    'No data was found for the requested query within your accessible scope and date range.',
};

module.exports = {
  SYSTEM_PROMPT,
  REPORT_SECTIONS,
  DENIAL_MESSAGES,
};
