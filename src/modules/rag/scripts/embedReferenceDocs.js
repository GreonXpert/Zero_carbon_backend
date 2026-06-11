'use strict';

/**
 * One-off admin script to embed reference standard PDFs into MongoDB Atlas.
 * Run: node src/modules/rag/scripts/embedReferenceDocs.js
 *
 * Prerequisites:
 *  - Reference PDFs placed in <project_root>/reference_docs/
 *  - .env loaded with MONGO_URI, EMBEDDING_PROVIDER, etc.
 *  - Atlas Vector Search index created on rag_embeddings collection
 */

require('dotenv').config();
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const mongoose  = require('mongoose');
const pdfParse  = require('pdf-parse');
const { embedText } = require('../rag/embedder');
const RagEmbedding  = require('../models/RagEmbedding');

const REFERENCE_DOCS_DIR = path.join(__dirname, '../../../../reference_docs');
const CHUNK_SIZE_TOKENS   = 512;
const CHUNK_OVERLAP       = 64;
const BATCH_SIZE          = 20;

// Metadata for each reference document
const DOC_METADATA = {
  'ghg_protocol_corporate_standard_v2.pdf': {
    sourceId:    'ghg_protocol_v2',
    sourceTitle: 'GHG Protocol Corporate Standard v2',
    standard:    'ghg_protocol',
    reportType:  ['emission_report', 'brsr', 'gri', 'custom'],
    tags:        ['scope1', 'scope2', 'scope3', 'ghg', 'carbon_accounting']
  },
  'brsr_sebi_guidelines_2023.pdf': {
    sourceId:    'brsr_sebi_2023',
    sourceTitle: 'SEBI BRSR Circular & Guidelines 2023',
    standard:    'brsr',
    reportType:  ['brsr'],
    tags:        ['brsr', 'sebi', 'india', 'esg', 'disclosure']
  },
  'gri_standards_2021.pdf': {
    sourceId:    'gri_2021',
    sourceTitle: 'GRI Standards 2021',
    standard:    'gri',
    reportType:  ['gri', 'esg_summary'],
    tags:        ['gri', 'sustainability', 'disclosure']
  },
  'ipcc_ar6_gwp_factors.pdf': {
    sourceId:    'ipcc_ar6',
    sourceTitle: 'IPCC AR6 GWP Factors',
    standard:    'ghg_protocol',
    reportType:  ['emission_report'],
    tags:        ['gwp', 'ipcc', 'emission_factors']
  }
};

function approximateTokenCount(text) {
  // Rough approximation: 1 token ≈ 4 chars
  return Math.ceil(text.length / 4);
}

function chunkText(text, chunkSizeTokens = CHUNK_SIZE_TOKENS, overlapTokens = CHUNK_OVERLAP) {
  const words     = text.split(/\s+/);
  const chunkWords = chunkSizeTokens * 3;  // ~3 words per token avg
  const overlapW   = overlapTokens * 3;
  const chunks     = [];
  let i = 0;

  while (i < words.length) {
    const chunk = words.slice(i, i + chunkWords).join(' ');
    if (chunk.trim()) chunks.push(chunk.trim());
    i += chunkWords - overlapW;
    if (i <= 0) i = chunkWords;
  }
  return chunks;
}

function chunkId(sourceId, chunkIndex) {
  return crypto.createHash('sha256').update(`${sourceId}::${chunkIndex}`).digest('hex').substring(0, 32);
}

async function processDocument(filePath, meta) {
  console.log(`\n📄 Processing: ${path.basename(filePath)}`);

  const buffer = fs.readFileSync(filePath);
  const parsed = await pdfParse(buffer);
  const text   = parsed.text;

  console.log(`   Extracted ${text.length} chars`);

  const chunks = chunkText(text);
  console.log(`   Split into ${chunks.length} chunks`);

  let upserted = 0;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (chunkText, batchIdx) => {
      const idx  = i + batchIdx;
      const cId  = chunkId(meta.sourceId, idx);

      try {
        const embedding = await embedText(chunkText);
        await RagEmbedding.findOneAndUpdate(
          { chunkId: cId },
          {
            sourceType:     'reference_standard',
            sourceId:       meta.sourceId,
            sourceTitle:    meta.sourceTitle,
            chunkId:        cId,
            chunkIndex:     idx,
            text:           chunkText,
            embedding,
            tags:           meta.tags || [],
            standard:       meta.standard,
            reportType:     meta.reportType || [],
            embeddedAt:     new Date(),
            embeddingModel: process.env.EMBEDDING_PROVIDER === 'openai' ? 'text-embedding-ada-002' : 'nomic-embed-text'
          },
          { upsert: true, new: true }
        );
        upserted++;
      } catch (err) {
        console.error(`   ❌ Failed chunk ${idx}: ${err.message}`);
      }
    }));

    console.log(`   ✅ Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${Math.min(i + BATCH_SIZE, chunks.length)} / ${chunks.length} chunks`);
  }

  console.log(`   ✅ Upserted ${upserted} chunks for ${meta.sourceId}`);
  return upserted;
}

async function main() {
  console.log('🚀 RAG Reference Doc Embedder');
  console.log('================================');

  if (!process.env.MONGO_URI && !process.env.MONGODB_URI) {
    console.error('❌ MONGO_URI or MONGODB_URI not set in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  if (!fs.existsSync(REFERENCE_DOCS_DIR)) {
    console.error(`❌ reference_docs directory not found: ${REFERENCE_DOCS_DIR}`);
    console.log('Create it and add your PDF files, then re-run this script.');
    process.exit(1);
  }

  const files = fs.readdirSync(REFERENCE_DOCS_DIR).filter(f => f.endsWith('.pdf'));
  if (!files.length) {
    console.log('⚠️  No PDF files found in reference_docs/');
    process.exit(0);
  }

  let totalChunks = 0;
  for (const file of files) {
    const meta = DOC_METADATA[file];
    if (!meta) {
      console.warn(`⚠️  No metadata defined for ${file} — skipping. Add entry to DOC_METADATA in this script.`);
      continue;
    }
    const filePath = path.join(REFERENCE_DOCS_DIR, file);
    totalChunks += await processDocument(filePath, meta);
  }

  console.log(`\n🎉 Done! Total chunks upserted: ${totalChunks}`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal error:', err);
  mongoose.disconnect();
  process.exit(1);
});
