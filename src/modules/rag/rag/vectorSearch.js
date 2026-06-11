'use strict';

const RagEmbedding = require('../models/RagEmbedding');

const VECTOR_INDEX  = process.env.RAG_VECTOR_INDEX || 'rag_embeddings_vector_idx';
const DEFAULT_TOP_K = 5;
const MIN_SCORE     = 0.75;

async function searchSimilar(queryVector, options = {}) {
  const {
    filterStandards = [],
    reportType      = [],
    topK            = DEFAULT_TOP_K,
    minScore        = MIN_SCORE
  } = options;

  if (!queryVector || !queryVector.length) return [];

  const numCandidates = topK * 15;
  const limit         = topK * 2;

  const filter = {};
  if (filterStandards && filterStandards.length) filter.standard   = { $in: filterStandards };
  if (reportType      && reportType.length)      filter.reportType = { $in: Array.isArray(reportType) ? reportType : [reportType] };

  const pipeline = [
    {
      $vectorSearch: {
        index:          VECTOR_INDEX,
        path:           'embedding',
        queryVector,
        numCandidates,
        limit,
        ...(Object.keys(filter).length ? { filter } : {})
      }
    },
    {
      $project: {
        _id:    0,
        text:   1,
        standard: 1,
        section:  1,
        sourceTitle: 1,
        tags:   1,
        score:  { $meta: 'vectorSearchScore' }
      }
    }
  ];

  try {
    const results = await RagEmbedding.aggregate(pipeline);
    return results.filter(r => r.score >= minScore).slice(0, topK);
  } catch (err) {
    // If Atlas Vector Search index not yet created, return empty gracefully
    console.warn('[RAG vectorSearch] search failed (index may not exist yet):', err.message);
    return [];
  }
}

function formatChunks(chunks) {
  if (!chunks || !chunks.length) return '';
  return chunks
    .map((c, i) => `[${i + 1}] ${c.sourceTitle || c.standard || 'Reference'} — ${c.section || ''}\n${c.text}`)
    .join('\n\n---\n\n');
}

module.exports = { searchSimilar, formatChunks };
