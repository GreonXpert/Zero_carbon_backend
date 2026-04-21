'use strict';

// ============================================================================
// vectorRetriever.js — Vector/semantic retrieval stub (v1)
//
// This module defines the interface for future vector-store integration.
// In v1 it always returns empty results. Plug in a vector DB provider in v2
// by replacing _queryVectorStore() with a real implementation.
//
// Expected vector store contract:
//   _queryVectorStore(query, clientId, filters, topK)
//   → [{ chunkId, sourceType, sourceId, content, score }]
// ============================================================================

async function retrieve(plan, _accessContext) {
  // Vector retrieval is not yet implemented (v1 stub).
  // No queries are executed. No credits are affected.
  return {
    data: {
      vectorChunks: {
        records:    [],
        totalCount: 0,
      },
    },
    exclusions:  ['Vector-based semantic search is not available in this version.'],
    recordCount: 0,
  };
}

module.exports = { retrieve };
