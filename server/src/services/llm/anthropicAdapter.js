/**
 * SHENMAY AI — Anthropic Provider Adapter
 *
 * Concrete LLM provider implementation for Anthropic Claude.
 *
 * Part of the Phase 1a multi-LLM refactor (see docs/MULTI_LLM_SCOPING.md).
 * This file holds the Anthropic-SDK-specific logic that previously lived
 * directly in llmService.js. The public surface in llmService.js dispatches
 * through here so adding a second provider (e.g. OpenAI) is purely additive
 * — no Anthropic codepath changes.
 *
 * Adapter contract:
 *   chat({ systemPrompt, messages, model, maxTokens, apiKey, tokenizer, breachCtx, logBreach })
 *     -> Promise<string>           // raw text (caller detokenizes)
 *
 *   chatWithTools({ systemPrompt, messages, tools, executor, model, maxTokens, apiKey,
 *                   tokenizer, breachCtx, logBreach })
 *     -> Promise<string>           // final text after tool loop (caller detokenizes)
 *
 *   validateKey(apiKey)
 *     -> Promise<{ valid: boolean, error?: string }>
 *
 *   defaultModel(role)             // role: 'sonnet' | 'haiku'
 *     -> string
 */

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const { BreachError } = require('../piiTokenizer');

const PROVIDER_NAME = 'anthropic';

// Cache Anthropic clients by API key hash to avoid re-creating
const _clientCache = new Map();

function getClient(apiKey) {
  if (!apiKey) throw new Error('No API key available');

  const cacheKey = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  if (_clientCache.has(cacheKey)) return _clientCache.get(cacheKey);

  const client = new Anthropic({ apiKey, timeout: 60000, maxRetries: 1 });
  _clientCache.set(cacheKey, client);
  return client;
}

// claude-sonnet-4-20250514 was retired by Anthropic on 2026-06-15, so every
// request to it fails. Sonnet 4.6 is the drop-in successor: same request and
// response shape, no thinking unless asked for. Keep both literals in sync
// with the LLM_*_MODEL fallbacks in both docker-compose files (a unit test
// checks this).
const DEFAULT_SONNET = 'claude-sonnet-4-6';
const DEFAULT_HAIKU  = 'claude-haiku-4-5-20251001';

// Retired IDs that can still arrive via env: every docker-compose.selfhosted.yml
// released before this fix sets LLM_SONNET_MODEL=claude-sonnet-4-20250514 as
// its `:-` fallback, and the documented upgrade (`docker compose pull && up -d`)
// keeps the customer's existing compose file. Treat them as unset instead of
// sending a dead model.
const RETIRED_MODELS = new Set(['claude-sonnet-4-20250514', 'claude-sonnet-4-0']);
const _retiredWarned = new Set();

function modelFromEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  if (RETIRED_MODELS.has(value)) {
    if (!_retiredWarned.has(name)) {
      _retiredWarned.add(name);
      console.warn(`[LLM] ${name}=${value} is a retired Anthropic model; using ${fallback} instead. An older docker-compose file sets this default: refresh it, or set ${name} in .env.`);
    }
    return fallback;
  }
  return value;
}

function defaultModel(role) {
  if (role === 'haiku') return modelFromEnv('LLM_HAIKU_MODEL', DEFAULT_HAIKU);
  return modelFromEnv('LLM_SONNET_MODEL', DEFAULT_SONNET);
}

/**
 * Concatenate the text blocks of a Messages API response. Don't read
 * content[0]: newer models can return a thinking block first (the Claude 5
 * generation thinks by default), and content[0].text would then be undefined,
 * i.e. an empty reply. For a single text block this returns it verbatim.
 */
function textFromContent(content) {
  return (content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/**
 * Single-turn chat (no tools). Tokenization happens here so the adapter
 * is the only thing that ever sees the raw provider SDK calls.
 */
async function chat({
  systemPrompt,
  messages,
  model,
  maxTokens = 1024,
  apiKey,
  tokenizer = null,
  breachCtx = null,
  logBreach = null,
}) {
  const client = getClient(apiKey);

  let sendSystem = systemPrompt;
  let sendMessages = messages;
  let tokenMap = null;

  if (tokenizer) {
    const sys = tokenizer.tokenize(systemPrompt);
    tokenMap = sys.map;
    sendSystem = sys.text;
    const msgs = tokenizer.tokenizeMessages(messages, tokenMap);
    sendMessages = msgs.messages;

    try {
      tokenizer.auditOutbound(sendSystem, sendMessages);
    } catch (err) {
      if (err instanceof BreachError) {
        if (logBreach) await logBreach({ ...(breachCtx || {}), findings: err.findings });
        throw err;
      }
      throw err;
    }
  }

  const response = await client.messages.create({
    model: model || defaultModel('sonnet'),
    max_tokens: maxTokens,
    system: sendSystem,
    messages: sendMessages,
  });

  const rawText = textFromContent(response.content);
  return tokenizer ? tokenizer.detokenize(rawText, tokenMap) : rawText;
}

/**
 * Multi-turn chat with tool-use. Runs the agentic loop up to MAX_TOOL_ROUNDS,
 * detokenizing tool inputs before calling the executor and re-tokenizing
 * the results before feeding them back to the model.
 */
async function chatWithTools({
  systemPrompt,
  messages,
  tools,
  executor,
  model,
  maxTokens = 2048,
  apiKey,
  tokenizer = null,
  breachCtx = null,
  logBreach = null,
}) {
  const client = getClient(apiKey);

  // Format tool definitions for Anthropic API
  const anthropicTools = tools.map(t => ({
    name:         t.name,
    description:  t.description,
    input_schema: t.inputSchema,
  }));

  let tokenMap = null;
  let sendSystem = systemPrompt;
  let currentMessages = [...messages];

  if (tokenizer) {
    const sys = tokenizer.tokenize(systemPrompt);
    tokenMap = sys.map;
    sendSystem = sys.text;
    const msgs = tokenizer.tokenizeMessages(currentMessages, tokenMap);
    currentMessages = msgs.messages;
  }

  const MAX_TOOL_ROUNDS = 6;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (tokenizer) {
      try {
        tokenizer.auditOutbound(sendSystem, currentMessages);
      } catch (err) {
        if (err instanceof BreachError) {
          if (logBreach) await logBreach({ ...(breachCtx || {}), findings: err.findings });
          throw err;
        }
        throw err;
      }
    }

    const response = await client.messages.create({
      model:      model || defaultModel('sonnet'),
      max_tokens: maxTokens,
      system:     sendSystem,
      messages:   currentMessages,
      tools:      anthropicTools,
    });

    const hasToolUse = response.content.some(b => b.type === 'tool_use');
    if (!hasToolUse || response.stop_reason === 'end_turn') {
      const textBlocks = response.content.filter(b => b.type === 'text');
      const joined = textBlocks.map(b => b.text).join('\n').trim();
      return tokenizer ? tokenizer.detokenize(joined, tokenMap) : joined;
    }

    currentMessages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      let execInput = block.input;
      if (tokenizer) {
        execInput = {};
        for (const [k, v] of Object.entries(block.input || {})) {
          execInput[k] = typeof v === 'string' ? tokenizer.detokenize(v, tokenMap) : v;
        }
      }

      console.log(`[LLM] Tool call: ${block.name}`);
      const result = await executor(block.name, execInput);
      let resultStr = JSON.stringify(result);

      if (tokenizer) {
        const tok = tokenizer.tokenize(resultStr, tokenMap);
        resultStr = tok.text;
      }

      toolResults.push({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     resultStr,
      });
    }

    currentMessages.push({ role: 'user', content: toolResults });
  }

  console.warn('[LLM] Tool loop hit max rounds — returning fallback response');
  return 'I was working through your question but ran into a processing limit. Could you rephrase or ask me to focus on one thing at a time?';
}

/**
 * Validate an API key by making a minimal test call.
 */
async function validateKey(apiKey) {
  try {
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: defaultModel('haiku'),
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say "ok"' }],
    });
    return { valid: true };
  } catch (err) {
    if (err.status === 401) {
      return { valid: false, error: 'Invalid API key. Please check and try again.' };
    }
    if (err.status === 403) {
      return { valid: false, error: 'API key does not have permission. Check your Anthropic account.' };
    }
    return { valid: false, error: err.message || 'Could not validate API key.' };
  }
}

module.exports = {
  PROVIDER_NAME,
  chat,
  chatWithTools,
  validateKey,
  defaultModel,
  // Exposed for tests only.
  _internal: { textFromContent },
};
