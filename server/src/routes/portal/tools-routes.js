/**
 * SHENMAY AI — Tenant Portal: Custom Tools (self-service tool builder)
 *
 * Sub-router mounted by ../portal.js at `/api/portal/tools`.
 * All requests have already passed `requirePortalAuth` (set by the parent),
 * so `req.portal` is populated.
 *
 *   GET    /api/portal/tools/types           — reference data for the builder UI
 *   GET    /api/portal/tools                 — list all custom tools for this tenant
 *   POST   /api/portal/tools                 — create a custom tool
 *   PATCH  /api/portal/tools/:toolId         — update
 *   DELETE /api/portal/tools/:toolId         — soft-delete (is_active=false)
 *   POST   /api/portal/tools/:toolId/test    — sandbox / real-customer test run
 *
 * All routes scoped to the authenticated tenant (req.portal.tenant_id).
 */

const router = require('express').Router();
const db = require('../../db');

const {
  callClaudeWithTools, resolveApiKey, buildTokenizer,
} = require('../../services/llmService');
const { getDefaultModel } = require('../../services/llm');
const { toToolDefinition }     = require('../../tools/customToolLoader');
const { handleCustomTool }     = require('../../tools/custom_tool_handler');
const { incrementMessageCount } = require('../../middleware/subscription');
const { safeDecryptJson }      = require('../../services/cryptoService');
const { BreachError }          = require('../../services/piiTokenizer');
const { validateWebhookUrl }   = require('../../utils/validateWebhookUrl');

const VALID_TOOL_TYPES   = ['lookup', 'calculate', 'report', 'escalate', 'connect'];
const TOOL_NAME_PATTERN  = /^[a-z][a-z0-9_]{1,63}$/;

// GET /api/portal/tools/types — reference data for the builder UI form
router.get('/types', (req, res) => {
  res.json({
    tool_types: [
      {
        type:    'lookup',
        label:   'Look Up Client Data',
        emoji:   '🔍',
        tagline: 'Your AI searches your records automatically',
        explanation: 'When a client asks a question, your AI will look up their actual records and answer based on real data — not guesswork.',
        example: 'Use when a client asks about their account, balance, history, or any information you have on file.',
        config_fields: [
          { key: 'data_category', label: 'Which category of data?', type: 'text', required: true,
            placeholder: 'e.g. investments, orders, case_notes, policies' },
        ],
      },
      {
        type:    'calculate',
        label:   'Calculate a Value',
        emoji:   '📊',
        tagline: 'Your AI does the maths from your data',
        explanation: 'Your AI will add up, average, or count values from your records and give the client an instant answer.',
        example: 'Use when a client asks "What is my total?" or "How many...?" or "What is the average...?"',
        config_fields: [
          { key: 'data_category', label: 'Which category of data?', type: 'text', required: true,
            placeholder: 'e.g. expenses, sales, donations, transactions' },
          { key: 'metric', label: 'What to calculate', type: 'select', required: false,
            options: [
              { value: 'total',   label: 'Total (add everything up)' },
              { value: 'average', label: 'Average (typical value)' },
              { value: 'count',   label: 'Count (how many records)' },
            ],
            default: 'total' },
        ],
      },
      {
        type:    'report',
        label:   'Generate a Report',
        emoji:   '📄',
        tagline: 'Your AI writes a formatted summary',
        explanation: 'Your AI creates a clear, structured written report that the client can read and save — based on everything it knows about them.',
        example: 'Use when a client asks for a summary, an overview, or something "in writing".',
        config_fields: [
          { key: 'report_type', label: 'What kind of report?', type: 'select', required: false,
            options: [
              { value: 'summary',  label: 'Summary (short overview)' },
              { value: 'detailed', label: 'Detailed (full breakdown)' },
            ],
            default: 'summary' },
          { key: 'template_hint', label: 'What should the report focus on? (optional)', type: 'text', required: false,
            placeholder: 'e.g. retirement readiness, account health, case progress' },
        ],
      },
      {
        type:    'escalate',
        label:   'Get a Human Involved',
        emoji:   '🙋',
        tagline: 'Your AI knows when to call in your team',
        explanation: 'When a conversation needs a real person, your AI flags it immediately and lets your team know — so no client ever falls through the cracks.',
        example: 'Use when a client asks a complex question, requests a meeting, or needs personalised advice beyond your AI\'s scope.',
        config_fields: [
          { key: 'urgency',    label: 'How urgent is this?', type: 'select', required: false,
            options: [
              { value: 'low',    label: 'Low — flag it, team will pick it up' },
              { value: 'medium', label: 'Medium — needs attention today' },
              { value: 'high',   label: 'High — escalate immediately' },
            ],
            default: 'medium' },
          { key: 'department', label: 'Which team handles this? (optional)', type: 'text', required: false,
            placeholder: 'e.g. Financial Advisor, Case Manager, Support Team' },
        ],
      },
      {
        type:    'connect',
        label:   'Connect Your Own System',
        emoji:   '🔗',
        tagline: 'Your AI fetches live data from your own servers',
        explanation: 'When your AI needs information, it calls your own API or system in real time. Your data never leaves your servers — Shenmay just asks for what it needs.',
        example: 'Use when you have an internal API, CRM, or database that your IT team can expose via a URL.',
        config_fields: [
          { key: 'webhook_url', label: 'Your system URL (endpoint)', type: 'text', required: true,
            placeholder: 'https://api.yourcompany.com/client-data' },
          { key: 'method', label: 'Request method', type: 'select', required: false,
            options: [
              { value: 'POST', label: 'POST (recommended)' },
              { value: 'GET',  label: 'GET' },
            ],
            default: 'POST' },
          { key: 'auth_type', label: 'How should Shenmay authenticate to your system?', type: 'select', required: false,
            options: [
              { value: 'none',    label: 'No authentication' },
              { value: 'bearer',  label: 'Bearer token (most common)' },
              { value: 'api_key', label: 'Custom API key header' },
            ],
            default: 'none' },
          // auth_token and auth_header_name are rendered conditionally by the UI
          // based on auth_type — they are not declared as fields here so they
          // don't appear as generic text inputs
        ],
      },
    ],
  });
});

// GET /api/portal/tools — list all custom tools for this tenant
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, display_name, tool_type, trigger_description, config, is_active, created_at
       FROM custom_tools
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [req.portal.tenant_id]
    );
    res.json({ tools: rows });
  } catch (err) { next(err); }
});

// POST /api/portal/tools — create a custom tool
router.post('/', async (req, res, next) => {
  try {
    const { name, display_name, tool_type, trigger_description, config = {} } = req.body;

    if (!name || !display_name || !tool_type || !trigger_description) {
      return res.status(400).json({ error: 'name, display_name, tool_type, and trigger_description are required' });
    }
    if (!TOOL_NAME_PATTERN.test(name)) {
      return res.status(400).json({ error: 'Tool name must start with a letter, use only lowercase letters/numbers/underscores, max 64 chars' });
    }
    if (!VALID_TOOL_TYPES.includes(tool_type)) {
      return res.status(400).json({ error: `tool_type must be one of: ${VALID_TOOL_TYPES.join(', ')}` });
    }
    if (tool_type === 'connect') {
      if (!config.webhook_url) {
        return res.status(400).json({ error: 'connect tools require a webhook_url in config' });
      }
      // SSRF guard — same check the tenant-webhook / Slack / Teams surfaces use.
      const urlErr = validateWebhookUrl(config.webhook_url);
      if (urlErr) return res.status(400).json({ error: `Webhook URL: ${urlErr}` });
    }
    if (['lookup', 'calculate'].includes(tool_type) && !config.data_category) {
      return res.status(400).json({ error: `${tool_type} tools require a data_category in config` });
    }

    const { rows } = await db.query(
      `INSERT INTO custom_tools (tenant_id, name, display_name, tool_type, trigger_description, config)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.portal.tenant_id, name, display_name, tool_type, trigger_description, JSON.stringify(config)]
    );
    res.status(201).json({ tool: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `A tool named "${req.body.name}" already exists` });
    next(err);
  }
});

// PATCH /api/portal/tools/:toolId — update a custom tool
router.patch('/:toolId', async (req, res, next) => {
  try {
    const allowed = ['display_name', 'trigger_description', 'config', 'is_active'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }
    // SSRF guard — whenever a config with a webhook_url is being written
    // (connect tools), re-validate it just like create-time. config may
    // arrive as an object (normal) or a JSON string (defensive parse).
    if (updates.config !== undefined) {
      let cfg = updates.config;
      if (typeof cfg === 'string') {
        try { cfg = JSON.parse(cfg); } catch { cfg = {}; }
      }
      const webhookUrl = cfg && typeof cfg === 'object' ? cfg.webhook_url : undefined;
      if (webhookUrl) {
        const urlErr = validateWebhookUrl(webhookUrl);
        if (urlErr) return res.status(400).json({ error: `Webhook URL: ${urlErr}` });
      }
    }
    const setClauses = Object.keys(updates).map((key, i) => `${key} = $${i + 3}`);
    const values = [req.params.toolId, req.portal.tenant_id, ...Object.values(updates)];
    const { rows } = await db.query(
      `UPDATE custom_tools SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Tool not found' });
    res.json({ tool: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/portal/tools/:toolId — soft-delete (deactivate)
router.delete('/:toolId', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE custom_tools SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 RETURNING id, display_name`,
      [req.params.toolId, req.portal.tenant_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Tool not found' });
    res.json({ ok: true, message: `"${rows[0].display_name}" removed` });
  } catch (err) { next(err); }
});

// ── POST /api/portal/tools/:toolId/test ───────────────────────────────────
//
// Sandbox dry-run for a custom tool. Sends a sample customer message to Claude
// with ONLY this one tool available, then returns:
//   { invoked, tool_input, tool_result, ai_response, sandbox }
//
// Sandbox rules:
//   lookup / calculate / connect → execute for real (no customer_data in sandbox
//     so lookup/calculate return "no data found" gracefully; connect fires the webhook)
//   report / escalate → simulated — no real DB writes, no emails, no flags created
//
// This IS a real LLM call and counts against the tenant's message quota.
//
router.post('/:toolId/test', async (req, res, next) => {
  try {
    const { message, customer_id } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    // 1. Load the tool (must belong to this tenant)
    const { rows: toolRows } = await db.query(
      `SELECT id, tenant_id, name, display_name, tool_type, trigger_description, config
       FROM custom_tools
       WHERE id = $1 AND tenant_id = $2`,
      [req.params.toolId, req.portal.tenant_id]
    );
    if (toolRows.length === 0) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    const toolRow = toolRows[0];

    // 2. Load tenant for API key resolution
    const { rows: tenantRows } = await db.query(
      `SELECT t.id, t.name, t.agent_name, t.llm_model, t.llm_provider, s.managed_ai_enabled,
              t.llm_api_key_encrypted, t.llm_api_key_iv, t.llm_api_key_validated
       FROM tenants t
       JOIN subscriptions s ON s.tenant_id = t.id
       WHERE t.id = $1`,
      [req.portal.tenant_id]
    );
    const tenant = tenantRows[0];
    const apiKey = resolveApiKey(tenant);
    if (!apiKey) {
      return res.status(402).json({ error: 'No API key configured — add your Anthropic key in Settings.' });
    }

    // 3. Resolve test context — sandbox (no customer) OR real customer
    let testCustomer   = { first_name: 'Test', last_name: 'User', email: 'sandbox@test.example' };
    let testCustomerId = null;
    let usingRealCustomer = false;

    if (customer_id) {
      const { rows: custRows } = await db.query(
        `SELECT id, first_name, last_name, email, soul_file, memory_file
         FROM customers
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [customer_id, req.portal.tenant_id]
      );
      if (custRows.length === 0) {
        return res.status(404).json({ error: 'Customer not found' });
      }
      const c = custRows[0];
      c.soul_file   = safeDecryptJson(c.soul_file);
      c.memory_file = safeDecryptJson(c.memory_file);
      testCustomer      = c;
      testCustomerId    = c.id;
      usingRealCustomer = true;
    }

    // 4. Build system prompt — richer when a real customer is selected
    const agentName = tenant.agent_name || 'Shenmay';
    const customerName = `${testCustomer.first_name} ${testCustomer.last_name}`.trim();
    const systemPromptLines = [
      `You are ${agentName}, a helpful AI assistant. This is a TEST RUN by an operator.`,
      ``,
      `You have access to one tool: "${toolRow.display_name}".`,
      `Tool trigger description: ${toolRow.trigger_description}`,
      ``,
      `Respond naturally to the customer message. If the message would logically trigger`,
      `the "${toolRow.display_name}" tool, use it. Otherwise respond without using it.`,
    ];

    if (usingRealCustomer) {
      const soul = testCustomer.soul_file || {};
      systemPromptLines.push(``);
      systemPromptLines.push(`You are speaking with ${customerName} (${testCustomer.email}).`);
      if (soul.customer_name) systemPromptLines.push(`They go by: ${soul.customer_name}.`);
      if (soul.background)    systemPromptLines.push(`Background: ${soul.background}`);
    } else {
      systemPromptLines.push(``);
      systemPromptLines.push(`Note: No real customer data exists — data tools will return empty results.`);
    }

    const systemPrompt = systemPromptLines.join('\n');

    // 5. Build execution context and tool executor
    const toolContext = {
      db,
      tenantId:       req.portal.tenant_id,
      customerId:     testCustomerId,
      conversationId: null,
      customer:       testCustomer,
      tenant,
    };

    const invocations = [];

    const testExecutor = async (toolName, params) => {
      let result;
      let simulated = false;

      // escalate always simulated — never create real flags or send emails in test mode
      if (toolRow.tool_type === 'escalate') {
        simulated = true;
        result = {
          sandbox:   true,
          simulated: true,
          message:   `[Test] "${toolRow.display_name}" would escalate this conversation. ` +
                     `No flag was created and no notification was sent.`,
          params,
        };
      } else {
        // lookup, calculate, report, connect — execute for real
        // report: writes a lightweight customer_data log record (safe for test customers)
        // connect: fires the real webhook (intended behaviour for connection testing)
        result = await handleCustomTool(toolRow, params, toolContext);
      }

      invocations.push({ tool_name: toolName, input: params, result, simulated });
      return result;
    };

    // 6. One real Claude call with only this tool available.
    // Tokenize PII before egress: with a real customer selected, this path bakes
    // their name/email/background into the system prompt and the tool executor
    // returns real customer_data. Attach the tokenizer + breach guard so the
    // operator's pii_tokenization preference holds here too — every other egress
    // (chat, ai-map, products) already does; /test was the lone gap.
    const tokenizer = buildTokenizer({
      tenant,
      memoryFile: usingRealCustomer ? testCustomer.memory_file : null,
      soulFile:   usingRealCustomer ? testCustomer.soul_file   : null,
    });

    const toolDefs = [toToolDefinition(toolRow)];
    let aiResponse;
    try {
      aiResponse = await callClaudeWithTools(
        systemPrompt,
        [{ role: 'user', content: message.trim() }],
        toolDefs,
        testExecutor,
        getDefaultModel(tenant.llm_provider, 'sonnet'),
        1024,
        apiKey,
        {
          tokenizer,
          breachCtx: { tenantId: req.portal.tenant_id, customerId: testCustomerId, callSite: 'tool_test' },
          provider:  tenant.llm_provider,
        }
      );
    } catch (llmErr) {
      if (llmErr instanceof BreachError) {
        return res.status(422).json({
          error: 'The selected customer\'s data tripped our outbound PII safety check. Run the test against a sandbox (no customer), or pick a customer with less sensitive data.',
          blocked_by_pii_guard: true,
        });
      }
      return res.status(502).json({ error: `LLM error: ${llmErr.message}` });
    }

    // 7. Count against quota (real API call)
    try { await incrementMessageCount(req.portal.tenant_id); } catch (_) {}

    const firstInvocation = invocations[0] || null;
    return res.json({
      invoked:           invocations.length > 0,
      invocation_count:  invocations.length,
      tool_input:        firstInvocation?.input    || null,
      tool_result:       firstInvocation?.result   || null,
      ai_response:       aiResponse,
      sandbox:           !usingRealCustomer,
      simulated:         firstInvocation?.simulated || false,
      test_customer:     usingRealCustomer
        ? { id: testCustomerId, name: customerName, email: testCustomer.email }
        : null,
    });

  } catch (err) { next(err); }
});

module.exports = router;
