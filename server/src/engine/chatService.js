/**
 * SHENMAY AI — Chat Service (widget /chat orchestration engine)
 *
 * Extracted from the 437-line POST /api/widget/chat handler (audit finding M8
 * / task T11b) so the live-chat hot path — every customer message flows through
 * it — is unit-testable in isolation for the first time.
 *
 * The route (routes/widget.js) stays a thin shell: auth + rate-limit
 * middleware, body sanitization, and mapping handleMessage()'s discriminated
 * result onto `res`. Everything below the sanitized-message boundary lives
 * here.
 *
 * This is a behavior-preserving RELOCATION of the prior inline handler — same
 * DB-write ordering, same fire-and-forget email/notification/memory fan-out,
 * same 3-way LLM error taxonomy (BreachError / NoApiKeyError are swallowed and
 * produce a safe customer-facing reply; every other LLM error is rethrown so
 * the route's outer catch maps it to next(err) → 500).
 *
 * `db` is injected as a parameter rather than require()'d at module top, so
 * unit tests can pass an in-memory fake (no Postgres) — matching the modern
 * engine-module convention (cf. memoryUpdater.updateMemoryAfterExchange).
 */

'use strict';

const { buildSystemPrompt } = require('./promptBuilder');
const {
  getAgentResponse,
  callClaudeWithTools,
  sanitiseResponse,
  resolveApiKey,
  buildTokenizer,
  NoApiKeyError,
} = require('../services/llmService');
const { getDefaultModel } = require('../services/llm');
const { BreachError } = require('../services/piiTokenizer');
const { updateMemoryAfterExchange } = require('./memoryUpdater');
const { getToolDefinitions } = require('../tools/registry');
const { execute: executeTool } = require('../tools/executor');
const {
  loadCustomTools,
  toToolDefinition,
  buildCustomExecutor,
  buildCombinedExecutor,
} = require('../tools/customToolLoader');
const { incrementMessageCount } = require('../middleware/subscription');
const { sendHumanModeReplyEmail } = require('../services/emailService');
const { safeDecryptJson } = require('../services/cryptoService');
const { NOTIFICATION_TYPES } = require('../config/plans');
const { isAnonVisitorEmail } = require('../constants/anonDomains');
const { renderBrandSoulForPrompt } = require('../services/brandLearning');

// ── In-app notification helper ─────────────────────────────────────────────
// Fire-and-forget. Errors are swallowed so they never interrupt the request.
// Formerly inlined in routes/widget.js where it closed over the module-level
// `db`; here it takes `db` explicitly because this module receives its pool as
// a parameter rather than requiring it at module top.
async function createNotification(db, tenantId, { type, title, body, resourceType, resourceId, customerName }) {
  try {
    await db.query(
      `INSERT INTO notifications
         (tenant_id, type, title, body, resource_type, resource_id, customer_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, type, title, body || null, resourceType || null, resourceId || null, customerName || null]
    );
  } catch (err) {
    console.error('[Notifications] Insert failed:', err.message);
  }
}

/**
 * Orchestrate one widget chat turn.
 *
 * @param {Object}  args
 * @param {Object}  args.db               pg pool/client (injected — testable)
 * @param {string}  args.tenantId         from req.widgetSession.tenant_id
 * @param {string}  args.customerId       from req.widgetSession.customer_id
 * @param {string}  args.conversationId   from req.widgetSession.conversation_id
 * @param {boolean} args.isAnonymous      from req.widgetSession.is_anonymous
 * @param {boolean} args.managedAiEnabled from req.subscription?.managed_ai_enabled
 * @param {string}  args.content          already-sanitized message text
 * @returns {Promise<Object>} a discriminated result the route maps onto res:
 *   { kind: 'not_found' }                                              → 404
 *   { kind: 'human', role, content: null, waiting: true, mode: 'human' } → 200
 *   { kind: 'reply', role, content, conversation_id }                  → 200
 * @throws the original LLM error for non-breach / non-no-key failures so the
 *   route's outer catch reaches next(err) → 500, exactly as the inline handler.
 */
async function handleMessage({ db, tenantId, customerId, conversationId, isAnonymous, managedAiEnabled, content }) {
  // Preserve the prior handler's local names so the body below is a verbatim
  // move (these were destructured from req.widgetSession / req.subscription).
  const tenant_id = tenantId;
  const customer_id = customerId;
  const conversation_id = conversationId;
  const sanitized = content;

  // 0. Check if conversation is in human mode — if so, save message and return waiting signal
  const { rows: modeRows } = await db.query(
    'SELECT mode FROM conversations WHERE id = $1',
    [conversation_id]
  );
  if (modeRows.length > 0 && modeRows[0].mode === 'human') {
    // Persist the user message but don't call AI
    await db.query(
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [conversation_id, 'customer', sanitized]
    );
    // Mark conversation as unread so dashboard badge updates
    await db.query(
      'UPDATE conversations SET unread = TRUE WHERE id = $1',
      [conversation_id]
    );
    await db.query(
      'UPDATE customers SET last_interaction_at = NOW() WHERE id = $1',
      [customer_id]
    );

    // Notify the assigned human agent (or all tenant admins) by email — fire-and-forget
    setImmediate(async () => {
      try {
        // Look up customer + assigned agent info + tenant email template settings
        const { rows: notifyRows } = await db.query(
          `SELECT
             cu.first_name AS cust_first, cu.last_name AS cust_last, cu.email AS cust_email,
             co.human_agent_id,
             a.email AS agent_email, a.first_name AS agent_first, a.last_name AS agent_last,
             t.email_from_name, t.email_reply_to, t.email_footer
           FROM conversations co
           JOIN customers cu ON co.customer_id = cu.id
           JOIN tenants t ON t.id = $1
           LEFT JOIN tenant_admins a ON a.id = co.human_agent_id
           WHERE co.id = $2`,
          [tenant_id, conversation_id]
        );
        if (notifyRows.length === 0) return;
        const row = notifyRows[0];
        const customerName = [row.cust_first, row.cust_last].filter(Boolean).join(' ') || 'Customer';
        const tenantEmail = { email_from_name: row.email_from_name, email_reply_to: row.email_reply_to, email_footer: row.email_footer };

        // Fire-and-forget — the customer's widget POST is waiting on this
        // handler; SMTP latency must not block their chat message ack.
        // The in-app notification below ensures the advisor sees the reply
        // even if email delivery is delayed or fails outright.
        if (row.agent_email) {
          // Notify the specific agent who took over
          sendHumanModeReplyEmail({
            to: row.agent_email,
            agentName:    [row.agent_first, row.agent_last].filter(Boolean).join(' '),
            customerName,
            customerEmail: row.cust_email,
            messageSnippet: sanitized,
            conversationId: conversation_id,
            tenantEmail,
          }).catch(err => console.error('[Widget] Human-mode reply email failed:', err.message));
        } else {
          // No specific agent assigned — notify all tenant admins
          const { rows: adminRows } = await db.query(
            `SELECT email, first_name FROM tenant_admins WHERE tenant_id = $1 AND role = 'admin' LIMIT 5`,
            [tenant_id]
          );
          for (const admin of adminRows) {
            sendHumanModeReplyEmail({
              to: admin.email,
              agentName:    admin.first_name,
              customerName,
              customerEmail: row.cust_email,
              messageSnippet: sanitized,
              conversationId: conversation_id,
              tenantEmail,
            }).catch(err => console.error('[Widget] Human-mode reply email failed:', err.message));
          }
        }
        // In-app notification so advisor sees the reply even if email is delayed
        createNotification(db, tenant_id, {
          type:         NOTIFICATION_TYPES.HUMAN_REPLY,
          title:        `${customerName} replied`,
          body:         sanitized.slice(0, 120),
          resourceType: 'conversation',
          resourceId:   conversation_id,
          customerName,
        });
      } catch (err) {
        console.error('[Widget] Failed to send human mode reply notification:', err.message);
      }
    });

    return { kind: 'human', role: 'agent', content: null, waiting: true, mode: 'human' };
  }

  // 1. Load tenant + customer data (including API key fields for BYOK)
  const { rows: convRows } = await db.query(
    `SELECT
       c.id as customer_id, c.first_name, c.last_name, c.email,
       c.soul_file, c.memory_file,
       c.onboarding_status, c.onboarding_categories_completed,
       t.id as tenant_id, t.name as tenant_name, t.agent_name,
       t.vertical, t.vertical_config,
       t.compliance_config, t.base_soul_template,
       t.llm_provider, t.llm_model, t.website_url,
       t.llm_api_key_encrypted, t.llm_api_key_iv, t.llm_api_key_validated,
       t.enabled_tools, t.tool_configs,
       t.pii_tokenization_enabled,
       t.brand_learning_enabled, t.brand_soul
     FROM customers c
     JOIN tenants t ON c.tenant_id = t.id
     WHERE c.id = $1 AND t.id = $2`,
    [customer_id, tenant_id]
  );

  if (convRows.length === 0) {
    return { kind: 'not_found' };
  }

  const conv = convRows[0];
  // Decrypt encrypted columns after read
  conv.soul_file   = safeDecryptJson(conv.soul_file);
  conv.memory_file = safeDecryptJson(conv.memory_file);

  // 2. Load customer data + tenant products in parallel
  const [{ rows: customerData }, { rows: products }] = await Promise.all([
    db.query('SELECT * FROM customer_data WHERE customer_id = $1', [customer_id]),
    db.query('SELECT name, description, category, price_info, notes FROM tenant_products WHERE tenant_id = $1 ORDER BY sort_order, created_at', [tenant_id]),
  ]);

  // 3. Load message history + handback note for this conversation
  const [{ rows: existingMessages }, { rows: convMeta }] = await Promise.all([
    db.query('SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC', [conversation_id]),
    db.query('SELECT handback_note FROM conversations WHERE id = $1', [conversation_id]),
  ]);
  const handbackNote = convMeta[0]?.handback_note || null;

  // 4. Persist the user message + mark conversation unread for dashboard
  await db.query(
    'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
    [conversation_id, 'customer', sanitized]
  );
  await db.query(
    'UPDATE conversations SET unread = TRUE WHERE id = $1',
    [conversation_id]
  );

  // 5. Build system prompt
  const tenantCtx = {
    name:                conv.tenant_name,
    agent_name:          conv.agent_name,
    vertical:            conv.vertical,
    vertical_config:     conv.vertical_config,
    compliance_config:   conv.compliance_config,
    base_soul_template:  conv.base_soul_template,
    website_url:         conv.website_url,
  };

  const customerCtx = {
    soul_file:                        conv.soul_file,
    memory_file:                      conv.memory_file,
    onboarding_status:                conv.onboarding_status,
    onboarding_categories_completed:  conv.onboarding_categories_completed,
  };

  let systemPrompt = buildSystemPrompt({
    tenant:        tenantCtx,
    customer:      customerCtx,
    customerData:  customerData,
    products:      products,
    handbackNote:  handbackNote,
    widgetGreeted: existingMessages.length === 0,
  });

  // ── Brand Learning · inject brand_soul for anonymous visitors ────────────
  // The anon-only loop (v3.5+) accumulates aggregate, PII-scrubbed,
  // business-relevant patterns from prior anonymous chats. Inject the
  // distilled context for anon visitors only — identified customers get
  // their own per-customer Soul + Memory through buildSystemPrompt above.
  if (conv.brand_learning_enabled === true && isAnonVisitorEmail(conv.email)) {
    const brandSoul = safeDecryptJson(conv.brand_soul);
    const brandBlock = renderBrandSoulForPrompt(brandSoul);
    if (brandBlock) systemPrompt += brandBlock;
  }

  // If there was a handback note, consume it now (single-use — clear after this turn)
  if (handbackNote) {
    db.query('UPDATE conversations SET handback_note = NULL WHERE id = $1', [conversation_id])
      .catch(err => console.error('[Widget] Failed to clear handback_note:', err.message));
  }

  // 6. Build LLM messages array
  const llmMessages = [
    ...existingMessages.map(m => ({
      role:    m.role === 'customer' ? 'user' : 'assistant',
      content: m.content,
    })),
    { role: 'user', content: sanitized },
  ];

  // 7. Determine agent display name (prefer customer-given nickname)
  const soulFile = conv.soul_file || {};
  const agentDisplayName =
    soulFile.agent_nickname                     ||
    soulFile.base_identity?.customer_given_name ||
    soulFile.base_identity?.agent_name          ||
    conv.agent_name;

  // 8. Get LLM response
  // Resolves API key (BYOK or platform managed), then chooses:
  //   - Tool-calling loop  → if tenant has enabled_tools configured
  //   - Standard call      → if no tools enabled (pure conversation)
  //   - Mock response      → if no API key available
  const tenantForLLM = {
    llm_provider:             conv.llm_provider,
    llm_api_key_encrypted:    conv.llm_api_key_encrypted,
    llm_api_key_iv:           conv.llm_api_key_iv,
    llm_api_key_validated:    conv.llm_api_key_validated,
    managed_ai_enabled:       managedAiEnabled,
    pii_tokenization_enabled: conv.pii_tokenization_enabled,
  };

  // Build tokenizer once; llmService applies it on every Anthropic call.
  const tokenizer = buildTokenizer({
    tenant:     tenantForLLM,
    memoryFile: conv.memory_file,
    soulFile:   conv.soul_file,
  });
  const breachCtx = {
    tenantId:       tenant_id,
    conversationId: conversation_id,
    customerId:     customer_id,
  };

  // Resolve the enabled tools for this tenant (universal registry tools)
  const enabledTools     = conv.enabled_tools || [];
  const toolConfigs      = conv.tool_configs  || {};
  const universalToolDefs = getToolDefinitions(enabledTools, toolConfigs);

  // Load custom tools defined by this tenant in the DB
  const customToolRows = await loadCustomTools(db, tenant_id);
  const customToolDefs = customToolRows.map(toToolDefinition);

  // Merge: universal tools first, then tenant-defined custom tools
  const toolDefs = [...universalToolDefs, ...customToolDefs];

  let agentResponse;

  // LLM call is the most likely intermittent failure point (network, provider
  // rate limits, timeouts). Wrap separately so the log line identifies the path
  // and carries tenant/conversation/model context without leaking keys.
  const llmPath = toolDefs.length > 0 && (tenantForLLM.managed_ai_enabled || tenantForLLM.llm_api_key_encrypted)
    ? 'tools'
    : 'standard';
  try {
    if (llmPath === 'tools') {
      // ── Tool-enabled path ──────────────────────────────────────────────────
      // Build the tool executor bound to this request's context so handlers
      // can access db, customerId, conversationId, etc.
      const resolvedKey = resolveApiKey(tenantForLLM);

      const toolContext = {
        db,
        tenantId:       tenant_id,
        customerId:     customer_id,
        conversationId: conversation_id,
        customer: {
          first_name: conv.first_name,
          last_name:  conv.last_name,
          email:      conv.email,
        },
        tenant: {
          name:           conv.tenant_name,
          vertical_config: conv.vertical_config,
        },
      };

      // Universal executor (handles lookup_client_data, analyze_client_data, etc.)
      const universalExecutor = (toolName, params) =>
        executeTool(toolName, params, toolContext);

      // Custom executor (handles tenant-defined tools from custom_tools table)
      const customExecutor = buildCustomExecutor(customToolRows, toolContext);

      // Combined: custom tools take priority, fall through to universal
      const toolExecutor = buildCombinedExecutor(customExecutor, universalExecutor);

      // tenants.llm_model is set at signup time and never updated when the
      // tenant later switches provider, so trust the active provider's
      // adapter default instead of the (potentially stale) stored column.
      const dispatchModel = getDefaultModel(conv.llm_provider, 'sonnet');

      const raw = await callClaudeWithTools(
        systemPrompt,
        llmMessages,
        toolDefs,
        toolExecutor,
        dispatchModel,
        2048,
        resolvedKey,
        {
          tokenizer,
          breachCtx: { ...breachCtx, callSite: 'toolLoop' },
          provider: conv.llm_provider,
        }
      );
      agentResponse = sanitiseResponse(raw);

    } else {
      // ── Standard path (no tools, or mock) ─────────────────────────────────
      // See note on dispatchModel in the tool-loop branch above — same
      // rationale applies here.
      const dispatchModel = getDefaultModel(conv.llm_provider, 'sonnet');

      agentResponse = await getAgentResponse({
        systemPrompt,
        messages:        llmMessages,
        model:           dispatchModel,
        customerName:    `${conv.first_name} ${conv.last_name}`,
        agentName:       agentDisplayName,
        lastUserMessage: sanitized,
        tenant:          tenantForLLM,
        memoryFile:      conv.memory_file,
        soulFile:        conv.soul_file,
        breachCtx,
      });
    }
  } catch (llmErr) {
    if (llmErr instanceof BreachError) {
      // Log-and-block: request was NOT sent to Anthropic. Return safe
      // message to the end customer so they rephrase without the PII.
      console.error(`[Widget][chat][llm] BreachError blocked request — ${llmErr.findings.length} finding(s), conversation=${conversation_id}`);
      agentResponse = 'I noticed some sensitive information in that message. For your security, I can\'t process it in this form. Please rephrase without the specific details and I\'ll be happy to help.';
    } else if (llmErr instanceof NoApiKeyError) {
      // Pure BYOK: this tenant hasn't pasted (or has revoked) an API key.
      // The end-customer can't fix this — only the operator can. Show a
      // generic message and tag the log so the operator can find their
      // stuck conversations by tenant_id when they finally configure a key.
      console.warn(
        `[Widget][chat][no-key] tenant=${tenant_id} conv=${conversation_id} ` +
        `msgs=${existingMessages.length + 1} — chat blocked, tenant has no validated API key`
      );
      agentResponse = 'I\'m having trouble connecting right now. Please try again in a moment.';
    } else {
      // Tag the failure so grepping backend logs for `[Widget][chat][llm]` lands
      // on the exact cause of the user-facing "Sorry, I had trouble responding".
      console.error(
        `[Widget][chat][llm] path=${llmPath} provider=${conv.llm_provider || 'unknown'} ` +
        `model=${conv.llm_model || 'default'} tenant=${tenant_id} conv=${conversation_id} ` +
        `msgs=${existingMessages.length + 1} — ${llmErr.message}`
      );
      if (llmErr.stack) console.error(llmErr.stack);
      throw llmErr;
    }
  }

  // 8b. Increment message counter
  await incrementMessageCount(tenant_id);

  // 9. Persist agent response
  await db.query(
    'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
    [conversation_id, 'agent', agentResponse]
  );

  // 10. Update last interaction timestamp
  await db.query(
    'UPDATE customers SET last_interaction_at = NOW() WHERE id = $1',
    [customer_id]
  );

  // 11. Per-exchange memory update (fire-and-forget)
  // Runs fact extraction every exchange, session summary on goodbye or every 20 msgs,
  // and soul evolution every 5 msgs — all non-blocking so response is never delayed.
  const { rows: msgCountRows } = await db.query(
    'SELECT COUNT(*) FROM messages WHERE conversation_id = $1',
    [conversation_id]
  );
  const msgCount = parseInt(msgCountRows[0].count, 10);
  if (!isAnonymous) {
    updateMemoryAfterExchange({
      customerMessage: sanitized,
      agentResponse,
      currentMemory:   conv.memory_file,   // already decrypted above
      currentSoul:     conv.soul_file,      // already decrypted above
      customerId:      customer_id,
      conversationId:  conversation_id,
      messageCount:    msgCount,
      sessionType:     conv.onboarding_status !== 'complete' ? 'onboarding' : 'regular',
      apiKey:          resolveApiKey(tenantForLLM),
      tenant:          { id: tenant_id, pii_tokenization_enabled: conv.pii_tokenization_enabled },
      db,
    }).catch(err => console.error('[Widget] Memory update error:', err.message));
  }

  return { kind: 'reply', role: 'agent', content: agentResponse, conversation_id: conversation_id };
}

module.exports = { handleMessage };
