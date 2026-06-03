/**
 * SHENMAY AI — Brand Learning · Phase 3 Semantic Dedup (v3.5.6)
 *
 * Embedding-based dedup for brand-learning canonical_keys. Replaces the
 * v3.5.3 Szymkiewicz–Simpson token-overlap heuristic for the cases it
 * missed — synonyms, multi-language, transitive paraphrases across cycles
 * (the LIMITATION test in tests/brand-learning.test.js documented the
 * specific failure mode this fixes).
 *
 * Architecture:
 *   - OpenAI text-embedding-3-small (1536 dims, ~$0.02 / 1M tokens).
 *   - Storage in `brand_learning_embeddings` table as JSONB float-arrays
 *     (no pgvector dependency — postgres:16.9-alpine doesn't ship it and
 *     adding it would force an on-prem image upgrade).
 *   - Brute-force cosine similarity in JS — sub-ms for Shenmay's per-tenant
 *     scale (~40-200 keys/bucket). Revisit if any tenant approaches 10k.
 *   - **Worker-level pre-pass** that REWRITES new candidates' display text
 *     to match a semantically-similar existing entry. `promote.js` stays
 *     completely unchanged — its byte-equal canonical_key fast path picks
 *     up the rewrite naturally (canonicalKey(rewritten_text) === existing
 *     entry's stored canonical_key by definition, because the rewrite
 *     copies an EXISTING stored display string).
 *   - **Fallback**: if `embedFn` is null/missing OR returns null on a
 *     specific call, the pre-pass is skipped for that candidate and the
 *     v3.5.3 token-overlap heuristic handles dedup as before. Opt-in is
 *     never blocked by missing embeddings.
 */

'use strict';

const db = require('../../db');
const { canonicalKey } = require('./promote');
const { quickScanForResidualPii } = require('./scrub');

// OpenAI client lazy-loaded inside the embed function so cosineSimilarity
// + the table helpers stay test-friendly without the `openai` SDK
// installed (per `feedback_lazy_load_llm_sdk_in_mixed_modules`).

const EMBED_MODEL = process.env.LLM_BRAND_LEARNING_EMBED_MODEL || 'text-embedding-3-small';

// Cosine *distance* threshold below which two canonical_keys are treated
// as the same concept. distance = 1 - similarity, so 0.30 distance ≈ 0.70
// similarity.
//
// Tuned via live OpenAI canary on 2026-05-16 (see session-notes for v3.5.8).
// Original v3.5.6 value of 0.18 was calibrated against the unit test's mock
// vectors; real `text-embedding-3-small` output is spread more aggressively,
// and 0.18 only caught lexical near-paraphrases ("X plans" ↔ "plans X") not
// the semantic paraphrases v3.5.6 was designed to catch ("Do you offer
// refunds?" ↔ "What's your refund policy?" only scores 0.74 sim / 0.26 dist).
// 0.30 keeps unrelated pairs out (canary saw 0.21 sim between "pricing plans"
// and "What time do you close?" — comfortably above the new threshold's
// 0.70 sim bar) while merging legitimate paraphrases.
const DEFAULT_DISTANCE_THRESHOLD = 0.30;

// Conceptual buckets (mirrors migration 042's CHECK constraint). Brand_soul
// + brand_memory entries for the same concept type share the same bucket
// here — one embedding row covers both.
const EMBEDDING_BUCKETS = [
  'faqs',
  'processes',
  'voice_cues',
  'audience_pain_points',
  'audience_objections',
  'audience_request_types',
];

/**
 * Cosine similarity between two equal-length numeric arrays. Pure JS,
 * no deps. Returns a number in [-1, 1]; 1 = identical direction,
 * 0 = orthogonal. For OpenAI embeddings almost always sits in [0, 1].
 */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i], bv = b[i];
    dot  += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function cosineDistance(a, b) {
  return 1 - cosineSimilarity(a, b);
}

/**
 * Embed a single string via OpenAI. Returns the embedding array or null
 * on any failure (fail-soft — brand-learning never crashes because the
 * embedding service blipped).
 */
async function embed(text, apiKey, opts = {}) {
  if (!apiKey || !text || typeof text !== 'string') return null;
  const model = opts.model || EMBED_MODEL;
  try {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey, timeout: 30000, maxRetries: 1 });
    const resp = await client.embeddings.create({ model, input: text });
    if (!resp || !Array.isArray(resp.data) || !resp.data[0] || !Array.isArray(resp.data[0].embedding)) return null;
    return resp.data[0].embedding;
  } catch (err) {
    console.warn(`[BrandLearning] embed() failed for "${text.slice(0, 60)}": ${err.message}`);
    return null;
  }
}

/** Fetch stored embeddings for tenant + bucket. Returns [] on error. */
async function fetchStoredEmbeddings(tenantId, bucket) {
  if (!tenantId || !bucket || !EMBEDDING_BUCKETS.includes(bucket)) return [];
  try {
    const { rows } = await db.query(
      `SELECT canonical_key, embedding
       FROM brand_learning_embeddings
       WHERE tenant_id = $1 AND bucket = $2`,
      [tenantId, bucket],
    );
    return rows
      .map(r => ({
        canonical_key: r.canonical_key,
        embedding: Array.isArray(r.embedding) ? r.embedding : null,
      }))
      .filter(r => r.embedding !== null);
  } catch (err) {
    console.warn(`[BrandLearning] fetchStoredEmbeddings(${tenantId},${bucket}) failed: ${err.message}`);
    return [];
  }
}

async function upsertEmbedding(tenantId, bucket, canonicalKeyValue, embedding, model) {
  if (!Array.isArray(embedding) || embedding.length === 0) return false;
  try {
    await db.query(
      `INSERT INTO brand_learning_embeddings (tenant_id, bucket, canonical_key, embedding, model)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (tenant_id, bucket, canonical_key)
       DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, created_at = NOW()`,
      [tenantId, bucket, canonicalKeyValue, JSON.stringify(embedding), model || EMBED_MODEL],
    );
    return true;
  } catch (err) {
    console.warn(`[BrandLearning] upsertEmbedding(${bucket},${canonicalKeyValue}) failed: ${err.message}`);
    return false;
  }
}

/**
 * Delete a single embedding row. Called by curate.js's /items/delete route
 * so the embedding table stays in sync with brand_soul / brand_memory.
 */
async function deleteEmbedding(tenantId, bucket, canonicalKeyValue) {
  try {
    await db.query(
      `DELETE FROM brand_learning_embeddings
       WHERE tenant_id = $1 AND bucket = $2 AND canonical_key = $3`,
      [tenantId, bucket, canonicalKeyValue],
    );
    return true;
  } catch (err) {
    console.warn(`[BrandLearning] deleteEmbedding(${bucket},${canonicalKeyValue}) failed: ${err.message}`);
    return false;
  }
}

/**
 * Find the best-matching stored canonical_key for a query embedding.
 * Returns { canonical_key, distance } if best distance ≤ threshold,
 * else null.
 */
function findBestMatch(queryEmbedding, stored, threshold = DEFAULT_DISTANCE_THRESHOLD) {
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) return null;
  if (!Array.isArray(stored) || stored.length === 0) return null;

  let best = null;
  for (const row of stored) {
    if (!Array.isArray(row.embedding) || row.embedding.length !== queryEmbedding.length) continue;
    const d = cosineDistance(queryEmbedding, row.embedding);
    if (best === null || d < best.distance) {
      best = { canonical_key: row.canonical_key, distance: d };
    }
  }

  if (best && best.distance <= threshold) return best;
  return null;
}

/**
 * Build a map of canonical_key → display text for an existing soul-or-
 * memory list. Used by the merge pass to find the text to rewrite to.
 *
 * @param {Array} list           soul.faqs / memory.candidate_faqs / etc.
 * @param {string} textField     'question' / 'name' / 'cue' / 'value'
 */
function buildExistingTextMap(list, textField) {
  const m = new Map();
  if (!Array.isArray(list)) return m;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.canonical_key !== 'string') continue;
    if (typeof entry[textField] !== 'string') continue;
    if (!m.has(entry.canonical_key)) m.set(entry.canonical_key, entry[textField]);
  }
  return m;
}

/**
 * Pure pre-pass for one bucket. No DB calls — caller supplies `stored`
 * and receives a list of `newEmbeddings` to persist. This separation
 * lets tests exercise the merge + rewrite logic without standing up a DB.
 *
 * Walks `candidates` (strings OR objects depending on the bucket).
 * For each candidate:
 *   1. If its canonicalKey() is byte-equal to any existing key → skip
 *      (promote.js's exact-match fast path handles it).
 *   2. Otherwise embed it via embedFn, find best match in `stored`.
 *      If best distance ≤ threshold → rewrite candidate display text in
 *      place to existing entry's text. promote.js then sees byte-equal.
 *   3. Otherwise queue the new embedding for the caller to persist.
 *
 * Mutates `candidates` array in place — strings get replaced by index;
 * objects get their `textField` overwritten.
 *
 * @returns {Promise<{merged, inserted, skipped, errors, newEmbeddings}>}
 */
async function mergeBucketPure({
  candidates, textField, existingTexts, stored,
  embedFn, opts = {},
}) {
  const out = { merged: 0, inserted: 0, skipped: 0, errors: 0, newEmbeddings: [] };
  if (!Array.isArray(candidates) || candidates.length === 0) return out;
  if (typeof embedFn !== 'function') return out;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const text = textField
      ? (c && typeof c === 'object' ? c[textField] : null)
      : (typeof c === 'string' ? c : null);
    if (!text || typeof text !== 'string') { out.skipped++; continue; }

    const key = canonicalKey(text);
    if (!key) { out.skipped++; continue; }

    if (existingTexts.has(key)) { out.skipped++; continue; }

    // Outbound PII gate (defense-in-depth). embedFn is a network egress to a
    // third party (OpenAI). This candidate is the distiller's OUTPUT — the one
    // thing in this pipeline that has NOT yet been through the worker's Layer-3
    // outbound audit (quickScanForResidualPii runs only after promotion). If a
    // residual-PII pattern survived Layers 1-2 into this candidate, withhold it
    // from the embedding call rather than disclosing it. Fail-soft + per
    // candidate: the v3.5.3 token-overlap heuristic in promote.js still dedups
    // it locally, and the worker's Layer-3 scan still blocks it from being
    // stored. (Closes the v3.5.8-sweep finding: embed pre-pass egressed
    // un-re-audited text to OpenAI before the Layer-3 scan.)
    if (quickScanForResidualPii(text).length > 0) { out.skipped++; continue; }

    const queryEmbedding = await embedFn(text);
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) { out.errors++; continue; }

    const best = findBestMatch(queryEmbedding, stored, opts.threshold);
    if (best && existingTexts.has(best.canonical_key)) {
      const existingText = existingTexts.get(best.canonical_key);
      if (textField) {
        c[textField] = existingText;
      } else {
        candidates[i] = existingText;
      }
      out.merged++;
    } else {
      out.newEmbeddings.push({ canonical_key: key, embedding: queryEmbedding });
      out.inserted++;
    }
  }

  return out;
}

/**
 * DB-touching wrapper around `mergeBucketPure`. Fetches stored embeddings
 * for the bucket, runs the pure merge, then persists any new embeddings.
 *
 * @param {object} args   Same shape as mergeBucketPure, plus tenantId + bucket
 * @returns {Promise<{merged, inserted, skipped, errors}>}
 */
async function mergeBucketViaEmbeddings({
  tenantId, bucket, candidates, textField, existingTexts,
  embedFn, opts = {},
}) {
  const out = { merged: 0, inserted: 0, skipped: 0, errors: 0 };
  if (!tenantId || !EMBEDDING_BUCKETS.includes(bucket)) return out;
  if (!Array.isArray(candidates) || candidates.length === 0) return out;
  if (typeof embedFn !== 'function') return out;

  const stored = await fetchStoredEmbeddings(tenantId, bucket);
  const result = await mergeBucketPure({
    candidates, textField, existingTexts, stored, embedFn, opts,
  });

  // Persist new embeddings for future cycles. Best-effort.
  for (const ne of result.newEmbeddings) {
    await upsertEmbedding(tenantId, bucket, ne.canonical_key, ne.embedding, opts.model);
  }

  out.merged   = result.merged;
  out.inserted = result.inserted;
  out.skipped  = result.skipped;
  out.errors   = result.errors;
  return out;
}

/**
 * Top-level entry: pre-pass ALL buckets in a single normalized-candidates
 * object before applyAndPromote runs. Designed to be a no-op when:
 *   - embedFn is null/missing (no OpenAI key resolvable)
 *   - candidates is empty/malformed
 *   - any fetch / embed call errors (best-effort per-bucket, fail-soft)
 *
 * Mutates `candidates` in place (canonical text overwritten where matches
 * are found). Returns aggregate stats for logging.
 */
async function mergeAllCandidates({
  tenantId, candidates, currentSoul, currentMemory,
  embedFn, opts = {},
}) {
  const agg = { merged: 0, inserted: 0, skipped: 0, errors: 0, buckets: {} };
  if (!tenantId || !candidates || typeof embedFn !== 'function') return agg;

  // Bucket descriptors: (embedding-bucket, candidates-array-getter,
  // text-field, soul-list, memory-list, soul-text-field, memory-text-field).
  const descriptors = [
    { bucket: 'faqs',
      list:        candidates.faqs,
      textField:   'question',
      soulList:    currentSoul && currentSoul.faqs,
      soulField:   'question',
      memoryList:  currentMemory && currentMemory.candidate_faqs,
      memoryField: 'question' },
    { bucket: 'processes',
      list:        candidates.processes,
      textField:   'name',
      soulList:    currentSoul && currentSoul.processes,
      soulField:   'name',
      memoryList:  currentMemory && currentMemory.candidate_processes,
      memoryField: 'name' },
    { bucket: 'voice_cues',
      list:        candidates.voice_cues,
      textField:   null,                 // bare strings
      soulList:    currentSoul && currentSoul.voice_cues,
      soulField:   'cue',
      memoryList:  currentMemory && currentMemory.candidate_voice_cues,
      memoryField: 'cue' },
  ];

  if (candidates.audience_cues && typeof candidates.audience_cues === 'object') {
    const audienceCandidate = currentMemory && currentMemory.candidate_audience;
    const audienceSubs = [
      ['audience_pain_points',   'common_pain_points'],
      ['audience_objections',    'common_objections'],
      ['audience_request_types', 'common_request_types'],
    ];
    for (const [embedBucket, profileKey] of audienceSubs) {
      descriptors.push({
        bucket:      embedBucket,
        list:        candidates.audience_cues[profileKey],
        textField:   null,
        // audience_profile stores raw strings — no canonical_key field on
        // each entry, so we can't build a key→text map from there. We
        // limit the existing-text-map to brand_memory.candidate_audience
        // which DOES carry canonical_key.
        soulList:    null,
        soulField:   null,
        memoryList:  audienceCandidate && audienceCandidate[profileKey],
        memoryField: 'value',
      });
    }
  }

  for (const d of descriptors) {
    if (!Array.isArray(d.list)) continue;

    const existing = new Map();
    if (d.soulList && d.soulField) {
      for (const [k, v] of buildExistingTextMap(d.soulList, d.soulField)) existing.set(k, v);
    }
    if (d.memoryList && d.memoryField) {
      for (const [k, v] of buildExistingTextMap(d.memoryList, d.memoryField)) {
        if (!existing.has(k)) existing.set(k, v);  // soul wins on collision
      }
    }

    const r = await mergeBucketViaEmbeddings({
      tenantId,
      bucket: d.bucket,
      candidates: d.list,
      textField: d.textField,
      existingTexts: existing,
      embedFn,
      opts,
    });

    agg.buckets[d.bucket] = r;
    agg.merged   += r.merged;
    agg.inserted += r.inserted;
    agg.skipped  += r.skipped;
    agg.errors   += r.errors;
  }

  return agg;
}

/**
 * Decide if a tenant's resolved API key + provider supports embeddings,
 * and return an embedFn closed over the key. Returns null when the
 * provider isn't embedding-capable (e.g. Anthropic) or the key is missing.
 *
 * Currently OpenAI-only — Anthropic doesn't ship an embedding API. If
 * we add a different provider later (Cohere, etc.) extend the dispatch
 * here.
 */
function resolveEmbedFn({ apiKey, provider }) {
  if (!apiKey) return null;
  const p = String(provider || '').toLowerCase();
  if (p !== 'openai') return null;
  return (text) => embed(text, apiKey);
}

/**
 * Map a curate.js (source, bucket) pair to the embedding-table bucket
 * name. Returns null when the pair has no embedding counterpart (e.g.
 * a source we don't track embeddings for).
 *
 * brand_soul + brand_memory share embedding buckets per concept type:
 *   soul.faqs + memory.candidate_faqs               → 'faqs'
 *   soul.processes + memory.candidate_processes     → 'processes'
 *   soul.voice_cues + memory.candidate_voice_cues   → 'voice_cues'
 *   audience_profile.common_pain_points
 *     OR audience_candidate.common_pain_points      → 'audience_pain_points'
 *   …same for objections + request_types.
 */
function curateTargetToEmbeddingBucket(source, bucket) {
  if (source === 'soul' || source === 'memory') {
    if (bucket === 'faqs' || bucket === 'candidate_faqs') return 'faqs';
    if (bucket === 'processes' || bucket === 'candidate_processes') return 'processes';
    if (bucket === 'voice_cues' || bucket === 'candidate_voice_cues') return 'voice_cues';
    return null;
  }
  if (source === 'audience_profile' || source === 'audience_candidate') {
    if (bucket === 'common_pain_points')   return 'audience_pain_points';
    if (bucket === 'common_objections')    return 'audience_objections';
    if (bucket === 'common_request_types') return 'audience_request_types';
    return null;
  }
  return null;
}

/**
 * Extract the canonical_key from a curated item. Object entries carry it
 * directly; audience_profile entries are raw strings → canonicalize.
 * Returns null if neither shape works.
 */
function canonicalKeyFromCurateItem(source, removedItem) {
  if (removedItem == null) return null;
  if (source === 'audience_profile') {
    if (typeof removedItem !== 'string') return null;
    return canonicalKey(removedItem);
  }
  if (removedItem && typeof removedItem === 'object' && typeof removedItem.canonical_key === 'string') {
    return removedItem.canonical_key;
  }
  return null;
}

module.exports = {
  cosineSimilarity,
  cosineDistance,
  findBestMatch,
  deleteEmbedding,
  buildExistingTextMap,
  mergeBucketPure,
  mergeAllCandidates,
  resolveEmbedFn,
  curateTargetToEmbeddingBucket,
  canonicalKeyFromCurateItem,
  // Constants
  DEFAULT_DISTANCE_THRESHOLD,
  EMBEDDING_BUCKETS,
};
