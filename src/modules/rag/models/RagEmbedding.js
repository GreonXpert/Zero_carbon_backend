'use strict';

const mongoose = require('mongoose');

const ragEmbeddingSchema = new mongoose.Schema(
  {
    sourceType: {
      type: String,
      enum: ['reference_standard', 'template_guidance', 'historical_report'],
      required: true
    },
    sourceId:    { type: String, required: true },
    sourceTitle: { type: String },

    chunkId:    { type: String, required: true, unique: true },
    chunkIndex: { type: Number, required: true },
    section:    { type: String },

    text:      { type: String, required: true },
    embedding: { type: [Number], required: true },

    // Filter metadata for $vectorSearch pre-filter
    tags:       [String],
    standard:   { type: String },
    reportType: [String],

    createdAt:      { type: Date, default: Date.now },
    embeddedAt:     { type: Date },
    embeddingModel: { type: String }
  },
  { timestamps: false }
);

ragEmbeddingSchema.index({ chunkId: 1 }, { unique: true });
ragEmbeddingSchema.index({ sourceId: 1 });
ragEmbeddingSchema.index({ standard: 1 });
ragEmbeddingSchema.index({ reportType: 1 });

// Atlas Vector Search index must be created manually in the Atlas UI:
// Collection: rag_embeddings
// Index name: rag_embeddings_vector_idx
// {
//   "fields": [
//     { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
//     { "type": "filter", "path": "standard" },
//     { "type": "filter", "path": "reportType" }
//   ]
// }

module.exports = mongoose.model('RagEmbedding', ragEmbeddingSchema, 'rag_embeddings');
