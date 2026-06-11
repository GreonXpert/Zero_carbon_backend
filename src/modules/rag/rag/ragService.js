'use strict';

const { embedText }        = require('./embedder');
const { searchSimilar, formatChunks } = require('./vectorSearch');
const { buildSectionPrompt, buildQueryText } = require('./promptBuilder');
const { generateSection }  = require('./deepseekClient');
const { validateOutput, parseRawOutput } = require('./outputValidator');

/**
 * Resolve all binding fields (non-text fields with 'binding' or 'dataBinding' property)
 * and table bindings from orgData into the fields map.
 * Called for EVERY section result — both pure-data and AI-generated sections.
 *
 * orgData uses flat dot-notation keys e.g. { "org.name": "Acme", "emissions.total": 12345 }
 */
function mergeBindingData(sectionResult, section, orgData) {
  const fields = { ...(sectionResult.fields || {}) };

  // Merge non-generated fields that have a binding property
  for (const field of section.fields || []) {
    const bindingKey = field.binding || field.dataBinding; // support both key names
    if (bindingKey && field.type !== 'generated_text') {
      const val = orgData[bindingKey];
      // Override even if AI put something there — binding data is authoritative
      if (val !== undefined && val !== null) {
        fields[field.id] = val;
      } else if (fields[field.id] === undefined && field.fallback !== undefined) {
        fields[field.id] = field.fallback;
      }
    }
  }

  // Add table data from bindings — tables are NEVER AI-generated, always from platform data
  for (const table of section.tables || []) {
    if (table.binding) {
      const tableData = orgData[table.binding];
      fields[table.id] = Array.isArray(tableData) ? tableData : [];
    }
  }

  return { ...sectionResult, fields };
}

function bindDataSection(section, orgData) {
  const base = {
    sectionId:  section.id,
    fields:     {},
    confidence: 1.0,
    warnings:   []
  };
  // mergeBindingData handles both fields and tables
  return mergeBindingData(base, section, orgData);
}

async function generateReport(template, orgData, reportId) {
  const sections = [...(template.sections || [])].sort((a, b) => a.order - b.order);
  const results  = {};

  // ── Diagnostic: log all resolved org data ──────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`[RAG pipeline] Starting report generation for: ${reportId}`);
  console.log(`[RAG pipeline] Total sections: ${sections.length}`);
  console.log('[RAG pipeline] Resolved orgData keys:');
  for (const [key, val] of Object.entries(orgData)) {
    if (Array.isArray(val)) {
      console.log(`  ${key.padEnd(36)} = [Array, ${val.length} items]`, val.length ? val[0] : '');
    } else {
      console.log(`  ${key.padEnd(36)} = ${JSON.stringify(val)}`);
    }
  }
  console.log('══════════════════════════════════════════════════════\n');

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    console.log(`\n[RAG section ${i+1}/${sections.length}] id="${section.id}" type="${section.type}" hasPrompt=${!!section.generationPrompt}`);

    // Pure data sections — no LLM call
    if (!section.generationPrompt && !['narrative', 'combined'].includes(section.type)) {
      results[section.id] = bindDataSection(section, orgData);
      console.log(`[RAG section] Data-only result fields: ${Object.keys(results[section.id].fields).join(', ') || '(empty)'}`);
      emitSectionDone(reportId, section.id, i, sections.length);
      continue;
    }

    // Retrieve RAG context if enabled
    let retrievedContext = '';
    if (section.ragContext?.enabled) {
      try {
        const queryText   = buildQueryText(section, orgData);
        const queryVector = await embedText(queryText);
        const chunks      = await searchSimilar(queryVector, {
          filterStandards: section.ragContext.filterStandards || [],
          reportType:      template.meta?.type || '',
          topK:            section.ragContext.topK || 5
        });
        retrievedContext = formatChunks(chunks);
        console.log(`[RAG section] RAG context: ${chunks.length} chunks retrieved`);
      } catch (err) {
        console.warn(`[RAG section] Vector search failed (non-fatal): ${err.message}`);
      }
    }

    // Build prompt
    const { system, user } = buildSectionPrompt(section, orgData, retrievedContext, template.meta);
    console.log(`[RAG section] Prompt built. User prompt length: ${user.length} chars`);
    // Log first 500 chars — should now show real emission numbers in DATA section
    console.log(`[RAG section] Prompt preview:\n  ${user.substring(0, 500).replace(/\n/g, '\n  ')}`);

    // Call LLM
    let parsed;
    let validation;

    try {
      console.log(`[RAG section] Calling DeepSeek...`);
      const raw = await generateSection(system, user, {
        temperature:          template.ragConfig?.temperature ?? 0.2,
        maxTokensPerSection:  template.ragConfig?.maxTokensPerSection ?? 1000
      });

      console.log(`[RAG section] DeepSeek raw response type: ${typeof raw}`);
      console.log(`[RAG section] DeepSeek raw (first 500 chars): ${JSON.stringify(raw).substring(0, 500)}`);

      parsed     = parseRawOutput(raw);
      console.log(`[RAG section] Parsed fields: ${Object.keys(parsed?.fields || {}).join(', ') || '(empty)'}`);
      validation = validateOutput(parsed, section);
      console.log(`[RAG section] Validation: valid=${validation.valid} errors=${JSON.stringify(validation.errors || [])}`);

      if (!validation.valid) {
        console.log(`[RAG section] Retrying section after validation failure...`);
        const retryUser = user + `\n\n## VALIDATION ERRORS FROM PREVIOUS ATTEMPT\nFix these issues:\n${validation.errors.join('\n')}`;
        const retryRaw  = await generateSection(system, retryUser, {
          temperature:         template.ragConfig?.temperature ?? 0.2,
          maxTokensPerSection: template.ragConfig?.maxTokensPerSection ?? 1000
        });
        parsed     = parseRawOutput(retryRaw);
        validation = validateOutput(parsed, section);
        console.log(`[RAG section] Retry result fields: ${Object.keys(parsed?.fields || {}).join(', ') || '(empty)'}`);
      }
    } catch (err) {
      console.error(`[RAG section] ❌ Generation FAILED for "${section.id}": ${err.message}`);
      console.error(err.stack);
      parsed = {
        sectionId:  section.id,
        fields:     {},
        confidence: 0,
        warnings:   [`Generation failed: ${err.message}`]
      };
    }

    if (!validation || !validation.valid) {
      parsed.confidence = parsed.confidence || 0;
      parsed.warnings   = [...(parsed.warnings || []), 'Output validation failed'];
    }

    // Always merge binding data (numeric fields + table data) on top of AI output.
    // AI only returns generated_text fields; all binding-sourced fields are authoritative
    // from orgData and must be merged in regardless of what the AI returned.
    results[section.id] = mergeBindingData(parsed, section, orgData);

    const finalFields = Object.keys(results[section.id].fields);
    console.log(`[RAG section] ✅ Final fields after merge: ${finalFields.join(', ') || '(EMPTY — CHECK ABOVE)'}`);
    // Log field values preview
    for (const [fk, fv] of Object.entries(results[section.id].fields)) {
      const preview = Array.isArray(fv)
        ? `[Array ${fv.length} items]`
        : typeof fv === 'string'
          ? `"${fv.substring(0, 80)}${fv.length > 80 ? '...' : ''}"`
          : JSON.stringify(fv);
      console.log(`    ${fk.padEnd(30)} = ${preview}`);
    }

    emitSectionDone(reportId, section.id, i, sections.length);
  }

  console.log(`\n[RAG pipeline] ✅ Generation complete. Sections saved: ${Object.keys(results).join(', ')}\n`);
  return results;
}

function emitSectionDone(reportId, sectionId, sectionIndex, totalSections) {
  try {
    if (global.io) {
      // We emit to the report room — the job will scope this to orgId
      global.io.emit(`rag:section:${reportId}`, {
        reportId, sectionId, sectionIndex, totalSections,
        progress: Math.round(((sectionIndex + 1) / totalSections) * 100)
      });
    }
  } catch (err) {
    // Never let socket emit crash generation
  }
}

module.exports = { generateReport };
