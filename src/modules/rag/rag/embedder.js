'use strict';

const https = require('https');
const http  = require('http');

const PROVIDER   = process.env.EMBEDDING_PROVIDER || 'nomic';
const DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS || '768', 10);
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost';
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434', 10);

async function embedWithNomic(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'nomic-embed-text', prompt: text });
    const url  = new URL(`${OLLAMA_HOST}:${OLLAMA_PORT}/api/embeddings`);
    const lib  = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.embedding) return reject(new Error('No embedding in nomic response'));
            resolve(parsed.embedding);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function embedWithOpenAI(text) {
  const { OpenAI } = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.embeddings.create({
    model: 'text-embedding-ada-002',
    input: text
  });
  return res.data[0].embedding;
}

async function embedText(text) {
  if (!text || !text.trim()) {
    throw new Error('embedText: text must be a non-empty string');
  }
  try {
    if (PROVIDER === 'openai') {
      return await embedWithOpenAI(text);
    }
    return await embedWithNomic(text);
  } catch (err) {
    // Fallback to openai if nomic unavailable and key is set
    if (PROVIDER !== 'openai' && process.env.OPENAI_API_KEY) {
      console.warn('[RAG embedder] nomic failed, falling back to OpenAI ada-002:', err.message);
      return embedWithOpenAI(text);
    }
    throw err;
  }
}

async function embedBatch(texts, batchSize = 50) {
  const results = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await Promise.all(batch.map(embedText));
    results.push(...embeddings);
  }
  return results;
}

module.exports = { embedText, embedBatch, DIMENSIONS };
