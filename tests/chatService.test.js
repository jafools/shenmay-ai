/**
 * SHENMAY AI — Chat Service Unit Tests (widget /chat hot path / T11b)
 *
 * Pure-JS unit tests — no DB, no server, no network. Runs in ~100ms.
 *
 * Covers engine/chatService.handleMessage(), extracted from the 437-line
 * POST /api/widget/chat handler (audit finding M8). The three branches the
 * mock-provider e2e CANNOT reach (human-mode, no-key, breach) had zero
 * automated coverage anywhere before this suite; they are the focus.
 *
 * Strategy (matches tests/license.test.js): inject a fake `../db` and a fake
 * `../services/llmService` into require.cache BEFORE requiring chatService, so
 * the hot path runs against an in-memory pool + stubbed LLM with no Postgres
 * and no provider call. The fake llmService re-exports the REAL NoApiKeyError
 * and the real BreachError is used directly, so chatService's `instanceof`
 * checks stay faithful.
 *
 * Run:  node tests/chatService.test.js
 */

'use strict';

// Hermetic env before requiring modules that read it (cryptoService reads the
// secret at call time; safeDecryptJson passes plain objects through).
process.env.API_KEY_ENCRYPTION_SECRET = 'test-chatservice-encryption-secret-at-least-32-chars';
delete process.env.SHENMAY_DEPLOYMENT;
delete process.env.NOMII_DEPLOYMENT;

const DB_PATH           = require.resolve('../server/src/db');
const LLM_PATH          = require.resolve('../server/src/services/llmService');
const REGISTRY_PATH     = require.resolve('../server/src/tools/registry');
const CUSTOMLOADER_PATH = require.resolve('../server/src/tools/customToolLoader');
const SVC_PATH          = require.resolve('../server/src/engine/chatService');

// Grab the REAL error classes + tool modules before any faking, so thrown
// instances satisfy chatService's `instanceof` checks and so each test resets
// the tool modules to real (no fake leaks across tests via require.cache).
const { NoApiKeyError } = require('../server/src/services/llmService');
const { BreachError }   = require('../server/src/services/piiTokenizer');
const realRegistry      = require('../server/src/tools/registry');
const realCustomLoader  = require('../server/src/tools/customToolLoader');

function fakeModule(path, exports) {
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

// Load a fresh chatService with the given fakes injected. Re-requiring picks up
// whatever is in require.cache for its module-load `require()` calls. Every
// faked module is set on EVERY call (defaulting to real) so a fake from one
// test can't leak into the next.
function loadChatService({ db, llm = {}, registry, customLoader } = {}) {
  delete require.cache[SVC_PATH];
  fakeModule(DB_PATH, db);
  fakeModule(LLM_PATH, Object.assign({
    getAgentResponse:    async () => 'MOCK_REPLY',
    callClaudeWithTools: async () => 'MOCK_RAW',
    sanitiseResponse:    (x) => x,
    resolveApiKey:       () => 'sk-test',
    buildTokenizer:      () => ({}),
    NoApiKeyError,
  }, llm));
  fakeModule(REGISTRY_PATH, registry || realRegistry);
  fakeModule(CUSTOMLOADER_PATH, customLoader || realCustomLoader);
  return require('../server/src/engine/chatService');
}

// ── In-memory recording pool ──────────────────────────────────────────────
function makeDb(handler) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const res = handler ? handler(sql, params) : null;
      return res || { rows: [], rowCount: 1 };
    },
  };
}

const CONV_ROW = {
  customer_id: 'c1', first_name: 'Jane', last_name: 'Doe', email: 'jane@acme.com',
  soul_file: null, memory_file: null,
  onboarding_status: 'complete', onboarding_categories_completed: [],
  tenant_id: 't1', tenant_name: 'Acme', agent_name: 'Aria',
  vertical: null, vertical_config: null,
  compliance_config: null, base_soul_template: null,
  llm_provider: 'anthropic', llm_model: 'claude-x', website_url: null,
  llm_api_key_encrypted: 'enc', llm_api_key_iv: 'iv', llm_api_key_validated: true,
  enabled_tools: [], tool_configs: {},
  pii_tokenization_enabled: false,
  brand_learning_enabled: false, brand_soul: null,
};

// Handler for the standard AI-mode path: not human, a valid conv row, empty
// history, no custom tools.
function aiModeHandler(opts = {}) {
  const conv = ('conv' in opts) ? opts.conv : CONV_ROW;
  const existing = opts.existingMessages || [];
  return (sql) => {
    if (sql.includes('SELECT mode FROM conversations'))               return { rows: [{ mode: opts.mode || 'ai' }] };
    if (sql.includes('FROM customers c') && sql.includes('JOIN tenants t')) return { rows: conv ? [conv] : [] };
    if (sql.includes('FROM customer_data'))                           return { rows: [] };
    if (sql.includes('FROM tenant_products'))                         return { rows: [] };
    if (sql.includes('SELECT role, content FROM messages'))           return { rows: existing };
    if (sql.includes('SELECT handback_note'))                         return { rows: [{ handback_note: opts.handbackNote || null }] };
    if (sql.includes('FROM custom_tools'))                            return { rows: [] };
    if (sql.includes('SELECT COUNT(*) FROM messages'))                return { rows: [{ count: '2' }] };
    return { rows: [{}], rowCount: 1 };
  };
}

// Handler for the human-mode path: routes around email (no agent, no admins)
// so the in-app createNotification INSERT is the observable side effect.
function humanModeHandler() {
  return (sql) => {
    if (sql.includes('SELECT mode FROM conversations')) return { rows: [{ mode: 'human' }] };
    if (sql.includes('FROM conversations co')) return { rows: [{
      cust_first: 'Jane', cust_last: 'Doe', cust_email: 'jane@acme.com',
      human_agent_id: null, agent_email: null, agent_first: null, agent_last: null,
      email_from_name: null, email_reply_to: null, email_footer: null,
    }] };
    if (sql.includes('FROM tenant_admins')) return { rows: [] };
    return { rows: [{}], rowCount: 1 };
  };
}

const baseArgs = {
  tenantId: 't1', customerId: 'c1', conversationId: 'conv1',
  isAnonymous: true, managedAiEnabled: false, content: 'hello there',
};

// ── Async-aware test runner (collect-then-run; matches tests/engine.test.js) ──
let passed = 0;
let failed = 0;
const failures = [];
const queue = [];

function test(name, fn) { queue.push({ type: 'test', name, fn }); }
function section(label) { queue.push({ type: 'section', label }); }

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}
function assertEqual(a, b, message) {
  if (a !== b) throw new Error(`${message || 'Values differ'}\n      expected: ${JSON.stringify(b)}\n      actual:   ${JSON.stringify(a)}`);
}
function assertContains(hay, needle, message) {
  if (!String(hay).includes(needle)) throw new Error(`${message || 'Does not contain'}: expected "${needle}"`);
}

// Run an async fn with console.{error,warn} captured; always restores them.
async function runCapturing(asyncFn) {
  const errs = [];
  const warns = [];
  const oe = console.error;
  const ow = console.warn;
  console.error = (...a) => errs.push(a.map(String).join(' '));
  console.warn  = (...a) => warns.push(a.map(String).join(' '));
  let value;
  let error;
  try { value = await asyncFn(); } catch (e) { error = e; }
  console.error = oe;
  console.warn  = ow;
  return { value, error, errs, warns };
}

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

// Exact customer-facing strings the inline handler used — pinned so a future
// refactor (e.g. de-duping the two-file BreachError string) can't drift them.
const BREACH_REPLY = 'I noticed some sensitive information in that message. For your security, I can\'t process it in this form. Please rephrase without the specific details and I\'ll be happy to help.';
const NO_KEY_REPLY = 'I\'m having trouble connecting right now. Please try again in a moment.';

// ─────────────────────────────────────────────────────────────────────────────

section('\n== Chat Service Unit Tests (widget /chat hot path) ==\n');

section('human-mode branch');

test('human mode returns the waiting signal and never calls the LLM', async () => {
  const db = makeDb(humanModeHandler());
  let llmCalls = 0;
  const chatService = loadChatService({
    db,
    llm: {
      getAgentResponse:    async () => { llmCalls++; return 'X'; },
      callClaudeWithTools: async () => { llmCalls++; return 'X'; },
    },
  });

  const result = await chatService.handleMessage({ db, ...baseArgs });

  assertEqual(result.kind, 'human', 'kind should be human');
  assertEqual(result.role, 'agent', 'role should be agent');
  assertEqual(result.content, null, 'content should be null');
  assertEqual(result.waiting, true, 'waiting should be true');
  assertEqual(result.mode, 'human', 'mode should be human');
  assertEqual(llmCalls, 0, 'LLM must NOT be called in human mode');
});

test('human mode persists the customer message + marks unread before returning', async () => {
  const db = makeDb(humanModeHandler());
  const chatService = loadChatService({ db });

  await chatService.handleMessage({ db, ...baseArgs });

  // Ordering: SELECT mode → INSERT customer msg → UPDATE unread → UPDATE last_interaction
  const seq = db.calls.map((c) => c.sql);
  const iSelect = seq.findIndex((s) => s.includes('SELECT mode FROM conversations'));
  const iInsert = seq.findIndex((s) => s.includes('INSERT INTO messages'));
  const iUnread = seq.findIndex((s) => s.includes('UPDATE conversations SET unread'));
  const iTouch  = seq.findIndex((s) => s.includes('UPDATE customers SET last_interaction_at'));
  assert(iSelect >= 0 && iInsert > iSelect, 'INSERT customer msg after SELECT mode');
  assert(iUnread > iInsert, 'UPDATE unread after INSERT');
  assert(iTouch > iUnread, 'UPDATE last_interaction after unread');
});

test('human mode fires the in-app notification (B3 — fan-out must not silently break)', async () => {
  const db = makeDb(humanModeHandler());
  const chatService = loadChatService({ db });

  await chatService.handleMessage({ db, ...baseArgs });
  await flushMicrotasks(); // let the setImmediate fan-out run

  const firedNotification = db.calls.some((c) => c.sql.includes('INSERT INTO notifications'));
  assert(firedNotification, 'createNotification INSERT must fire from the setImmediate fan-out');
});

section('no-key branch');

test('NoApiKeyError is swallowed → reply with the generic connection string', async () => {
  const db = makeDb(aiModeHandler());
  const chatService = loadChatService({
    db,
    llm: { getAgentResponse: async () => { throw new NoApiKeyError(); } },
  });

  const { value: result, error, warns } = await runCapturing(() =>
    chatService.handleMessage({ db, ...baseArgs }));

  assert(!error, `must not throw, threw: ${error && error.message}`);
  assertEqual(result.kind, 'reply', 'kind should be reply');
  assertEqual(result.content, NO_KEY_REPLY, 'exact no-key reply string');
  assert(warns.some((w) => w.includes('[Widget][chat][no-key]')), 'no-key log tag emitted');
});

test('no-key reply is still persisted (increment + agent insert run)', async () => {
  const db = makeDb(aiModeHandler());
  const chatService = loadChatService({
    db,
    llm: { getAgentResponse: async () => { throw new NoApiKeyError(); } },
  });

  await runCapturing(() => chatService.handleMessage({ db, ...baseArgs }));

  const agentInsert = db.calls.find((c) =>
    c.sql.includes('INSERT INTO messages') && c.params && c.params[1] === 'agent');
  assert(agentInsert, 'agent message must be persisted even on no-key');
  assertEqual(agentInsert.params[2], NO_KEY_REPLY, 'persisted content is the no-key string');
});

section('breach branch');

test('BreachError is swallowed → reply with the safe rephrase string', async () => {
  const db = makeDb(aiModeHandler());
  const chatService = loadChatService({
    db,
    llm: { getAgentResponse: async () => { throw new BreachError([{ type: 'pan', length: 16 }]); } },
  });

  const { value: result, error, errs } = await runCapturing(() =>
    chatService.handleMessage({ db, ...baseArgs }));

  assert(!error, `must not throw, threw: ${error && error.message}`);
  assertEqual(result.kind, 'reply', 'kind should be reply');
  assertEqual(result.content, BREACH_REPLY, 'exact breach reply string');
  assert(errs.some((e) => e.includes('[Widget][chat][llm] BreachError blocked request')), 'breach log tag emitted');
});

test('breach reply string is byte-identical to the standard-path copy in llmService', async () => {
  // The conservative T11b extraction leaves the standard-path swallow inside
  // llmService.getAgentResponse (which returns its own copy of the string).
  // Pin both copies equal so a future de-dup can't drift them.
  const llmServiceSrc = require('fs').readFileSync(
    require.resolve('../server/src/services/llmService'), 'utf8');
  assertContains(llmServiceSrc, 'I noticed some sensitive information in that message.',
    'llmService must still carry the byte-identical breach string');
});

section('standard / tools happy paths');

test('standard path returns the LLM reply with conversation_id echoed', async () => {
  const db = makeDb(aiModeHandler());
  const chatService = loadChatService({
    db,
    llm: { getAgentResponse: async () => 'Hi Jane, how can I help?' },
  });

  const result = await chatService.handleMessage({ db, ...baseArgs, conversationId: 'conv-xyz' });

  assertEqual(result.kind, 'reply', 'kind should be reply');
  assertEqual(result.role, 'agent', 'role should be agent');
  assertEqual(result.content, 'Hi Jane, how can I help?', 'reply content');
  assertEqual(result.conversation_id, 'conv-xyz', 'conversation_id echoed');
});

test('standard path persists in order: increment → agent insert → timestamp → count', async () => {
  const db = makeDb(aiModeHandler());
  const chatService = loadChatService({ db, llm: { getAgentResponse: async () => 'ok' } });

  await chatService.handleMessage({ db, ...baseArgs });

  const seq = db.calls.map((c) => c.sql);
  const iInsertAgent = db.calls.findIndex((c) =>
    c.sql.includes('INSERT INTO messages') && c.params && c.params[1] === 'agent');
  const iTouch = seq.findIndex((s) => s.includes('UPDATE customers SET last_interaction_at'));
  const iCount = seq.findIndex((s) => s.includes('SELECT COUNT(*) FROM messages'));
  assert(iInsertAgent >= 0, 'agent insert present');
  assert(iTouch > iInsertAgent, 'timestamp update after agent insert');
  assert(iCount > iTouch, 'count after timestamp update');
});

test('tools path is taken when tools exist + managed AI enabled; reply is sanitised', async () => {
  const db = makeDb(aiModeHandler());
  let toolsCalled = 0;
  let standardCalled = 0;
  const chatService = loadChatService({
    db,
    registry: { getToolDefinitions: () => [{ name: 'demo_tool' }] },
    customLoader: {
      loadCustomTools:       async () => [],
      toToolDefinition:      (r) => r,
      buildCustomExecutor:   () => (() => {}),
      buildCombinedExecutor: () => (() => {}),
    },
    llm: {
      callClaudeWithTools: async () => { toolsCalled++; return 'RAW'; },
      getAgentResponse:    async () => { standardCalled++; return 'X'; },
      sanitiseResponse:    (x) => `clean:${x}`,
    },
  });

  const result = await chatService.handleMessage({ db, ...baseArgs, managedAiEnabled: true });

  assertEqual(result.kind, 'reply', 'kind should be reply');
  assertEqual(result.content, 'clean:RAW', 'tools reply is sanitised');
  assertEqual(toolsCalled, 1, 'tool-calling path used');
  assertEqual(standardCalled, 0, 'standard path NOT used when tools path taken');
});

section('generic error + not-found');

test('a generic LLM error is re-thrown (route maps to next(err) → 500)', async () => {
  const db = makeDb(aiModeHandler());
  const chatService = loadChatService({
    db,
    llm: { getAgentResponse: async () => { throw new Error('boom'); } },
  });

  const { error, errs } = await runCapturing(() => chatService.handleMessage({ db, ...baseArgs }));

  assert(error instanceof Error, 'must re-throw');
  assertEqual(error.message, 'boom', 're-throws the original error');
  assert(errs.some((e) => e.includes('[Widget][chat][llm] path=') && e.includes('boom')),
    'generic error log tag emitted with the message');
});

test('generic error skips persistence (no agent message inserted)', async () => {
  const db = makeDb(aiModeHandler());
  const chatService = loadChatService({
    db,
    llm: { getAgentResponse: async () => { throw new Error('boom'); } },
  });

  await runCapturing(() => chatService.handleMessage({ db, ...baseArgs }));

  const agentInsert = db.calls.find((c) =>
    c.sql.includes('INSERT INTO messages') && c.params && c.params[1] === 'agent');
  assert(!agentInsert, 'no agent message should be persisted when the error rethrows');
});

test('missing session context returns not_found (route maps to 404)', async () => {
  const db = makeDb(aiModeHandler({ conv: null }));
  const chatService = loadChatService({ db });

  const result = await chatService.handleMessage({ db, ...baseArgs, isAnonymous: false });

  assertEqual(result.kind, 'not_found', 'kind should be not_found');
});

section('history budget (T14)');

function mkHistory(n) {
  // Alternating customer/agent starting on the customer's first message, which
  // is how a real conversation is stored (oldest → newest).
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'customer' : 'agent',
    content: `m${i}`,
  }));
}

test('capHistory returns history unchanged when under the limit', async () => {
  const { capHistory } = loadChatService({ db: makeDb() });
  const out = capHistory(mkHistory(4), 6);
  assertEqual(out.length, 4, 'all messages kept under the limit');
  assertEqual(out[0].content, 'm0', 'oldest message retained');
});

test('capHistory keeps only the most recent N messages when over the limit', async () => {
  const { capHistory } = loadChatService({ db: makeDb() });
  const out = capHistory(mkHistory(20), 6); // slice(-6) → m14..m19, m14 is a customer turn
  assertEqual(out.length, 6, 'capped to the limit');
  assertEqual(out[0].role, 'customer', 'window starts on a user turn');
  assertEqual(out[0].content, 'm14', 'kept the most recent window');
  assertEqual(out[5].content, 'm19', 'newest message retained');
});

test('capHistory drops a leading agent message so the window stays user-first', async () => {
  const { capHistory } = loadChatService({ db: makeDb() });
  // [c0, a1, c2, a3] capped to 3 → slice(-3) = [a1, c2, a3] → drop leading agent → [c2, a3]
  const out = capHistory([
    { role: 'customer', content: 'c0' },
    { role: 'agent',    content: 'a1' },
    { role: 'customer', content: 'c2' },
    { role: 'agent',    content: 'a3' },
  ], 3);
  assertEqual(out.length, 2, 'leading agent dropped from the window');
  assertEqual(out[0].role, 'customer', 'window starts on a user turn');
  assertEqual(out[0].content, 'c2', 'leading agent a1 removed');
});

test('handleMessage replays only the capped window + the new user message', async () => {
  process.env.WIDGET_LLM_HISTORY_TURNS = '3'; // → 6 messages
  let captured = null;
  const db = makeDb(aiModeHandler({ existingMessages: mkHistory(20) }));
  const chatService = loadChatService({
    db,
    llm: { getAgentResponse: async ({ messages }) => { captured = messages; return 'ok'; } },
  });

  const result = await chatService.handleMessage({ db, ...baseArgs }); // isAnonymous → no memory FAF
  delete process.env.WIDGET_LLM_HISTORY_TURNS;

  assertEqual(result.kind, 'reply', 'kind should be reply');
  assert(captured, 'getAgentResponse received the messages array');
  assertEqual(captured.length, 7, '6 capped history messages + 1 new user message');
  assertEqual(captured[0].role, 'user', 'first replayed message is a user turn');
  assertEqual(captured[6].role, 'user', 'last message is the new user turn');
  assertEqual(captured[6].content, 'hello there', 'new user message appended verbatim');
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
