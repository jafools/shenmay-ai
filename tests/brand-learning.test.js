/**
 * SHENMAY AI — Brand Learning Unit Tests
 *
 * Pure-JS unit tests — no DB, no server, no network. Runs in ~50ms.
 *
 * Coverage:
 *   - scrub.js: regex detectors strip PII before distillation
 *   - scrub.js: replacement count + types reflect what was found
 *   - promote.js: N-1 distinct sessions does NOT promote
 *   - promote.js: N distinct sessions DOES promote
 *   - promote.js: cross-tenant data is impossible (helper purity)
 *   - promote.js: candidates list size is capped
 *   - distill.js: normalizeObservations drops bad shapes safely
 *   - render.js: empty brand_soul renders empty
 *   - render.js: populated brand_soul renders a usable text block
 *   - PII fuzz: 100 synthetic conversations with diverse PII shapes do not
 *     leak through quickScanForResidualPii once scrubbed
 *
 * Run:  node tests/brand-learning.test.js
 */

'use strict';

const {
  scrubMessagesForDistillation,
  quickScanForResidualPii,
} = require('../server/src/services/brandLearning/scrub');

const {
  applyAndPromote,
  canonicalKey,
  findSimilarEntry,
  tokenizeForSimilarity,
  overlapScore,
  FUZZY_THRESHOLD,
} = require('../server/src/services/brandLearning/promote');

const {
  normalizeObservations,
  buildAnchorList,
  buildDistillSystem,
  DISTILL_SYSTEM,
  ANCHOR_HEADER,
  ANCHOR_MAX_PER_BUCKET,
} = require('../server/src/services/brandLearning/distill');

const {
  cosineSimilarity,
  cosineDistance,
  findBestMatch,
  buildExistingTextMap,
  mergeBucketPure,
  resolveEmbedFn,
  curateTargetToEmbeddingBucket,
  canonicalKeyFromCurateItem,
  DEFAULT_DISTANCE_THRESHOLD,
  EMBEDDING_BUCKETS,
} = require('../server/src/services/brandLearning/embeddings');

const {
  renderBrandSoulForPrompt,
} = require('../server/src/services/brandLearning/render');

const {
  deleteItem,
  promoteItem,
  validateTarget,
} = require('../server/src/services/brandLearning/curate');

// ── Async-aware test runner (collect-then-run; matches tests/webhook-ssrf.test.js) ─
//
// `test()` and `section()` REGISTER into an ordered queue instead of running
// inline; a single async loop at the bottom of the file drains the queue and
// `await`s each test body. This is what lets async tests (e.g. the
// mergeBucketPure embedding-dedup suite) actually run their post-`await`
// assertions: a synchronous runner logs ✓ before the promise settles and
// `process.exit` fires before the microtask queue drains, silently skipping them.

let passed = 0;
let failed = 0;
const failures = [];
const queue = [];

function test(name, fn) {
  queue.push({ type: 'test', name, fn });
}

function section(label) {
  queue.push({ type: 'section', label });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}
function assertEqual(a, b, message) {
  if (a !== b) throw new Error(`${message || 'Values differ'}\n      expected: ${JSON.stringify(b)}\n      actual:   ${JSON.stringify(a)}`);
}
function assertNotContains(hay, needle, message) {
  if (String(hay).includes(needle)) throw new Error(`${message || 'Contains forbidden value'}: "${hay}" should NOT include "${needle}"`);
}
function assertContains(hay, needle, message) {
  if (!String(hay).includes(needle)) throw new Error(`${message || 'Does not contain'}: expected "${hay}" to include "${needle}"`);
}

section('\n== Brand Learning Unit Tests ==\n');

// ═══════════════════════════════════════════════════════════════════════════
// 1. scrub.js — PII pre-distillation pass
// ═══════════════════════════════════════════════════════════════════════════

section('Scrub');

test('email is replaced by [EMAIL_n] token', () => {
  const messages = [
    { role: 'customer', content: 'My email is jane@example.com' },
    { role: 'agent',    content: 'Got it!' },
  ];
  const { scrubbedText, replacementCount } = scrubMessagesForDistillation(messages);
  assertNotContains(scrubbedText, 'jane@example.com');
  assertContains(scrubbedText, '[EMAIL_');
  assert(replacementCount >= 1, 'expected at least one replacement');
});

test('phone number is replaced', () => {
  const messages = [{ role: 'customer', content: 'Call me at 555-123-4567' }];
  const { scrubbedText } = scrubMessagesForDistillation(messages);
  assertNotContains(scrubbedText, '555-123-4567');
  assertContains(scrubbedText, '[PHONE_');
});

test('SSN is replaced', () => {
  const messages = [{ role: 'customer', content: 'My SSN is 555-12-3456 if it helps' }];
  const { scrubbedText } = scrubMessagesForDistillation(messages);
  assertNotContains(scrubbedText, '555-12-3456');
  assertContains(scrubbedText, '[SSN_');
});

test('multiple distinct emails get distinct tokens', () => {
  const messages = [
    { role: 'customer', content: 'I am alice@test.com' },
    { role: 'customer', content: 'My friend is bob@test.com' },
  ];
  const { scrubbedText, replacementsByType } = scrubMessagesForDistillation(messages);
  assertNotContains(scrubbedText, 'alice@test.com');
  assertNotContains(scrubbedText, 'bob@test.com');
  assert(replacementsByType.EMAIL >= 2, 'expected EMAIL count >= 2');
});

test('same email used twice yields same token', () => {
  const messages = [
    { role: 'customer', content: 'I am jane@example.com' },
    { role: 'customer', content: 'Yeah that jane@example.com one' },
  ];
  const { scrubbedText, replacementsByType } = scrubMessagesForDistillation(messages);
  assertEqual(replacementsByType.EMAIL, 1, 'same email must dedup to one token');
  // Token should appear at least twice in the text
  const matches = scrubbedText.match(/\[EMAIL_1\]/g) || [];
  assert(matches.length >= 2, 'expected the same token to appear in both messages');
});

test('empty messages array returns empty result', () => {
  const { scrubbedText, replacementCount } = scrubMessagesForDistillation([]);
  assertEqual(scrubbedText, '');
  assertEqual(replacementCount, 0);
});

test('messages with non-string content are skipped silently', () => {
  const messages = [
    { role: 'customer', content: null },
    { role: 'customer', content: 'Hello' },
    { role: 'customer', content: 42 },
  ];
  const { scrubbedText } = scrubMessagesForDistillation(messages);
  assertContains(scrubbedText, 'Hello');
});

test('quickScanForResidualPii returns [] on clean text', () => {
  const findings = quickScanForResidualPii('What is your return policy?');
  assertEqual(findings.length, 0);
});

test('quickScanForResidualPii catches an unscrubbed email', () => {
  const findings = quickScanForResidualPii('My email is sneaky@example.com');
  assert(findings.length > 0, 'expected at least one finding');
  assertContains(findings.join(','), 'EMAIL');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. promote.js — frequency-threshold promotion
// ═══════════════════════════════════════════════════════════════════════════

section('\nPromote');

test('canonicalKey is whitespace and case insensitive', () => {
  assertEqual(canonicalKey('  Do You Ship?'), 'do you ship');
  assertEqual(canonicalKey('Do you ship'), 'do you ship');
  assertEqual(canonicalKey('do  you   ship'), 'do you ship');
});

test('canonicalKey strips punctuation', () => {
  assertEqual(canonicalKey("What's your return policy?!"), 'what s your return policy');
});

test('first observation accumulates in brand_memory but does NOT promote', () => {
  const result = applyAndPromote({
    currentSoul: {},
    currentMemory: {},
    currentAudience: {},
    candidates: {
      faqs: [{ question: 'Do you ship to Canada?', suggested_answer: 'Yes', frequency_signal: '1x' }],
    },
    minSessions: 3,
    thisBatchSessions: 1,
  });
  assertEqual(result.promotedCount, 0);
  assertEqual(result.addedCandidates, 1);
  assert(Array.isArray(result.nextMemory.candidate_faqs), 'candidate_faqs should be an array');
  assertEqual(result.nextMemory.candidate_faqs.length, 1);
  assert(!Array.isArray(result.nextSoul.faqs) || result.nextSoul.faqs.length === 0, 'nothing in soul yet');
});

test('threshold reached promotes candidate to brand_soul', () => {
  // Simulate three nightly cycles seeing the same question
  let soul = {};
  let memory = {};
  let audience = {};

  for (let i = 0; i < 3; i++) {
    const r = applyAndPromote({
      currentSoul: soul,
      currentMemory: memory,
      currentAudience: audience,
      candidates: {
        faqs: [{ question: 'What is your refund window?', suggested_answer: '30 days', frequency_signal: '1x' }],
      },
      minSessions: 3,
      thisBatchSessions: 1,
    });
    soul = r.nextSoul;
    memory = r.nextMemory;
    audience = r.nextAudience;
  }

  assert(Array.isArray(soul.faqs), 'soul.faqs should exist');
  assertEqual(soul.faqs.length, 1, 'should have promoted exactly one FAQ');
  assertEqual(soul.faqs[0].session_count, 3);
  assertContains(soul.faqs[0].question, 'refund window');
  // Candidate is removed from memory once promoted
  assert(
    !Array.isArray(memory.candidate_faqs) || memory.candidate_faqs.length === 0,
    'candidate should be cleared from memory after promotion',
  );
});

test('different N=2 threshold means promotion at second sighting', () => {
  let soul = {};
  let memory = {};
  let audience = {};

  for (let i = 0; i < 2; i++) {
    const r = applyAndPromote({
      currentSoul: soul,
      currentMemory: memory,
      currentAudience: audience,
      candidates: { faqs: [{ question: 'How long is shipping?', suggested_answer: '5-7 days' }] },
      minSessions: 2,
      thisBatchSessions: 1,
    });
    soul = r.nextSoul;
    memory = r.nextMemory;
    audience = r.nextAudience;
  }

  assertEqual((soul.faqs || []).length, 1, 'should promote at N=2');
});

test('processes follow the same threshold rule', () => {
  let soul = {};
  let memory = {};
  let audience = {};

  for (let i = 0; i < 3; i++) {
    const r = applyAndPromote({
      currentSoul: soul,
      currentMemory: memory,
      currentAudience: audience,
      candidates: {
        processes: [{ name: 'Reset password', description: 'Click forgot password, enter email' }],
      },
      minSessions: 3,
      thisBatchSessions: 1,
    });
    soul = r.nextSoul;
    memory = r.nextMemory;
    audience = r.nextAudience;
  }

  assertEqual((soul.processes || []).length, 1);
});

test('audience cues promote into audience_profile after threshold', () => {
  let soul = {};
  let memory = {};
  let audience = {};

  for (let i = 0; i < 3; i++) {
    const r = applyAndPromote({
      currentSoul: soul,
      currentMemory: memory,
      currentAudience: audience,
      candidates: {
        audience_cues: { common_pain_points: ['pricing transparency'] },
      },
      minSessions: 3,
      thisBatchSessions: 1,
    });
    soul = r.nextSoul;
    memory = r.nextMemory;
    audience = r.nextAudience;
  }

  assertEqual((audience.common_pain_points || []).length, 1);
  assertEqual(audience.common_pain_points[0], 'pricing transparency');
});

test('helper does not mutate inputs (purity)', () => {
  const inputSoul = { faqs: [] };
  const inputMemory = {};
  const inputAudience = {};

  applyAndPromote({
    currentSoul: inputSoul,
    currentMemory: inputMemory,
    currentAudience: inputAudience,
    candidates: { faqs: [{ question: 'test', suggested_answer: '' }] },
    minSessions: 3,
    thisBatchSessions: 1,
  });

  // Original inputs untouched
  assertEqual(inputSoul.faqs.length, 0);
  assertEqual(Object.keys(inputMemory).length, 0);
  assertEqual(Object.keys(inputAudience).length, 0);
});

// ── Fuzzy-match helpers (Phase 1.5 — semantic dedup heuristic) ──────────

test('tokenizeForSimilarity strips stopwords and short words', () => {
  const tokens = tokenizeForSimilarity('why is the pricing transparent on your website');
  assert(!tokens.has('why'), 'should drop "why"');
  assert(!tokens.has('is'), 'should drop "is"');
  assert(!tokens.has('the'), 'should drop "the"');
  assert(!tokens.has('on'), 'should drop "on"');
  assert(tokens.has('pricing'), 'should keep content word "pricing"');
  assert(tokens.has('transparent'), 'should keep "transparent"');
  assert(tokens.has('website'), 'should keep "website"');
});

test('tokenizeForSimilarity handles empty / non-string input', () => {
  assertEqual(tokenizeForSimilarity(null).size, 0);
  assertEqual(tokenizeForSimilarity('').size, 0);
  assertEqual(tokenizeForSimilarity(undefined).size, 0);
});

test('overlapScore is symmetric and bounded 0..1', () => {
  const a = new Set(['pricing', 'transparency']);
  const b = new Set(['pricing', 'clarity', 'website']);
  const s1 = overlapScore(a, b);
  const s2 = overlapScore(b, a);
  assertEqual(s1, s2);
  assert(s1 >= 0 && s1 <= 1, `expected 0..1, got ${s1}`);
});

test('overlapScore returns 0 for empty or missing sets', () => {
  assertEqual(overlapScore(new Set(), new Set(['a'])), 0);
  assertEqual(overlapScore(new Set(['a']), new Set()), 0);
  assertEqual(overlapScore(null, new Set(['a'])), 0);
});

test('findSimilarEntry returns null on empty list', () => {
  assertEqual(findSimilarEntry('anything', []), null);
  assertEqual(findSimilarEntry('anything', null), null);
});

test('findSimilarEntry returns exact match (fast path)', () => {
  const entries = [
    { canonical_key: 'how do i place an order', session_count: 1 },
    { canonical_key: 'what are your hours',     session_count: 2 },
  ];
  const hit = findSimilarEntry('what are your hours', entries);
  assert(hit, 'expected a match');
  assertEqual(hit.canonical_key, 'what are your hours');
});

test('findSimilarEntry returns fuzzy match above threshold (paraphrase)', () => {
  // The exact failure case from the v3.5.2 prod canary.
  const entries = [
    { canonical_key: 'why is pricing confusing or unclear' },
  ];
  // New key: same concept, different LLM phrasing.
  const hit = findSimilarEntry('why is your pricing unclear can you make pricing more transparent', entries);
  assert(hit, 'expected a fuzzy match for paraphrased pricing question');
  assertEqual(hit.canonical_key, 'why is pricing confusing or unclear');
});

test('findSimilarEntry does NOT match unrelated keys', () => {
  const entries = [
    { canonical_key: 'how do i place an order' },
  ];
  const hit = findSimilarEntry('what are your business hours', entries);
  assertEqual(hit, null, 'unrelated questions must not merge');
});

test('findSimilarEntry refuses fuzzy when either side has < 2 content tokens', () => {
  // Short side: "do you ship?" → {ship} after stopwords (1 token)
  const entries = [
    { canonical_key: 'do you ship' },  // {ship} — 1 content token
  ];
  // Even an overlapping short key should NOT fuzzy match (only exact).
  const hit = findSimilarEntry('can i ship', entries);
  assertEqual(hit, null, 'short keys must require exact match');
});

test('findSimilarEntry threshold is set defensively (not over-aggressive)', () => {
  // Sanity check on the public threshold const — guards against accidental
  // changes that would over-merge unrelated topics.
  assert(FUZZY_THRESHOLD >= 0.5, `FUZZY_THRESHOLD ${FUZZY_THRESHOLD} would over-merge`);
  assert(FUZZY_THRESHOLD <= 0.8, `FUZZY_THRESHOLD ${FUZZY_THRESHOLD} would under-merge`);
});

// ── Integration with applyAndPromote — paraphrase promotion ───────────

test('paraphrased FAQs across 3 cycles DO promote (canary failure mode fix)', () => {
  // Three cycles, each with a different LLM phrasing of the same concept.
  // Each later phrasing must overlap with the STORED canonical key (cycle 1's
  // wording) — token-overlap match is anchored on the first-seen entry, not
  // transitively across paraphrases. See LIMITATION test below.
  //
  // Pre-fuzzy-match, each cycle would create a parallel candidate row at
  // session_count=1 and nothing promoted. Post-fix, all three funnel into
  // the same memory entry and promote on cycle 3.
  const phrasings = [
    { question: 'Why is your pricing unclear on the site?',         suggested_answer: 'A1' },
    { question: 'The pricing on your site is unclear',              suggested_answer: 'A2' },
    { question: 'Pricing is confusing and unclear on the site',     suggested_answer: 'A3' },
  ];

  let soul = {}, memory = {}, audience = {};
  for (const p of phrasings) {
    const r = applyAndPromote({
      currentSoul: soul,
      currentMemory: memory,
      currentAudience: audience,
      candidates: { faqs: [p] },
      minSessions: 3,
      thisBatchSessions: 1,
    });
    soul = r.nextSoul; memory = r.nextMemory; audience = r.nextAudience;
  }

  assert(Array.isArray(soul.faqs) && soul.faqs.length === 1, `expected 1 promoted FAQ, got ${soul.faqs?.length || 0}`);
  assertEqual(soul.faqs[0].session_count, 3);
  // The promoted entry retains the FIRST cycle's question text (anchor wording).
  assertContains(soul.faqs[0].question.toLowerCase(), 'pricing');
});

test('LIMITATION: fuzzy match is anchored on first-seen, not transitive across cycles', () => {
  // Documents a known limitation of the Phase 1.5 heuristic — fixed in
  // Phase 3 (HNSW semantic dedup). If cycle 2 matches cycle 1, and cycle 3
  // matches cycle 2 but NOT cycle 1's stored key, cycle 3 creates a parallel
  // candidate. This test pins the current behavior so a future fix is a
  // deliberate change, not an accidental regression.
  const phrasings = [
    { question: 'Why is pricing confusing or unclear?',                            suggested_answer: 'A1' },
    { question: 'Why is your pricing unclear, can you make pricing transparent?', suggested_answer: 'A2' },
    { question: 'Is pricing transparent and clearly displayed?',                   suggested_answer: 'A3' },
  ];
  let soul = {}, memory = {}, audience = {};
  for (const p of phrasings) {
    const r = applyAndPromote({
      currentSoul: soul, currentMemory: memory, currentAudience: audience,
      candidates: { faqs: [p] }, minSessions: 3, thisBatchSessions: 1,
    });
    soul = r.nextSoul; memory = r.nextMemory; audience = r.nextAudience;
  }
  // Cycle 3 ("transparent...displayed") doesn't share enough tokens with
  // cycle 1's anchor ("confusing or unclear"), so it stays separate.
  // Nothing promotes; we end with 2 candidate entries.
  assertEqual((soul.faqs || []).length, 0, 'transitive linking is not supported in v1');
  assertEqual(memory.candidate_faqs.length, 2, 'expected 2 anchors (cycle 1+2 merged, cycle 3 separate)');
});

test('multiple paraphrases WITHIN one cycle do NOT double-count session_count', () => {
  // LLM emits 3 paraphrases of the same concept in a single cycle. They
  // should funnel into one candidate at session_count=1, not 3.
  const r = applyAndPromote({
    currentSoul: {},
    currentMemory: {},
    currentAudience: {},
    candidates: {
      faqs: [
        { question: 'Why is pricing unclear on the site?',           suggested_answer: 'A' },
        { question: 'The pricing on your site is unclear',           suggested_answer: 'B' },
        { question: 'Pricing is confusing and unclear on the site',  suggested_answer: 'C' },
      ],
    },
    minSessions: 3,
    thisBatchSessions: 1,
  });

  // All 3 paraphrases share ≥2 content tokens with the first one, so they
  // funnel into a single candidate.
  assertEqual(
    r.nextMemory.candidate_faqs.length, 1,
    `expected exactly 1 candidate after intra-cycle dedup, got ${r.nextMemory.candidate_faqs.length}`,
  );
  // session_count must be 1 (one cycle = one repetition signal), not 3.
  assertEqual(r.nextMemory.candidate_faqs[0].session_count, 1, 'within-cycle dedup must not double-count');
});

test('unrelated FAQs stay separate (no false-positive merge)', () => {
  const r = applyAndPromote({
    currentSoul: {},
    currentMemory: {},
    currentAudience: {},
    candidates: {
      faqs: [
        { question: 'What are your hours of operation?',  suggested_answer: 'Mon-Fri 9-5' },
        { question: 'How do I cancel my subscription?',   suggested_answer: 'Email support' },
        { question: 'Where do you ship internationally?', suggested_answer: 'Worldwide'   },
      ],
    },
    minSessions: 3,
    thisBatchSessions: 1,
  });

  assertEqual(r.nextMemory.candidate_faqs.length, 3, 'three distinct topics must stay separate');
});

test('paraphrase merge works for processes too', () => {
  // Process names that share ≥2 content tokens with the anchor (cycle 1).
  const phrasings = [
    { name: 'Place an order on the website',     description: 'browse, cart, checkout' },
    { name: 'Place an order via the website',    description: 'visit website, add to cart, pay' },
    { name: 'Order placement on the website',    description: 'go to site, build cart, complete purchase' },
  ];
  let soul = {}, memory = {}, audience = {};
  for (const p of phrasings) {
    const r = applyAndPromote({
      currentSoul: soul, currentMemory: memory, currentAudience: audience,
      candidates: { processes: [p] },
      minSessions: 3, thisBatchSessions: 1,
    });
    soul = r.nextSoul; memory = r.nextMemory; audience = r.nextAudience;
  }
  assertEqual((soul.processes || []).length, 1, 'expected 1 promoted process via fuzzy merge');
});

test('candidates above cap get truncated', () => {
  // 220 distinct candidates; cap is 200
  const faqs = [];
  for (let i = 0; i < 220; i++) {
    faqs.push({ question: `Question number ${i}`, suggested_answer: `Answer ${i}` });
  }
  const r = applyAndPromote({
    currentSoul: {},
    currentMemory: {},
    currentAudience: {},
    candidates: { faqs },
    minSessions: 3,
    thisBatchSessions: 1,
  });
  assert(r.nextMemory.candidate_faqs.length <= 200, `expected ≤200, got ${r.nextMemory.candidate_faqs.length}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2.5. curate.js — owner curation helpers (delete/promote individual items)
// ═══════════════════════════════════════════════════════════════════════════

section('\nCurate');

test('validateTarget rejects unknown source', () => {
  let threw = false;
  try { validateTarget('garbage', 'faqs'); } catch { threw = true; }
  assert(threw, 'should throw on unknown source');
});

test('validateTarget rejects unknown bucket for known source', () => {
  let threw = false;
  try { validateTarget('soul', 'common_pain_points'); } catch { threw = true; }
  assert(threw, 'audience buckets are not valid for source=soul');
});

test('deleteItem removes a promoted FAQ from brand_soul.faqs', () => {
  const state = {
    soul: { faqs: [
      { canonical_key: 'do you ship', question: 'Do you ship?', answer: 'Yes' },
      { canonical_key: 'what are your hours', question: 'What are your hours?', answer: 'Mon-Fri' },
    ]},
    memory: {},
    audience: {},
  };
  const r = deleteItem(state, { source: 'soul', bucket: 'faqs', canonical_key: 'do you ship' });
  assert(r.removed, 'should report removed=true');
  assertEqual(state.soul.faqs.length, 1);
  assertEqual(state.soul.faqs[0].canonical_key, 'what are your hours');
});

test('deleteItem on missing canonical_key returns removed=false', () => {
  const state = { soul: { faqs: [{ canonical_key: 'a' }] }, memory: {}, audience: {} };
  const r = deleteItem(state, { source: 'soul', bucket: 'faqs', canonical_key: 'nonexistent' });
  assert(!r.removed);
  assertEqual(state.soul.faqs.length, 1, 'array untouched');
});

test('deleteItem on a memory candidate', () => {
  const state = {
    soul: {},
    memory: { candidate_faqs: [
      { canonical_key: 'a', question: 'A?', session_count: 2 },
      { canonical_key: 'b', question: 'B?', session_count: 1 },
    ]},
    audience: {},
  };
  const r = deleteItem(state, { source: 'memory', bucket: 'candidate_faqs', canonical_key: 'a' });
  assert(r.removed);
  assertEqual(state.memory.candidate_faqs.length, 1);
  assertEqual(state.memory.candidate_faqs[0].canonical_key, 'b');
});

test('deleteItem on raw-string audience_profile matches via canonicalKey()', () => {
  const state = {
    soul: {}, memory: {},
    // audience_profile values are RAW STRINGS, not objects (per migration 040).
    audience: { common_pain_points: ['Pricing transparency on the website', 'Slow shipping'] },
  };
  // canonical_key for "Pricing transparency on the website" → "pricing transparency on the website"
  const r = deleteItem(state, {
    source: 'audience_profile',
    bucket: 'common_pain_points',
    canonical_key: 'pricing transparency on the website',
  });
  assert(r.removed);
  assertEqual(state.audience.common_pain_points.length, 1);
  assertEqual(state.audience.common_pain_points[0], 'Slow shipping');
});

test('deleteItem on audience_profile accepts the RAW user-facing string too', () => {
  // The dashboard renders raw strings; the easiest client call is to pass
  // the raw display string back unchanged. The helper canonicalizes both
  // sides so either form (raw / pre-canonicalized) works.
  const state = {
    soul: {}, memory: {},
    audience: { common_pain_points: ['Pricing transparency on the website', 'Slow shipping'] },
  };
  const r = deleteItem(state, {
    source: 'audience_profile',
    bucket: 'common_pain_points',
    canonical_key: 'Pricing transparency on the website!',   // raw + extra punctuation
  });
  assert(r.removed, 'should match even with raw casing + punctuation');
  assertEqual(state.audience.common_pain_points.length, 1);
});

test('promoteItem moves a candidate FAQ into brand_soul.faqs', () => {
  const state = {
    soul: { faqs: [] },
    memory: { candidate_faqs: [
      { canonical_key: 'do you ship', question: 'Do you ship?', suggested_answer: 'Yes worldwide', session_count: 2, first_seen_at: '2026-05-01T00:00:00Z' },
    ]},
    audience: {},
  };
  const r = promoteItem(state, { source: 'memory', bucket: 'candidate_faqs', canonical_key: 'do you ship' });
  assert(r.promoted, 'should report promoted=true');
  assertEqual(state.memory.candidate_faqs.length, 0, 'candidate removed from memory');
  assertEqual(state.soul.faqs.length, 1, 'one item now in soul');
  assertEqual(state.soul.faqs[0].canonical_key, 'do you ship');
  assertEqual(state.soul.faqs[0].answer, 'Yes worldwide', 'suggested_answer becomes answer on promotion');
  assert(state.soul.faqs[0].manually_promoted, 'manually_promoted flag set');
  assert(state.soul.faqs[0].promoted_at, 'promoted_at stamped');
});

test('promoteItem moves an audience candidate into audience_profile (raw string)', () => {
  const state = {
    soul: {}, audience: { common_pain_points: [] },
    memory: { candidate_audience: { common_pain_points: [
      { canonical_key: 'pricing transparency', value: 'Pricing transparency on the site', session_count: 2 },
    ]}},
  };
  const r = promoteItem(state, {
    source: 'audience_candidate',
    bucket: 'common_pain_points',
    canonical_key: 'pricing transparency',
  });
  assert(r.promoted);
  assertEqual(state.audience.common_pain_points.length, 1);
  assertEqual(state.audience.common_pain_points[0], 'Pricing transparency on the site');
  assertEqual(state.memory.candidate_audience.common_pain_points.length, 0);
});

test('promoteItem on a non-promotable source throws', () => {
  const state = { soul: { faqs: [{ canonical_key: 'a' }] }, memory: {}, audience: {} };
  let threw = false;
  try { promoteItem(state, { source: 'soul', bucket: 'faqs', canonical_key: 'a' }); } catch { threw = true; }
  assert(threw, 'should refuse to promote something already in soul');
});

test('promoteItem on missing canonical_key returns promoted=false', () => {
  const state = { soul: { faqs: [] }, memory: { candidate_faqs: [] }, audience: {} };
  const r = promoteItem(state, { source: 'memory', bucket: 'candidate_faqs', canonical_key: 'nothing-here' });
  assert(!r.promoted);
});

test('promoted process retains description', () => {
  const state = {
    soul: { processes: [] },
    memory: { candidate_processes: [
      { canonical_key: 'place an order', name: 'Place an order', description: 'Visit site, add to cart, check out', session_count: 2 },
    ]},
    audience: {},
  };
  const r = promoteItem(state, { source: 'memory', bucket: 'candidate_processes', canonical_key: 'place an order' });
  assert(r.promoted);
  assertEqual(state.soul.processes[0].description, 'Visit site, add to cart, check out');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. distill.js — normalizeObservations
// ═══════════════════════════════════════════════════════════════════════════

section('\nDistill normalize');

test('normalize drops malformed entries', () => {
  const raw = {
    faqs: [
      { question: 'good one', suggested_answer: 'yes' },
      { question: 42 },                                  // bad — non-string
      { suggested_answer: 'orphan' },                    // bad — no question
      'not an object',                                   // bad — not an object
    ],
    unknown_top_level_key: 'should be ignored',
  };
  const out = normalizeObservations(raw);
  assertEqual(out.faqs.length, 1, 'only the first faq should survive');
  assert(!('unknown_top_level_key' in out), 'unknown keys must be dropped');
});

test('normalize handles null/non-object input', () => {
  assertEqual(JSON.stringify(normalizeObservations(null)), '{}');
  assertEqual(JSON.stringify(normalizeObservations('hi')), '{}');
  assertEqual(JSON.stringify(normalizeObservations(42)), '{}');
});

test('normalize trims oversized strings', () => {
  const big = 'x'.repeat(10_000);
  const out = normalizeObservations({
    faqs: [{ question: big, suggested_answer: big, frequency_signal: big }],
  });
  assert(out.faqs[0].question.length <= 500);
  assert(out.faqs[0].suggested_answer.length <= 1000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3b. distill.js — buildAnchorList + buildDistillSystem (v3.5.5)
// ═══════════════════════════════════════════════════════════════════════════

section('\nDistill anchoring');

test('buildAnchorList returns empty for null/undefined/empty inputs', () => {
  assertEqual(buildAnchorList(null, null), '');
  assertEqual(buildAnchorList(undefined, undefined), '');
  assertEqual(buildAnchorList({}, {}), '');
  assertEqual(buildAnchorList({ faqs: [] }, { candidate_faqs: [] }), '');
  // Non-string entries get filtered out → still no content → empty.
  assertEqual(buildAnchorList({ faqs: [{}, { question: '' }, { question: '   ' }] }, {}), '');
});

test('buildAnchorList renders soul.faqs entries under the right header', () => {
  const out = buildAnchorList(
    { faqs: [{ question: 'What are your business hours?', canonical_key: 'what are your business hours' }] },
    null,
  );
  assertContains(out, 'EXISTING BRAND KNOWLEDGE');
  assertContains(out, 'faqs (questions visitors already asked)');
  assertContains(out, '- What are your business hours?');
});

test('buildAnchorList merges soul + memory entries into one bucket section, deduping by lowercase', () => {
  const out = buildAnchorList(
    { faqs: [{ question: 'Do you ship internationally?' }] },
    { candidate_faqs: [
      { question: 'do you ship internationally?' },    // dupe (case-insensitive)
      { question: 'How long does delivery take?' },
    ] },
  );
  // Dedup: exactly one "Do you ship..." line, in soul casing (first-seen wins).
  const shipLines = out.split('\n').filter(l => l.toLowerCase().includes('ship internationally'));
  assertEqual(shipLines.length, 1, 'soul + memory duplicate should collapse to one entry');
  assertContains(shipLines[0], 'Do you ship internationally?');
  assertContains(out, 'How long does delivery take?');
});

test('buildAnchorList covers all 6 buckets (3 soul + audience candidates)', () => {
  const out = buildAnchorList(
    {
      faqs:       [{ question: 'Q1' }],
      processes:  [{ name: 'P1' }],
      voice_cues: [{ cue: 'V1' }],
    },
    {
      candidate_faqs:       [{ question: 'Q2' }],
      candidate_processes:  [{ name: 'P2' }],
      candidate_voice_cues: [{ cue: 'V2' }],
      candidate_audience: {
        common_pain_points:   [{ value: 'Pain 1' }],
        common_objections:    [{ value: 'Objection 1' }],
        common_request_types: [{ value: 'Request 1' }],
      },
    },
  );
  // All 6 section headers present.
  assertContains(out, 'faqs (questions visitors already asked)');
  assertContains(out, 'processes (workflows the brand already walks visitors through)');
  assertContains(out, 'voice_cues (how visitors prefer to be talked to)');
  assertContains(out, 'audience_cues.common_pain_points');
  assertContains(out, 'audience_cues.common_objections');
  assertContains(out, 'audience_cues.common_request_types');
  // Items from both soul + memory + audience candidates surface.
  ['Q1','Q2','P1','P2','V1','V2','Pain 1','Objection 1','Request 1']
    .forEach(s => assertContains(out, s));
});

test('buildAnchorList caps each bucket at maxPerBucket', () => {
  const many = (n, prefix) => Array.from({ length: n }, (_, i) => ({ question: `${prefix}${i}` }));
  const out = buildAnchorList(
    { faqs: many(50, 'Q') },
    null,
    { maxPerBucket: 5 },
  );
  // Expect exactly 5 Q-lines + 0 mention of Q5..Q49.
  const qLines = out.split('\n').filter(l => /^- Q\d+$/.test(l));
  assertEqual(qLines.length, 5, 'should cap at maxPerBucket=5');
  assertContains(out, '- Q0');
  assertContains(out, '- Q4');
  assertNotContains(out, '- Q5');
  assertNotContains(out, '- Q49');
});

test('buildAnchorList default cap is ANCHOR_MAX_PER_BUCKET=20', () => {
  assertEqual(ANCHOR_MAX_PER_BUCKET, 20, 'sanity check on exported constant');
  const many = Array.from({ length: 30 }, (_, i) => ({ question: `Q${i}` }));
  const out = buildAnchorList({ faqs: many }, null);
  const qLines = out.split('\n').filter(l => /^- Q\d+$/.test(l));
  assertEqual(qLines.length, 20, 'default cap should be 20');
});

test('buildDistillSystem returns DISTILL_SYSTEM unchanged when no anchor', () => {
  assertEqual(buildDistillSystem(null, null), DISTILL_SYSTEM);
  assertEqual(buildDistillSystem({}, {}), DISTILL_SYSTEM);
  assertEqual(buildDistillSystem({ faqs: [] }, { candidate_faqs: [] }), DISTILL_SYSTEM);
});

test('buildDistillSystem appends anchor list when populated', () => {
  const out = buildDistillSystem(
    { faqs: [{ question: 'Anchor me' }] },
    null,
  );
  // Base prompt rules MUST still be present (and at the start).
  assert(out.startsWith(DISTILL_SYSTEM), 'base prompt must remain first — absolute-rules block stays at top');
  // Anchor section appended.
  assertContains(out, ANCHOR_HEADER.trim());
  assertContains(out, '- Anchor me');
});

test('buildAnchorList ignores garbage entries (non-object, missing field, non-string field)', () => {
  const out = buildAnchorList(
    { faqs: [
      'not an object',                  // bad — bare string in objects bucket
      null,                              // bad — null entry
      { name: 'wrong field' },           // bad — wrong field name for faqs
      { question: 42 },                  // bad — non-string question
      { question: 'Good one' },          // good
    ] },
    null,
  );
  assertContains(out, '- Good one');
  // The bad entries must not slip through.
  assertNotContains(out, '- not an object');
  assertNotContains(out, '- null');
  assertNotContains(out, 'wrong field');
  assertNotContains(out, '- 42');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3c. embeddings.js — Phase 3 semantic dedup (v3.5.6)
// ═══════════════════════════════════════════════════════════════════════════

section('\nEmbedding semantic dedup');

// ---- pure math ----------------------------------------------------------

test('cosineSimilarity identical vectors → 1', () => {
  const v = [1, 0, 0];
  assertEqual(cosineSimilarity(v, v), 1);
});

test('cosineSimilarity orthogonal vectors → 0', () => {
  assertEqual(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
});

test('cosineSimilarity opposite vectors → -1', () => {
  assertEqual(cosineSimilarity([1, 0, 0], [-1, 0, 0]), -1);
});

test('cosineSimilarity handles empty / mismatched / non-array input', () => {
  assertEqual(cosineSimilarity([], []), 0);
  assertEqual(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assertEqual(cosineSimilarity(null, [1]), 0);
  assertEqual(cosineSimilarity([0, 0, 0], [1, 0, 0]), 0);
});

test('cosineDistance equals 1 - similarity', () => {
  const a = [1, 0, 0];
  const b = [0.95, 0.31, 0];
  const sim = cosineSimilarity(a, b);
  const dist = cosineDistance(a, b);
  assert(Math.abs(dist - (1 - sim)) < 1e-12);
  assert(dist > 0 && dist < 0.06, 'small angle → small distance');
});

// ---- findBestMatch ------------------------------------------------------

test('findBestMatch returns null for empty/null query or stored', () => {
  assertEqual(findBestMatch([], [{ canonical_key: 'k', embedding: [1, 0] }]), null);
  assertEqual(findBestMatch([1, 0], []), null);
  assertEqual(findBestMatch(null, [{ canonical_key: 'k', embedding: [1, 0] }]), null);
});

test('findBestMatch returns the closest entry when ≤ threshold', () => {
  const stored = [
    { canonical_key: 'far',  embedding: [0, 1, 0] },
    { canonical_key: 'near', embedding: [0.95, 0.31, 0] },
    { canonical_key: 'mid',  embedding: [0.5, 0.5, 0.5] },
  ];
  const best = findBestMatch([1, 0, 0], stored, 0.2);
  assert(best);
  assertEqual(best.canonical_key, 'near');
  assert(best.distance < 0.2);
});

test('findBestMatch returns null when nothing crosses threshold', () => {
  const stored = [{ canonical_key: 'far', embedding: [0, 1, 0] }];
  assertEqual(findBestMatch([1, 0, 0], stored, 0.1), null);
});

test('findBestMatch skips embeddings with wrong dimensions', () => {
  const stored = [
    { canonical_key: 'bad',  embedding: [1, 0] },          // 2-dim
    { canonical_key: 'good', embedding: [1, 0, 0] },       // 3-dim
  ];
  const best = findBestMatch([1, 0, 0], stored, 0.5);
  assertEqual(best && best.canonical_key, 'good');
});

// ---- buildExistingTextMap ----------------------------------------------

test('buildExistingTextMap pulls canonical_key → text from object list', () => {
  const m = buildExistingTextMap(
    [
      { question: 'How tall?', canonical_key: 'how tall' },
      { question: 'What size?', canonical_key: 'what size' },
    ],
    'question',
  );
  assertEqual(m.get('how tall'), 'How tall?');
  assertEqual(m.get('what size'), 'What size?');
  assertEqual(m.size, 2);
});

test('buildExistingTextMap skips malformed entries', () => {
  const m = buildExistingTextMap(
    [
      null,
      'bare string',
      { canonical_key: 'no-question-field' },
      { question: 42, canonical_key: 'non-string-q' },
      { question: 'good', canonical_key: 'good-key' },
    ],
    'question',
  );
  assertEqual(m.size, 1);
  assertEqual(m.get('good-key'), 'good');
});

// ---- mergeBucketPure ----------------------------------------------------

test('mergeBucketPure: byte-equal candidate is skipped without embed call', async () => {
  let embedCalls = 0;
  const embedFn = async () => { embedCalls++; return [1, 0, 0]; };
  const candidates = [{ question: 'how tall?', suggested_answer: 'A' }];
  // existing canonical_key for "how tall?" → "how tall"
  const existingTexts = new Map([['how tall', 'How tall?']]);

  const r = await mergeBucketPure({
    candidates, textField: 'question',
    existingTexts, stored: [], embedFn,
  });
  assertEqual(r.skipped, 1);
  assertEqual(r.merged, 0);
  assertEqual(r.inserted, 0);
  assertEqual(embedCalls, 0, 'must not call embedFn when byte-equal exists');
});

test('mergeBucketPure: semantically-close candidate gets rewritten to existing text', async () => {
  const embedFn = async (text) => {
    if (text === 'Why is pricing unclear?') return [0.95, 0.31, 0];
    if (text === 'Why is pricing confusing?') return [1, 0, 0];
    return [0, 0, 1];
  };
  const candidates = [{ question: 'Why is pricing unclear?', suggested_answer: 'A' }];
  const existingTexts = new Map([['why is pricing confusing', 'Why is pricing confusing?']]);
  const stored = [{ canonical_key: 'why is pricing confusing', embedding: [1, 0, 0] }];

  const r = await mergeBucketPure({
    candidates, textField: 'question',
    existingTexts, stored, embedFn,
  });
  assertEqual(r.merged, 1);
  assertEqual(r.inserted, 0);
  // The candidate's question was REWRITTEN in place to the existing text.
  assertEqual(candidates[0].question, 'Why is pricing confusing?');
});

test('mergeBucketPure: semantically-distant candidate gets queued for insertion', async () => {
  const embedFn = async (text) => {
    if (text === 'Where do you ship?') return [0, 1, 0];
    return [1, 0, 0];
  };
  const candidates = [{ question: 'Where do you ship?', suggested_answer: 'A' }];
  const existingTexts = new Map([['how tall', 'How tall?']]);
  const stored = [{ canonical_key: 'how tall', embedding: [1, 0, 0] }];

  const r = await mergeBucketPure({
    candidates, textField: 'question',
    existingTexts, stored, embedFn,
  });
  assertEqual(r.merged, 0);
  assertEqual(r.inserted, 1);
  assertEqual(r.newEmbeddings.length, 1);
  assertEqual(r.newEmbeddings[0].canonical_key, 'where do you ship');
  // Candidate text NOT rewritten (no match) — preserves the LLM's original wording.
  assertEqual(candidates[0].question, 'Where do you ship?');
});

test('mergeBucketPure: embedFn returning null counts as error, no rewrite, no insert', async () => {
  const embedFn = async () => null;
  const candidates = [{ question: 'Anything', suggested_answer: 'A' }];
  const r = await mergeBucketPure({
    candidates, textField: 'question',
    existingTexts: new Map(),
    stored: [],
    embedFn,
  });
  assertEqual(r.errors, 1);
  assertEqual(r.merged, 0);
  assertEqual(r.inserted, 0);
});

test('mergeBucketPure: candidate with residual PII is withheld from the embed call (outbound PII gate)', async () => {
  let embedCalls = 0;
  const seen = [];
  const embedFn = async (text) => { embedCalls++; seen.push(text); return [0, 1, 0]; };
  const candidates = [
    { question: 'What are your opening hours?' },                // clean → embedded
    { question: 'Please email me at sneaky@example.com today' },  // residual PII → withheld
  ];
  const r = await mergeBucketPure({
    candidates, textField: 'question',
    existingTexts: new Map(), stored: [], embedFn,
  });
  // The PII-bearing candidate must never reach the third-party embed provider.
  assertEqual(embedCalls, 1, 'only the clean candidate should reach the embed provider');
  assertEqual(seen.some(t => t.includes('sneaky@example.com')), false, 'PII candidate must not be sent to OpenAI');
  assertEqual(r.inserted, 1, 'clean candidate queued for insertion');
  assertEqual(r.skipped, 1, 'PII candidate withheld (counted as skipped)');
});

test('mergeBucketPure: textField=null works for bare-string candidates (voice_cues, audience)', async () => {
  const embedFn = async (text) => {
    if (text === 'be concise') return [1, 0, 0];
    if (text === 'keep it short') return [0.97, 0.24, 0];
    return [0, 0, 1];
  };
  const candidates = ['keep it short'];
  const existingTexts = new Map([['be concise', 'be concise']]);
  const stored = [{ canonical_key: 'be concise', embedding: [1, 0, 0] }];

  const r = await mergeBucketPure({
    candidates, textField: null,
    existingTexts, stored, embedFn,
  });
  assertEqual(r.merged, 1);
  assertEqual(candidates[0], 'be concise', 'string slot rewritten in place');
});

test('mergeBucketPure: embedFn=null short-circuits with all zeros', async () => {
  const candidates = [{ question: 'foo' }];
  const r = await mergeBucketPure({
    candidates, textField: 'question',
    existingTexts: new Map(),
    stored: [],
    embedFn: null,
  });
  assertEqual(r.merged, 0);
  assertEqual(r.inserted, 0);
  assertEqual(r.skipped, 0);
  assertEqual(r.errors, 0);
});

// ---- Phase 3 LIMITATION-flip test ---------------------------------------

test('Phase 3 fixes the transitive-paraphrase LIMITATION (3 cycles → 1 promotion)', async () => {
  // Same 3 phrasings as the LIMITATION test in section 2 — but routed
  // through the v3.5.6 embedding pre-pass before applyAndPromote. With
  // semantically-close embeddings, all 3 cycles merge and promote.
  const phrasings = [
    { question: 'Why is pricing confusing or unclear?',                            suggested_answer: 'A1' },
    { question: 'Why is your pricing unclear, can you make pricing transparent?', suggested_answer: 'A2' },
    { question: 'Is pricing transparent and clearly displayed?',                   suggested_answer: 'A3' },
  ];
  // Mock embeddings: 3 vectors all within ~0.05–0.10 cosine distance of
  // each other (mimicking real semantic closeness of paraphrases).
  const EMB = {
    [phrasings[0].question]: [1.00, 0.00, 0.00],
    [phrasings[1].question]: [0.95, 0.31, 0.00],
    [phrasings[2].question]: [0.90, 0.35, 0.25],
  };
  const embedFn = async (text) => EMB[text] || [0, 0, 1];

  let soul = {}, memory = {}, audience = {};
  let storedFaqs = [];   // simulates the brand_learning_embeddings table for bucket=faqs

  for (const p of phrasings) {
    const candidates = { faqs: [{ ...p }] };

    // Build existing-text map from soul + memory (same shape the worker uses).
    const existingTexts = new Map();
    for (const [k, v] of buildExistingTextMap(soul.faqs || [], 'question')) existingTexts.set(k, v);
    for (const [k, v] of buildExistingTextMap(memory.candidate_faqs || [], 'question')) {
      if (!existingTexts.has(k)) existingTexts.set(k, v);
    }

    const merge = await mergeBucketPure({
      candidates: candidates.faqs,
      textField: 'question',
      existingTexts,
      stored: storedFaqs,
      embedFn,
    });

    // Persist new embeddings for future cycles (simulates the DB upsert).
    storedFaqs = storedFaqs.concat(merge.newEmbeddings);

    const r = applyAndPromote({
      currentSoul: soul, currentMemory: memory, currentAudience: audience,
      candidates, minSessions: 3, thisBatchSessions: 1,
    });
    soul = r.nextSoul; memory = r.nextMemory; audience = r.nextAudience;
  }

  // The LIMITATION test (section 2) ended with: soul.faqs=0, memory.candidate_faqs=2.
  // Phase 3 fixes this — all 3 cycles merge into one concept that promotes at cycle 3.
  assertEqual((soul.faqs || []).length, 1, 'all 3 phrasings should resolve to one promoted FAQ');
  assertEqual((memory.candidate_faqs || []).length, 0, 'candidate should have been promoted out');
});

// ---- resolveEmbedFn -----------------------------------------------------

test('resolveEmbedFn returns null when key is missing', () => {
  assertEqual(resolveEmbedFn({ apiKey: '',     provider: 'openai' }), null);
  assertEqual(resolveEmbedFn({ apiKey: null,   provider: 'openai' }), null);
  assertEqual(resolveEmbedFn({ apiKey: undefined, provider: 'openai' }), null);
});

test('resolveEmbedFn returns null for non-OpenAI providers', () => {
  assertEqual(resolveEmbedFn({ apiKey: 'sk-test', provider: 'anthropic' }), null);
  assertEqual(resolveEmbedFn({ apiKey: 'sk-test', provider: 'cohere' }), null);
  assertEqual(resolveEmbedFn({ apiKey: 'sk-test', provider: undefined }), null);
});

test('resolveEmbedFn returns a function for OpenAI + key (does NOT call the API)', () => {
  const fn = resolveEmbedFn({ apiKey: 'sk-test', provider: 'openai' });
  assert(typeof fn === 'function');
});

// ---- curate-to-embedding bucket mapping ---------------------------------

test('curateTargetToEmbeddingBucket maps soul + memory pairs to shared concept bucket', () => {
  assertEqual(curateTargetToEmbeddingBucket('soul',   'faqs'),               'faqs');
  assertEqual(curateTargetToEmbeddingBucket('memory', 'candidate_faqs'),     'faqs');
  assertEqual(curateTargetToEmbeddingBucket('soul',   'processes'),          'processes');
  assertEqual(curateTargetToEmbeddingBucket('memory', 'candidate_processes'), 'processes');
  assertEqual(curateTargetToEmbeddingBucket('soul',   'voice_cues'),         'voice_cues');
  assertEqual(curateTargetToEmbeddingBucket('memory', 'candidate_voice_cues'), 'voice_cues');
});

test('curateTargetToEmbeddingBucket maps audience sources to per-sub-bucket name', () => {
  assertEqual(curateTargetToEmbeddingBucket('audience_profile',   'common_pain_points'),   'audience_pain_points');
  assertEqual(curateTargetToEmbeddingBucket('audience_profile',   'common_objections'),    'audience_objections');
  assertEqual(curateTargetToEmbeddingBucket('audience_profile',   'common_request_types'), 'audience_request_types');
  assertEqual(curateTargetToEmbeddingBucket('audience_candidate', 'common_pain_points'),   'audience_pain_points');
});

test('curateTargetToEmbeddingBucket returns null for unknown pairs', () => {
  assertEqual(curateTargetToEmbeddingBucket('soul', 'unknown'), null);
  assertEqual(curateTargetToEmbeddingBucket('unknown', 'faqs'), null);
  assertEqual(curateTargetToEmbeddingBucket('audience_profile', 'unknown'), null);
});

test('canonicalKeyFromCurateItem reads canonical_key off object entries', () => {
  assertEqual(canonicalKeyFromCurateItem('soul',   { canonical_key: 'k1', question: 'Q' }), 'k1');
  assertEqual(canonicalKeyFromCurateItem('memory', { canonical_key: 'k2', name: 'P' }),     'k2');
  assertEqual(canonicalKeyFromCurateItem('audience_candidate', { canonical_key: 'k3', value: 'v' }), 'k3');
});

test('canonicalKeyFromCurateItem canonicalizes raw-string audience_profile entries', () => {
  // audience_profile stores raw strings; canonicalKey() strips punctuation +
  // lowercases.
  assertEqual(canonicalKeyFromCurateItem('audience_profile', 'Slow Response Times!'),
              'slow response times');
});

test('canonicalKeyFromCurateItem returns null on missing / bad input', () => {
  assertEqual(canonicalKeyFromCurateItem('soul', null), null);
  assertEqual(canonicalKeyFromCurateItem('soul', {}), null);
  assertEqual(canonicalKeyFromCurateItem('audience_profile', null), null);
  assertEqual(canonicalKeyFromCurateItem('audience_profile', 42), null);
});

// ---- sanity ------------------------------------------------------------

test('EMBEDDING_BUCKETS list matches migration 042 CHECK constraint', () => {
  // If you change one, change the other.
  const expected = [
    'faqs', 'processes', 'voice_cues',
    'audience_pain_points', 'audience_objections', 'audience_request_types',
  ];
  assertEqual(JSON.stringify(EMBEDDING_BUCKETS), JSON.stringify(expected));
});

test('DEFAULT_DISTANCE_THRESHOLD is conservative (0.10–0.30)', () => {
  assert(DEFAULT_DISTANCE_THRESHOLD >= 0.10 && DEFAULT_DISTANCE_THRESHOLD <= 0.30,
         `threshold ${DEFAULT_DISTANCE_THRESHOLD} should sit in the conservative window`);
});

test('DEFAULT_DISTANCE_THRESHOLD tuned to 0.30 (v3.5.8 canary)', () => {
  // 2026-05-16 live-OpenAI canary on staging showed 0.18 was too tight to
  // catch the semantic paraphrases v3.5.6 was designed to merge. See the
  // comment block above the constant in embeddings.js for the canary data.
  // If you change this value, run a fresh canary and update both this test
  // and the comment block.
  assertEqual(DEFAULT_DISTANCE_THRESHOLD, 0.30);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. render.js — prompt block rendering
// ═══════════════════════════════════════════════════════════════════════════

section('\nRender');

test('empty brand_soul renders empty string', () => {
  assertEqual(renderBrandSoulForPrompt(null), '');
  assertEqual(renderBrandSoulForPrompt({}), '');
  assertEqual(renderBrandSoulForPrompt({ faqs: [], processes: [], voice_cues: [] }), '');
});

test('populated brand_soul renders a usable block', () => {
  const block = renderBrandSoulForPrompt({
    faqs: [{ question: 'Do you ship?', answer: 'Yes', session_count: 5 }],
    processes: [{ name: 'Refund', description: 'Email support', session_count: 4 }],
    voice_cues: [{ cue: 'Casual tone', session_count: 3 }],
  });
  assertContains(block, 'LEARNED BRAND CONTEXT');
  assertContains(block, 'Do you ship?');
  assertContains(block, 'Refund');
  assertContains(block, 'Casual tone');
});

test('block instructs the agent NEVER to reveal it', () => {
  const block = renderBrandSoulForPrompt({
    faqs: [{ question: 'q', answer: 'a', session_count: 3 }],
  });
  assertContains(block, 'NEVER reference this section explicitly');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. PII fuzz — 100 synthetic anon conversations + diverse PII shapes
// ═══════════════════════════════════════════════════════════════════════════

section('\nPII fuzz');

test('100 synthetic conversations with diverse PII produce no PII residue', () => {
  // PII shapes the regex detectors are designed to catch. Generic order /
  // reference IDs without an "account|acct|konto" keyword prefix are
  // deliberately OUT of scope for the regex layer (too easy to false-positive
  // on inventory IDs, sku numbers, etc.) — they're caught downstream by the
  // LLM anti-extraction prompt + the worker's auditOutbound step before any
  // DB write. The fuzz test validates scrub-layer coverage of the shapes the
  // detectors are designed to catch.
  const piiSamples = [
    'jane.doe@example.com',
    'bob+tag@gmail.co.uk',
    'support@shenmay.ai',
    '555-123-4567',
    '(415) 555-0199',
    '+44 20 7946 0958',
    '111-22-3333',
    '987 65 4321',
    '4111 1111 1111 1111',
    '5500-0000-0000-0004',
    'GB82 WEST 1234 5698 7654 32',
    'DE89 3704 0044 0532 0130 00',
    '1990-04-12',
    '04/12/1990',
    'SW1A 1AA',
    '90210',
    'M5V 2H1',
    'Account 0123456789',
  ];

  const templates = [
    'Hi I would like to know more, my email is {pii}',
    'You can reach me at {pii} thanks',
    'Charge it to {pii}',
    'My DOB is {pii}',
    'Mailing address {pii}',
    'I called from {pii}',
    'Reference number is {pii}',
    'Order shipped to {pii}',
    'Try the card {pii} for me',
  ];

  for (let i = 0; i < 100; i++) {
    const pii = piiSamples[i % piiSamples.length];
    const tmpl = templates[i % templates.length];
    const messages = [
      { role: 'customer', content: tmpl.replace('{pii}', pii) },
      { role: 'agent',    content: 'Thanks, looking into that.' },
    ];
    const { scrubbedText } = scrubMessagesForDistillation(messages);

    // The literal PII MUST NOT appear in the scrubbed transcript.
    if (scrubbedText.includes(pii)) {
      throw new Error(`PII leaked at iteration ${i} — payload "${pii}" still in scrubbed text`);
    }
    // And the residual scanner must find no remaining PII patterns.
    const findings = quickScanForResidualPii(scrubbedText);
    if (findings.length > 0) {
      throw new Error(`residual PII at iteration ${i}: ${findings.join(',')} (transcript: ${scrubbedText.slice(0, 200)})`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════

(async () => {
  for (const item of queue) {
    if (item.type === 'section') {
      console.log(item.label);
      continue;
    }
    try {
      await item.fn();
      console.log(`  ✓ ${item.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${item.name}`);
      console.log(`    ${err.message || err}`);
      failed++;
      failures.push({ name: item.name, message: err.message || String(err) });
    }
  }

  console.log(`\n== Results: ${passed} passed, ${failed} failed ==\n`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
