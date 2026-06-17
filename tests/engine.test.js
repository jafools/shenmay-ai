/**
 * SHENMAY AI — Engine + Crypto/LLM Service Unit Tests
 *
 * Pure-JS unit tests — no DB, no server, no network. Runs in ~100ms.
 *
 * Covers the highest-blast-radius backend that previously had ZERO unit
 * coverage (audit finding M6): the prompt engine, the memory engine's pure
 * merge helpers, the two AES-256-GCM crypto services, and the BYOK / response
 * logic in llmService. None of these reach the provider SDKs — every test
 * exercises a pure function or an error path that throws before any network
 * call.
 *
 * Coverage:
 *   - cryptoService:  AES-256-GCM JSON envelope round-trip, idempotency,
 *                     transparent passthrough, GCM tamper detection, safe decrypt
 *   - apiKeyService:  BYOK key round-trip, input guards, tamper detection, getLast4
 *   - promptBuilder:  buildSystemPrompt boundary throws + every major block builder,
 *                     plus the deterministic mock-response branches
 *   - llmService:     resolveApiKey BYOK priority ladder, sanitiseResponse char
 *                     stripping, buildTokenizer flag gating, NoApiKeyError on
 *                     keyless chat/chatWithTools
 *   - memoryUpdater:  applyFactsToMemory / applySessionSummary / applySoulEvolution
 *                     (pure, gap-fill + clamp + dedup + purity), isSessionEnd, condenseMemory
 *
 * Run:  node tests/engine.test.js
 */

'use strict';

// Deterministic, hermetic crypto + deployment env BEFORE requiring modules that
// read it. cryptoService/apiKeyService read the secret at call time, so a fixed
// value keeps encrypt+decrypt self-consistent within the run regardless of the
// developer's shell. SaaS is the default mode for resolveApiKey tests.
process.env.API_KEY_ENCRYPTION_SECRET = 'test-engine-encryption-secret-at-least-32-chars';
delete process.env.SHENMAY_DEPLOYMENT;
delete process.env.NOMII_DEPLOYMENT;

const crypto = require('crypto');

const {
  encryptJson, decryptJson, safeDecryptJson, isEncrypted,
} = require('../server/src/services/cryptoService');

const apiKeyService = require('../server/src/services/apiKeyService');
const { encrypt, decrypt, getLast4 } = apiKeyService;

const {
  buildSystemPrompt,
  buildIdentityBlock,
  buildComplianceBlock,
  buildMemoryBlock,
  buildProductsBlock,
  buildWebsiteBlock,
  buildCustomerDataBlock,
  buildConversationHistoryBlock,
  buildSessionRulesBlock,
  generateMockResponse: pbMock,
} = require('../server/src/engine/promptBuilder');

const {
  resolveApiKey,
  sanitiseResponse,
  buildTokenizer,
  chat,
  chatWithTools,
  NoApiKeyError,
} = require('../server/src/services/llmService');

const {
  applyFactsToMemory,
  applySessionSummary,
  applySoulEvolution,
  isSessionEnd,
  condenseMemory,
} = require('../server/src/engine/memoryUpdater');

// ── Async-aware test runner (collect-then-run; matches tests/webhook-ssrf.test.js) ─

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
function assertDeepEqual(a, b, message) {
  const as = JSON.stringify(a);
  const bs = JSON.stringify(b);
  if (as !== bs) throw new Error(`${message || 'Deep values differ'}\n      expected: ${bs}\n      actual:   ${as}`);
}
function assertContains(hay, needle, message) {
  if (!String(hay).includes(needle)) throw new Error(`${message || 'Does not contain'}: expected output to include "${needle}"`);
}
function assertNotContains(hay, needle, message) {
  if (String(hay).includes(needle)) throw new Error(`${message || 'Contains forbidden value'}: output should NOT include "${needle}"`);
}
function assertThrows(fn, predicate, message) {
  let threw = null;
  try { fn(); } catch (err) { threw = err; }
  if (!threw) throw new Error(message || 'expected the call to throw, but it returned');
  if (predicate && !predicate(threw)) throw new Error(`${message || 'threw an unexpected error'}: ${threw.message}`);
}
async function assertRejects(fn, predicate, message) {
  let threw = null;
  try { await fn(); } catch (err) { threw = err; }
  if (!threw) throw new Error(message || 'expected the promise to reject, but it resolved');
  if (predicate && !predicate(threw)) throw new Error(`${message || 'rejected with an unexpected error'}: ${threw.message}`);
}

// Flip one base64 char in the auth-tag half of an "<ct>:<tag>" envelope so GCM
// verification must fail without changing the structure.
function tamperTag(encWithTag) {
  const [ct, tag] = encWithTag.split(':');
  const flipped = (tag[0] === 'A' ? 'Z' : 'A') + tag.slice(1);
  return `${ct}:${flipped}`;
}

section('\n== Engine + Crypto Unit Tests ==\n');

// ═══════════════════════════════════════════════════════════════════════════
// 1. cryptoService — AES-256-GCM JSON envelopes
// ═══════════════════════════════════════════════════════════════════════════

section('cryptoService');

test('encryptJson produces an { __enc, __iv } envelope recognised by isEncrypted', () => {
  const env = encryptJson({ hello: 'world' });
  assert(typeof env.__enc === 'string' && env.__enc.length > 0, '__enc must be a non-empty string');
  assert(typeof env.__iv === 'string' && env.__iv.length > 0, '__iv must be a non-empty string');
  assert(isEncrypted(env), 'envelope must classify as encrypted');
});

test('decryptJson(encryptJson(x)) round-trips a nested object exactly', () => {
  const original = { name: 'Jane', nested: { a: 1, list: [1, 2, 3] }, flag: true };
  const round = decryptJson(encryptJson(original));
  assertDeepEqual(round, original);
});

test('encryptJson is idempotent — an already-encrypted value passes through unchanged', () => {
  const env = encryptJson({ a: 1 });
  const again = encryptJson(env);
  assertEqual(again, env, 'must not double-encrypt');
});

test('encryptJson / decryptJson pass null and undefined straight through', () => {
  assertEqual(encryptJson(null), null);
  assertEqual(encryptJson(undefined), undefined);
  assertEqual(decryptJson(null), null);
  assertEqual(decryptJson(undefined), undefined);
});

test('decryptJson returns a plain (non-envelope) object unchanged', () => {
  const plain = { already: 'plain', n: 2 };
  assertDeepEqual(decryptJson(plain), plain);
});

test('isEncrypted is true only for a real envelope', () => {
  assert(isEncrypted({ __enc: 'x', __iv: 'y' }) === true);
  assert(isEncrypted({ foo: 'bar' }) === false);
  assert(isEncrypted(null) === false);
  assert(isEncrypted('a string') === false);
  assert(isEncrypted({ __enc: 'x' }) === false, 'needs both __enc and __iv');
});

test('each encryptJson call uses a fresh random IV', () => {
  const a = encryptJson({ x: 1 });
  const b = encryptJson({ x: 1 });
  assert(a.__iv !== b.__iv, 'IVs must differ across calls');
});

test('decryptJson THROWS on a tampered auth tag (GCM integrity)', () => {
  const env = encryptJson({ secret: 'value' });
  const bad = { __enc: tamperTag(env.__enc), __iv: env.__iv };
  assertThrows(() => decryptJson(bad), null, 'a tampered envelope must throw');
});

test('safeDecryptJson returns {} on a tampered envelope instead of throwing', () => {
  const env = encryptJson({ secret: 'value' });
  const bad = { __enc: tamperTag(env.__enc), __iv: env.__iv };
  assertDeepEqual(safeDecryptJson(bad), {});
});

test('safeDecryptJson returns {} for null/undefined', () => {
  assertDeepEqual(safeDecryptJson(null), {});
  assertDeepEqual(safeDecryptJson(undefined), {});
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. apiKeyService — BYOK key encryption
// ═══════════════════════════════════════════════════════════════════════════

section('\napiKeyService');

test('encrypt → decrypt round-trips an API key', () => {
  const { encrypted, iv } = encrypt('sk-ant-byok-abc123');
  assert(encrypted.includes(':'), 'envelope must be "<ct>:<tag>"');
  assert(typeof iv === 'string' && iv.length > 0, 'iv must be a non-empty base64 string');
  assertEqual(decrypt(encrypted, iv), 'sk-ant-byok-abc123');
});

test('encrypt rejects non-string / empty input with TypeError', () => {
  assertThrows(() => encrypt(''), e => e instanceof TypeError);
  assertThrows(() => encrypt(12345), e => e instanceof TypeError);
  assertThrows(() => encrypt(null), e => e instanceof TypeError);
});

test('decrypt rejects a malformed envelope (no ":" separator) with TypeError', () => {
  assertThrows(() => decrypt('not-an-envelope', 'aXY='), e => e instanceof TypeError);
});

test('decrypt rejects an empty IV with TypeError', () => {
  const { encrypted } = encrypt('sk-ant-xyz');
  assertThrows(() => decrypt(encrypted, ''), e => e instanceof TypeError);
});

test('decrypt THROWS on a tampered auth tag (GCM integrity)', () => {
  const { encrypted, iv } = encrypt('sk-ant-tamper-me');
  assertThrows(() => decrypt(tamperTag(encrypted), iv), null, 'tampered key ciphertext must throw');
});

test('getLast4 returns the last four chars, or "" for falsy input', () => {
  assertEqual(getLast4('sk-ant-wxyz'), 'wxyz');
  assertEqual(getLast4(''), '');
  assertEqual(getLast4(null), '');
  assertEqual(getLast4(undefined), '');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. promptBuilder — system prompt assembly
// ═══════════════════════════════════════════════════════════════════════════

section('\npromptBuilder');

test('buildSystemPrompt assembles all major sections for minimal valid input', () => {
  const out = buildSystemPrompt({
    tenant: { name: 'Acme', agent_name: 'Aria' },
    customer: { soul_file: {}, memory_file: {} },
    currentDate: '2026-06-17',
  });
  assert(typeof out === 'string' && out.length > 0, 'must return a non-empty string');
  assertContains(out, '## YOUR IDENTITY');
  assertContains(out, '## COMPLIANCE RULES');
  assertContains(out, '## SESSION RULES');
  assertContains(out, "Today's date: 2026-06-17");
});

test('buildSystemPrompt throws TypeError when tenant is missing', () => {
  assertThrows(() => buildSystemPrompt({ customer: {} }), e => e instanceof TypeError);
});

test('buildSystemPrompt throws TypeError when customer is missing', () => {
  assertThrows(() => buildSystemPrompt({ tenant: {} }), e => e instanceof TypeError);
});

test('buildIdentityBlock uses the customer-chosen agent nickname', () => {
  const out = buildIdentityBlock({ agent_nickname: 'Sunny' }, { name: 'Acme', agent_name: 'Aria' }, {});
  assertContains(out, '"Sunny"');
  assertContains(out, 'ALWAYS use this name');
});

test('buildIdentityBlock falls back to the tenant agent_name when no nickname', () => {
  const out = buildIdentityBlock({}, { name: 'Acme', agent_name: 'Aria' }, {});
  assertContains(out, '"Aria"');
  assertContains(out, 'DO NOT ask');
});

test('buildComplianceBlock emits a default disclaimer when none configured', () => {
  assertContains(buildComplianceBlock({}, {}), 'not a licensed professional');
});

test('buildComplianceBlock prefers soul.compliance over tenant compliance_config', () => {
  const out = buildComplianceBlock(
    { compliance: { required_disclaimers: ['Soul disclaimer X'] } },
    { compliance_config: { disclaimers: ['Tenant disclaimer Y'] } },
  );
  assertContains(out, 'Soul disclaimer X');
  assertNotContains(out, 'Tenant disclaimer Y');
});

test('buildMemoryBlock renders profile fields with "Unknown" gap defaults', () => {
  const out = buildMemoryBlock({ personal_profile: { name: 'Jane', age: 62 } });
  assertContains(out, 'Name: Jane');
  assertContains(out, 'Age: 62');
  assertContains(out, 'Location: Unknown');
});

test('buildProductsBlock returns "" when there are no products', () => {
  assertEqual(buildProductsBlock([], { name: 'Acme' }), '');
  assertEqual(buildProductsBlock(null, { name: 'Acme' }), '');
});

test('buildProductsBlock lists products and forbids inventing them', () => {
  const out = buildProductsBlock([{ name: 'Gold Plan', price_info: '$99/mo' }], { name: 'Acme' });
  assertContains(out, 'Gold Plan');
  assertContains(out, 'Never invent products');
});

test('buildWebsiteBlock is empty without a URL and includes the URL when present', () => {
  assertEqual(buildWebsiteBlock({ name: 'Acme' }), '');
  assertContains(buildWebsiteBlock({ name: 'Acme', website_url: 'https://acme.test' }), 'https://acme.test');
});

test('buildConversationHistoryBlock greets a first-time customer', () => {
  assertContains(buildConversationHistoryBlock({}), 'first conversation');
});

test('buildConversationHistoryBlock caps to the last 5 sessions and notes older ones', () => {
  const history = Array.from({ length: 7 }, (_, i) => ({
    session: i + 1, date: `2026-01-0${i + 1}`, summary: `Session ${i + 1} summary`,
  }));
  const out = buildConversationHistoryBlock({ conversation_history: history });
  assertContains(out, '7 total sessions');
  assertContains(out, 'showing last 5');
  assertContains(out, '2 earlier sessions');
});

test('buildCustomerDataBlock groups records by category and formats currency', () => {
  const out = buildCustomerDataBlock({}, [{ category: 'accounts', label: '401k', value: '150000' }], {});
  assertContains(out, 'Accounts');
  assertContains(out, '401k');
  assertContains(out, '$150');
});

test('buildSessionRulesBlock lists remaining onboarding categories + the date', () => {
  const out = buildSessionRulesBlock(
    { onboarding_status: 'incomplete', onboarding_categories_completed: ['agent_naming'] },
    { onboarding_config: { categories: ['agent_naming', 'financial_goals', 'family'] } },
    '2026-06-17', false,
  );
  assertContains(out, 'CATEGORIES STILL TO COVER');
  assertContains(out, 'financial goals');
  assertContains(out, "Today's date: 2026-06-17");
});

test('buildSessionRulesBlock suppresses the greeting when the widget already greeted', () => {
  const out = buildSessionRulesBlock({ onboarding_status: 'complete' }, {}, '2026-06-17', true);
  assertContains(out, 'already displayed an opening greeting');
});

test('generateMockResponse handles a naming attempt by echoing the chosen name', () => {
  const out = pbMock('Jane Doe', 'I think I will call you "Aria"', 'Aria');
  assertContains(out, 'Aria');
  assertContains(out, 'I love that');
});

test('generateMockResponse greets warmly on a hello', () => {
  const out = pbMock('Jane Doe', 'hello there', 'Aria');
  assertContains(out, 'Welcome back');
  assertContains(out, 'Jane');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. llmService — BYOK resolution, sanitising, tokenizer gating, keyless guard
// ═══════════════════════════════════════════════════════════════════════════

section('\nllmService');

test('resolveApiKey returns null for a null tenant', () => {
  assertEqual(resolveApiKey(null), null);
});

test('resolveApiKey returns null on SaaS with no tenant key (no silent platform-key drift)', () => {
  assertEqual(resolveApiKey({}), null);
});

test('resolveApiKey returns the platform key when managed_ai_enabled', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-platform-managed';
  try {
    assertEqual(resolveApiKey({ managed_ai_enabled: true }), 'sk-ant-platform-managed');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('resolveApiKey returns null when managed_ai_enabled but no platform key is set', () => {
  const savedA = process.env.ANTHROPIC_API_KEY;
  const savedC = process.env.CLAUDE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_API_KEY;
  try {
    assertEqual(resolveApiKey({ managed_ai_enabled: true }), null);
  } finally {
    if (savedA !== undefined) process.env.ANTHROPIC_API_KEY = savedA;
    if (savedC !== undefined) process.env.CLAUDE_API_KEY = savedC;
  }
});

test('resolveApiKey decrypts a tenant BYOK key when validated', () => {
  const { encrypted, iv } = encrypt('sk-ant-tenant-byok-9');
  const tenant = { llm_api_key_encrypted: encrypted, llm_api_key_iv: iv, llm_api_key_validated: true };
  assertEqual(resolveApiKey(tenant), 'sk-ant-tenant-byok-9');
});

test('resolveApiKey ignores an UNvalidated BYOK key (returns null on SaaS)', () => {
  const { encrypted, iv } = encrypt('sk-ant-not-validated');
  const tenant = { llm_api_key_encrypted: encrypted, llm_api_key_iv: iv, llm_api_key_validated: false };
  assertEqual(resolveApiKey(tenant), null);
});

test('resolveApiKey falls back to the operator env key only when self-hosted', () => {
  const savedDep = process.env.SHENMAY_DEPLOYMENT;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.SHENMAY_DEPLOYMENT = 'selfhosted';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-operator-env';
  try {
    assertEqual(resolveApiKey({}), 'sk-ant-operator-env');
  } finally {
    if (savedDep === undefined) delete process.env.SHENMAY_DEPLOYMENT;
    else process.env.SHENMAY_DEPLOYMENT = savedDep;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('sanitiseResponse strips CJK and collapses the resulting double space', () => {
  assertEqual(sanitiseResponse('Hello 世界 world'), 'Hello world');
});

test('sanitiseResponse strips Cyrillic and trims', () => {
  assertEqual(sanitiseResponse('Привет hello'), 'hello');
});

test('sanitiseResponse leaves plain ASCII untouched and passes falsy through', () => {
  assertEqual(sanitiseResponse('Just a normal sentence.'), 'Just a normal sentence.');
  assertEqual(sanitiseResponse(''), '');
  assertEqual(sanitiseResponse(null), null);
});

test('buildTokenizer returns null when the tenant has tokenization disabled', () => {
  assertEqual(buildTokenizer({ tenant: { pii_tokenization_enabled: false } }), null);
});

test('buildTokenizer returns a tokenizer by default (no tenant / flag on)', () => {
  assert(buildTokenizer({}) !== null, 'default should build a tokenizer');
  assert(buildTokenizer({ tenant: { pii_tokenization_enabled: true } }) !== null);
});

test('chat rejects with NoApiKeyError before any network call when apiKey is absent', async () => {
  await assertRejects(() => chat({ systemPrompt: 'x', messages: [] }),
    e => e instanceof NoApiKeyError && e.code === 'NO_API_KEY');
});

test('chatWithTools rejects with NoApiKeyError when apiKey is absent', async () => {
  await assertRejects(() => chatWithTools({ systemPrompt: 'x', messages: [], tools: [] }),
    e => e instanceof NoApiKeyError);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. memoryUpdater — pure merge / summary / evolution helpers
// ═══════════════════════════════════════════════════════════════════════════

section('\nmemoryUpdater');

test('isSessionEnd recognises farewells and thanks, ignores ordinary questions', () => {
  assertEqual(isSessionEnd('goodbye!'), true);
  assertEqual(isSessionEnd('thanks so much for your help'), true);
  assertEqual(isSessionEnd('have a great day'), true);
  assertEqual(isSessionEnd('what is my account balance?'), false);
});

test('applyFactsToMemory returns the input untouched when facts are empty', () => {
  const mem = { x: 1 };
  assertEqual(applyFactsToMemory(mem, {}), mem);
  assertEqual(applyFactsToMemory(mem, null), mem);
});

test('applyFactsToMemory gap-fills the profile without overwriting existing values', () => {
  const out = applyFactsToMemory(
    { personal_profile: { name: 'Jane' } },
    { personal_profile: { name: 'Janet', age: 60 } },
  );
  assertEqual(out.personal_profile.name, 'Jane', 'existing name must not be overwritten');
  assertEqual(out.personal_profile.age, 60, 'missing field must be filled');
});

test('applyFactsToMemory appends new goals, deduped case-insensitively', () => {
  const out = applyFactsToMemory(
    { life_plan: { goals: ['retire early'] } },
    { new_goals: ['Retire Early', 'travel more'] },
  );
  assertEqual(out.life_plan.goals.length, 2);
  assertContains(out.life_plan.goals.join('|'), 'travel more');
});

test('applyFactsToMemory does NOT mutate its input (deep clone)', () => {
  const mem = { personal_profile: { name: 'Jane' } };
  const before = JSON.stringify(mem);
  applyFactsToMemory(mem, { personal_profile: { age: 60 }, new_goals: ['x'] });
  assertEqual(JSON.stringify(mem), before, 'the original memory object must be unchanged');
});

test('applySessionSummary appends a conversation_history entry with defaults', () => {
  const out = applySessionSummary({}, {
    summary: 'Talked about retirement', topics: ['retirement_planning'], emotional_tone: 'positive',
  }, 3);
  assertEqual(out.conversation_history.length, 1);
  assertEqual(out.conversation_history[0].session, 3);
  assertEqual(out.conversation_history[0].summary, 'Talked about retirement');
  assertEqual(out.conversation_history[0].emotional_tone, 'positive');
  assertDeepEqual(out.conversation_history[0].topics, ['retirement_planning']);
});

test('applySessionSummary returns the input unchanged for an empty summary', () => {
  const mem = { x: 1 };
  assertEqual(applySessionSummary(mem, null, 1), mem);
});

test('applySoulEvolution clamps complexity, sets tone, and dedups principles', () => {
  const out = applySoulEvolution({}, {
    complexity_level: 9, tone: 'warm', add_principles: ['be concise', 'be concise'],
  });
  assertEqual(out.communication_style.complexity_level, 5, 'complexity must clamp to 5');
  assertEqual(out.communication_style.tone, 'warm');
  assertEqual(out.communication_style.key_principles.length, 1, 'duplicate principle must be deduped');
});

test('applySoulEvolution returns the input unchanged for empty signals', () => {
  const soul = { x: 1 };
  assertEqual(applySoulEvolution(soul, {}), soul);
});

test('condenseMemory summarises a populated memory and handles empties', () => {
  assertEqual(condenseMemory(null), 'No prior memory.');
  assertEqual(condenseMemory('not an object'), 'No prior memory.');
  assertEqual(condenseMemory({}), 'No prior profile data.');
  const c = condenseMemory({ personal_profile: { name: 'Jane', age: 62 }, agent_notes: ['likes tea'] });
  assertContains(c, 'Name: Jane');
  assertContains(c, 'Age: 62');
  assertContains(c, 'Notes: likes tea');
});

// ── Run queue ────────────────────────────────────────────────────────────────

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
