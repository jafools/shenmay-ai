/**
 * SHENMAY AI — OpenAI Adapter Schema Translation Tests
 *
 * Validates the Anthropic ↔ OpenAI message + tool-call shape conversion that
 * the OpenAI adapter does at the SDK boundary. These are the highest-variance
 * pieces of the multi-LLM v1 work — see Risk #1 in docs/MULTI_LLM_SCOPING.md.
 *
 * Run: NODE_ENV=test node tests/openai-adapter.test.js
 */

'use strict';

const path = require('path');
process.env.NODE_ENV = 'test';

const adapter = require(path.join(__dirname, '..', 'server', 'src', 'services', 'llm', 'openaiAdapter'));
const registry = require(path.join(__dirname, '..', 'server', 'src', 'services', 'llm'));

const { toOpenAIMessages, toOpenAITools, fromOpenAIResponseToContentBlocks } = adapter._internal;

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.log('  ✗', name);
    console.log('   ', err.message);
    failed++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'assertion failed'}\n    expected: ${e}\n    actual:   ${a}`);
}
function group(name, fn) { console.log(name); fn(); console.log(''); }


// ── Anthropic → OpenAI message shape ──────────────────────────────────────────
group('toOpenAIMessages', () => {
  test('System prompt becomes the first system message', () => {
    const out = toOpenAIMessages('You are helpful.', [
      { role: 'user', content: 'Hi' },
    ]);
    assertEqual(out[0], { role: 'system', content: 'You are helpful.' });
    assertEqual(out[1], { role: 'user', content: 'Hi' });
  });

  test('Empty system prompt is omitted (not sent as empty system message)', () => {
    const out = toOpenAIMessages('', [
      { role: 'user', content: 'Hi' },
    ]);
    assert(out[0].role === 'user', 'first message should be user (no leading system)');
    assert(out.length === 1, `expected 1 message, got ${out.length}`);
  });

  test('Plain user/assistant string-content messages pass through unchanged', () => {
    const out = toOpenAIMessages('S', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi back' },
    ]);
    assertEqual(out, [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi back' },
    ]);
  });

  test('Anthropic assistant tool_use block converts to OpenAI tool_calls array', () => {
    const out = toOpenAIMessages('', [
      { role: 'assistant', content: [
        { type: 'text', text: 'Looking up...' },
        { type: 'tool_use', id: 'tu_42', name: 'lookup', input: { customer_id: 'abc' } },
      ] },
    ]);
    assertEqual(out, [
      { role: 'assistant', content: 'Looking up...', tool_calls: [
        { id: 'tu_42', type: 'function', function: { name: 'lookup', arguments: '{"customer_id":"abc"}' } },
      ] },
    ]);
  });

  test('Assistant message with only tool_use (no text) → content:null', () => {
    const out = toOpenAIMessages('', [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_1', name: 'lookup', input: {} },
      ] },
    ]);
    assertEqual(out[0].content, null);
    assert(out[0].tool_calls.length === 1);
  });

  test('Anthropic tool_result blocks split into separate role:tool messages', () => {
    const out = toOpenAIMessages('', [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_42', content: '{"balance":1000}' },
      ] },
    ]);
    assertEqual(out, [
      { role: 'tool', tool_call_id: 'tu_42', content: '{"balance":1000}' },
    ]);
  });

  test('Multiple tool_results in one Anthropic user message → multiple role:tool messages', () => {
    const out = toOpenAIMessages('', [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_a', content: 'A' },
        { type: 'tool_result', tool_use_id: 'tu_b', content: 'B' },
      ] },
    ]);
    assert(out.length === 2);
    assert(out[0].role === 'tool' && out[0].tool_call_id === 'tu_a' && out[0].content === 'A');
    assert(out[1].role === 'tool' && out[1].tool_call_id === 'tu_b' && out[1].content === 'B');
  });

  test('Mixed user content (text + tool_result) keeps text as user, tool_result as role:tool', () => {
    const out = toOpenAIMessages('', [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'tool answer' },
        { type: 'text', text: 'thanks' },
      ] },
    ]);
    // Order in OpenAI: tool messages emitted first (as discovered), then user text.
    assert(out.some(m => m.role === 'tool' && m.content === 'tool answer'));
    assert(out.some(m => m.role === 'user' && m.content === 'thanks'));
  });

  test('Full agentic round-trip: user → assistant tool_use → user tool_result → assistant text', () => {
    const out = toOpenAIMessages('You help customers.', [
      { role: 'user', content: 'What is my balance?' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Looking up your balance now.' },
        { type: 'tool_use', id: 'tu_balance', name: 'get_balance', input: { customer_id: 'C123' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_balance', content: '{"amount":1234.56}' },
      ] },
      { role: 'assistant', content: 'Your balance is $1,234.56.' },
    ]);
    assert(out.length === 5, `expected 5 messages, got ${out.length}`);
    assert(out[0].role === 'system');
    assert(out[1].role === 'user' && out[1].content === 'What is my balance?');
    assert(out[2].role === 'assistant' && out[2].tool_calls.length === 1);
    assert(out[3].role === 'tool' && out[3].tool_call_id === 'tu_balance');
    assert(out[4].role === 'assistant' && out[4].content === 'Your balance is $1,234.56.');
  });
});


// ── Anthropic → OpenAI tool definitions ───────────────────────────────────────
group('toOpenAITools', () => {
  test('Wraps Shenmay tool def in {type:function, function:{...}}', () => {
    const out = toOpenAITools([
      { name: 'lookup_balance', description: 'Get a customer\'s balance',
        inputSchema: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] } },
    ]);
    assertEqual(out, [
      { type: 'function', function: {
        name: 'lookup_balance',
        description: 'Get a customer\'s balance',
        parameters: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] },
      } },
    ]);
  });

  test('Empty input schema (parameter-less tool) translates without loss', () => {
    const out = toOpenAITools([
      { name: 'ping', description: 'Health check', inputSchema: { type: 'object', properties: {} } },
    ]);
    assertEqual(out[0].function.parameters, { type: 'object', properties: {} });
  });
});


// ── OpenAI response → Anthropic content blocks (reverse direction) ────────────
group('fromOpenAIResponseToContentBlocks', () => {
  test('Plain text response becomes a single text block', () => {
    const blocks = fromOpenAIResponseToContentBlocks({ content: 'Hello there', tool_calls: undefined });
    assertEqual(blocks, [{ type: 'text', text: 'Hello there' }]);
  });

  test('Empty content + tool_calls produces tool_use blocks only', () => {
    const blocks = fromOpenAIResponseToContentBlocks({
      content: null,
      tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'foo', arguments: '{"x":1}' } },
      ],
    });
    assertEqual(blocks, [
      { type: 'tool_use', id: 'tc_1', name: 'foo', input: { x: 1 } },
    ]);
  });

  test('Text + tool_calls produces both block types in order', () => {
    const blocks = fromOpenAIResponseToContentBlocks({
      content: 'Let me look that up.',
      tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'lookup', arguments: '{"id":"abc"}' } },
      ],
    });
    assertEqual(blocks, [
      { type: 'text', text: 'Let me look that up.' },
      { type: 'tool_use', id: 'tc_1', name: 'lookup', input: { id: 'abc' } },
    ]);
  });

  test('Malformed JSON arguments degrade to empty object (no throw)', () => {
    // Suppress the warn during this test to keep output clean
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const blocks = fromOpenAIResponseToContentBlocks({
        content: '',
        tool_calls: [
          { id: 'tc_bad', type: 'function', function: { name: 'foo', arguments: 'not-json{' } },
        ],
      });
      assertEqual(blocks, [
        { type: 'tool_use', id: 'tc_bad', name: 'foo', input: {} },
      ]);
    } finally {
      console.warn = origWarn;
    }
  });

  test('Multiple tool_calls all become tool_use blocks', () => {
    const blocks = fromOpenAIResponseToContentBlocks({
      content: '',
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 't2', type: 'function', function: { name: 'b', arguments: '{"k":"v"}' } },
      ],
    });
    assert(blocks.length === 2);
    assert(blocks[0].name === 'a' && blocks[1].name === 'b');
  });
});


// ── Provider registry ─────────────────────────────────────────────────────────
group('Registry + normalizeProvider', () => {
  test('listProviders includes both anthropic and openai', () => {
    const list = registry.listProviders().sort();
    assertEqual(list, ['anthropic', 'openai']);
  });

  test('normalizeProvider canonicalizes anthropic spellings', () => {
    assert(registry.normalizeProvider('claude') === 'anthropic');
    assert(registry.normalizeProvider('Claude') === 'anthropic');
    assert(registry.normalizeProvider('anthropic') === 'anthropic');
    assert(registry.normalizeProvider('Anthropic') === 'anthropic');
  });

  test('normalizeProvider canonicalizes openai spellings', () => {
    assert(registry.normalizeProvider('openai') === 'openai');
    assert(registry.normalizeProvider('OpenAI') === 'openai');
    assert(registry.normalizeProvider('OPEN-AI') === 'openai');
    assert(registry.normalizeProvider('gpt') === 'openai');
    assert(registry.normalizeProvider('GPT') === 'openai');
  });

  test('normalizeProvider leaves unknown values pass-through (lowercased)', () => {
    assert(registry.normalizeProvider('gemini') === 'gemini');
    assert(registry.normalizeProvider('mock') === 'mock');
  });

  test('getAdapter returns the right adapter for each canonical name', () => {
    assert(registry.getAdapter('claude').PROVIDER_NAME === 'anthropic');
    assert(registry.getAdapter('anthropic').PROVIDER_NAME === 'anthropic');
    assert(registry.getAdapter('openai').PROVIDER_NAME === 'openai');
    assert(registry.getAdapter('GPT').PROVIDER_NAME === 'openai');
  });

  test('getAdapter throws on unknown provider', () => {
    let threw = false;
    try { registry.getAdapter('palm'); } catch (e) { threw = true; }
    assert(threw, 'expected throw on unknown provider');
  });
});


// ── Default model picker ──────────────────────────────────────────────────────
group('Adapter defaultModel', () => {
  test('Anthropic adapter defaults to Claude Sonnet/Haiku', () => {
    const a = registry.getAdapter('anthropic');
    assert(a.defaultModel('sonnet').startsWith('claude-'));
    assert(a.defaultModel('haiku').startsWith('claude-'));
  });

  test('OpenAI adapter defaults to gpt-4o / gpt-4o-mini', () => {
    const o = registry.getAdapter('openai');
    assert(o.defaultModel('sonnet').startsWith('gpt-4o'));
    assert(o.defaultModel('haiku') === 'gpt-4o-mini');
  });
});


// ── Registry-level getDefaultModel (regression test for v3.4.0 wire bug) ─────
// `tenants.llm_model` is set at signup time with the Anthropic default and
// never updated when the tenant later switches provider — so the column
// can hold a Claude name while `llm_provider='openai'`. Dispatch sites
// must call getDefaultModel(provider) and ignore the stored column.
group('getDefaultModel(provider, role)', () => {
  test('Anthropic provider resolves to a Claude model', () => {
    assert(registry.getDefaultModel('anthropic', 'sonnet').startsWith('claude-'));
    assert(registry.getDefaultModel('anthropic', 'haiku').startsWith('claude-'));
  });

  test('OpenAI provider resolves to a GPT model regardless of stored llm_model', () => {
    assert(registry.getDefaultModel('openai', 'sonnet').startsWith('gpt-4o'));
    assert(registry.getDefaultModel('openai', 'haiku') === 'gpt-4o-mini');
  });

  test('Legacy "claude" provider name normalizes to anthropic', () => {
    assert(registry.getDefaultModel('claude', 'sonnet').startsWith('claude-'));
  });

  test('Default role is sonnet', () => {
    assertEqual(
      registry.getDefaultModel('openai'),
      registry.getDefaultModel('openai', 'sonnet')
    );
  });

  test('Throws for unknown provider', () => {
    let threw = false;
    try { registry.getDefaultModel('palm'); } catch (e) { threw = true; }
    assert(threw, 'expected throw on unknown provider');
  });
});


// ── Anthropic defaults + response parsing ─────────────────────────────────────
// claude-sonnet-4-20250514 (the old Sonnet default) was retired by Anthropic on
// 2026-06-15, so every chat failed out of the box. Pin the replacement and keep
// the docker-compose `:-` fallbacks in lockstep: compose passes its fallback
// into the container, so a stale compose default silently overrides the code.
group('Anthropic adapter defaults + response parsing', () => {
  const anthropic = registry.getAdapter('anthropic');
  const { textFromContent } = anthropic._internal;

  test('Sonnet default is claude-sonnet-4-6 when LLM_SONNET_MODEL is unset', () => {
    const saved = process.env.LLM_SONNET_MODEL;
    delete process.env.LLM_SONNET_MODEL;
    try {
      assertEqual(anthropic.defaultModel('sonnet'), 'claude-sonnet-4-6');
    } finally {
      if (saved !== undefined) process.env.LLM_SONNET_MODEL = saved;
    }
  });

  test('A retired Sonnet ID arriving via env (old compose fallback) is replaced', () => {
    // Every released docker-compose.selfhosted.yml injects the retired ID, and
    // the documented upgrade keeps the customer's compose file.
    const saved = process.env.LLM_SONNET_MODEL;
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const retired of ['claude-sonnet-4-20250514', 'claude-sonnet-4-0']) {
        process.env.LLM_SONNET_MODEL = retired;
        assertEqual(anthropic.defaultModel('sonnet'), 'claude-sonnet-4-6', `${retired} must be remapped`);
        assertEqual(registry.getDefaultModel('claude', 'sonnet'), 'claude-sonnet-4-6', `${retired} via the registry`);
      }
      process.env.LLM_SONNET_MODEL = 'claude-sonnet-5-5';
      assertEqual(anthropic.defaultModel('sonnet'), 'claude-sonnet-5-5', 'a current model ID passes through');
    } finally {
      console.warn = warn;
      if (saved === undefined) delete process.env.LLM_SONNET_MODEL; else process.env.LLM_SONNET_MODEL = saved;
    }
  });

  test('docker-compose model fallbacks match the adapter defaults', () => {
    const fs = require('fs');
    const savedS = process.env.LLM_SONNET_MODEL;
    const savedH = process.env.LLM_HAIKU_MODEL;
    delete process.env.LLM_SONNET_MODEL;
    delete process.env.LLM_HAIKU_MODEL;
    try {
      for (const file of ['docker-compose.yml', 'docker-compose.selfhosted.yml']) {
        const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        const sonnet = (src.match(/LLM_SONNET_MODEL:\s*\$\{LLM_SONNET_MODEL:-([^}]+)\}/) || [])[1];
        const haiku  = (src.match(/LLM_HAIKU_MODEL:\s*\$\{LLM_HAIKU_MODEL:-([^}]+)\}/) || [])[1];
        assertEqual(sonnet, anthropic.defaultModel('sonnet'), `${file} LLM_SONNET_MODEL fallback`);
        assertEqual(haiku, anthropic.defaultModel('haiku'), `${file} LLM_HAIKU_MODEL fallback`);
      }
    } finally {
      if (savedS !== undefined) process.env.LLM_SONNET_MODEL = savedS;
      if (savedH !== undefined) process.env.LLM_HAIKU_MODEL = savedH;
    }
  });

  test('textFromContent skips a leading thinking block', () => {
    assertEqual(textFromContent([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Hello there' },
    ]), 'Hello there');
  });

  test('textFromContent returns a single text block verbatim', () => {
    assertEqual(textFromContent([{ type: 'text', text: '  Hi  ' }]), '  Hi  ');
  });

  test('textFromContent of an empty response is an empty string', () => {
    assertEqual(textFromContent([]), '');
    assertEqual(textFromContent(undefined), '');
  });
});


console.log('');
console.log(`== Results: ${passed} passed, ${failed} failed ==`);
process.exit(failed === 0 ? 0 : 1);
