/**
 * SHENMAY AI — Tenant Portal: Customers
 *
 * Sub-router mounted by ../portal.js at `/api/portal/customers`.
 * `requirePortalAuth` already ran on the parent so `req.portal` is populated.
 *
 *   POST   /api/portal/customers/ai-map               — AI column mapping for CSV import
 *   POST   /api/portal/customers/upload               — bulk CSV import (creates + updates)
 *   GET    /api/portal/customers                      — paginated list (named-only, anon excluded)
 *   GET    /api/portal/customers/:id                  — detail with soul + memory + conversations
 *   PUT    /api/portal/customers/:id                  — update first/last name
 *   DELETE /api/portal/customers/:id                  — GDPR Art.17 / CCPA §1798.105 right-to-erasure
 *   GET    /api/portal/customers/:id/export           — GDPR Art.20 / CCPA §1798.100 data portability
 *   GET    /api/portal/customers/:id/data             — list records grouped by category
 *   POST   /api/portal/customers/:id/data             — add or update a single record
 *   DELETE /api/portal/customers/:id/data/:category   — clear all records for a category
 *   DELETE /api/portal/customers/:id/data/:category/:label — delete a single record
 *
 * The /search endpoint stays inline in portal.js — it bridges customers AND
 * conversations and doesn't share a single prefix.
 */

const router = require('express').Router();
const { parse: csvParse } = require('csv-parse/sync');
const db = require('../../db');
const { getSubscription } = require('../../middleware/subscription');
const { UNRESTRICTED_PLANS } = require('../../config/plans');
const { resolveApiKey, callClaude, buildTokenizer } = require('../../services/llmService');
const { BreachError } = require('../../services/piiTokenizer');
const { writeAuditLog } = require('../../middleware/auditLog');
const { anonymizeCustomer } = require('../../jobs/dataRetention');
const { encryptJson, safeDecryptJson } = require('../../services/cryptoService');
const { anonEmailNotLikeGuard } = require('../../constants/anonDomains');
const { markStepComplete } = require('../../utils/onboarding');

// ── Safe pagination helper (mirrors the one in portal.js — small enough to dup) ─
function parsePage(raw, defaultVal = 1)  { const n = parseInt(raw, 10); return isNaN(n) ? defaultVal : Math.max(1, Math.min(n, 10000)); }
function parseLimit(raw, max = 100, def = 25) { const n = parseInt(raw, 10); return isNaN(n) ? def : Math.max(1, Math.min(n, max)); }

// ── Helper: verify a /customers/:id path-param customer belongs to this tenant.
//
// Returns true if the customer exists and the caller can proceed. Returns
// false after writing a 404 response — the route handler should `return;`
// immediately. Used by every /customers/:id/data and /customers/:id/labels
// handler to enforce tenant isolation before touching `customer_data` /
// `customer_labels` rows that don't carry a tenant_id column of their own.
async function verifyCustomerOwnership(res, customerId, tenantId) {
  const { rows } = await db.query(
    `SELECT id FROM customers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [customerId, tenantId]
  );
  if (!rows.length) {
    res.status(404).json({ error: 'Customer not found' });
    return false;
  }
  return true;
}

// POST /api/portal/customers/ai-map
// Accepts { headers: string[], sample_rows: object[] }
// Asks Claude to map the tenant's CSV columns → our fields.
// Returns { mapping: { "Their Column": "our_field", ... } }
// Fields Claude can map to: email, first_name, last_name, external_id, notes, skip
router.post('/ai-map', async (req, res, next) => {
  try {
    const { headers, sample_rows } = req.body;
    if (!Array.isArray(headers) || headers.length === 0) {
      return res.status(400).json({ error: 'headers array required' });
    }

    // Load tenant for tokenizer + API key resolution. Sample rows in CSV uploads
    // routinely contain regulated PII (SSNs, cards, account numbers, DOBs), so
    // the same tokenize-before-Anthropic guarantee the chat path has must apply here.
    const { rows: tenantRows } = await db.query(
      `SELECT t.id, t.pii_tokenization_enabled, t.llm_api_key_encrypted, t.llm_api_key_iv,
              t.llm_api_key_validated, t.llm_provider,
              COALESCE(s.managed_ai_enabled, false) AS managed_ai_enabled
         FROM tenants t
         LEFT JOIN subscriptions s ON s.tenant_id = t.id
         WHERE t.id = $1
         LIMIT 1`,
      [req.portal.tenant_id]
    );
    const tenant = tenantRows[0];
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });

    const apiKey = resolveApiKey(tenant);
    if (!apiKey) {
      return res.status(503).json({ error: 'No AI key configured for this tenant. Add one in Settings and retry.' });
    }

    const tokenizer = buildTokenizer({ tenant });

    const systemPrompt = `You are a data mapping assistant. Map CSV column names to customer record fields.
Return ONLY a raw JSON object. No markdown. No explanation. Start with { and end with }.
Map each column name to exactly one of these field names:
  "email"       — customer email address (unique identifier, required)
  "first_name"  — first or given name
  "last_name"   — last, family, or surname
  "external_id" — any platform ID (Shopify ID, Stripe customer ID, internal user ID, account number)
  "notes"       — any freeform notes, comments, or tags
  "skip"        — ignore this column

Rules:
- Every column must be mapped to something (use "skip" if irrelevant)
- If two columns could both be "email", pick the most likely one and skip the other
- Map full names to first_name if there is no separate last_name column
- Account numbers, member IDs, user IDs → external_id

Sample values may be redacted to opaque tokens like [EMAIL_N], [SSN_N], [PHONE_N],
[CC_N], [ACCOUNT_N], [DOB_N], [POSTCODE_N], [IBAN_N], [PERSON_N] — the token name
tells you what kind of data the column holds and is a strong mapping signal.`;

    // Bound what we stringify into the prompt: cap header count/length and each
    // sample cell, so a pathological CSV cell can't build a giant payload
    // (defense-in-depth alongside the tokenizer's own length backstop).
    const safeHeaders = headers.slice(0, 100).map(h => String(h).slice(0, 100));
    const safeRows = (Array.isArray(sample_rows) ? sample_rows.slice(0, 3) : []).map(row => {
      if (!row || typeof row !== 'object') return {};
      const out = {};
      for (const k of Object.keys(row).slice(0, 60)) {
        out[String(k).slice(0, 100)] = String(row[k] ?? '').slice(0, 500);
      }
      return out;
    });
    const userPrompt = `Map these CSV columns to customer record fields.
Columns: ${JSON.stringify(safeHeaders)}
Sample data (first few rows): ${JSON.stringify(safeRows)}`;

    let rawText;
    try {
      rawText = await callClaude(
        systemPrompt,
        [{ role: 'user', content: userPrompt }],
        tenant.llm_provider === 'openai'
          ? (process.env.LLM_OPENAI_MINI_MODEL || 'gpt-4o-mini')
          : (process.env.LLM_HAIKU_MODEL || 'claude-haiku-4-5-20251001'),
        512,
        apiKey,
        {
          tokenizer,
          breachCtx: {
            tenantId: req.portal.tenant_id,
            callSite: 'csv_import_ai_map',
          },
          provider: tenant.llm_provider,
        }
      );
    } catch (err) {
      if (err instanceof BreachError) {
        // Breach detector fired on the tokenized payload — request NEVER left
        // this process. Tell the admin which rows looked unsafe so they can
        // retry without sample values.
        return res.status(422).json({
          error: 'Some sample values look like unredacted personal data that our safety check blocked. Try re-uploading without sample rows, or with a smaller, less-sensitive sample.',
          blocked_by_pii_guard: true,
        });
      }
      throw err;
    }

    let mapping = {};
    try {
      let raw = rawText.trim();
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const objMatch = raw.match(/\{[\s\S]*\}/);
      if (objMatch) raw = objMatch[0];
      mapping = JSON.parse(raw);
      // Ensure all values are valid field names
      const validFields = new Set(['email', 'first_name', 'last_name', 'external_id', 'notes', 'skip']);
      for (const [col, field] of Object.entries(mapping)) {
        if (!validFields.has(field)) mapping[col] = 'skip';
      }
    } catch {
      console.error('[ai-map] JSON parse failed:', rawText?.slice(0, 300));
      return res.status(500).json({ error: 'Could not parse AI mapping. Try again.' });
    }

    res.json({ mapping });
  } catch (err) { next(err); }
});

// POST /api/portal/customers/upload
// Accepts { csv, mapping? }
// mapping: { "CSV Column Name": "our_field" } — from ai-map or user-confirmed
// If no mapping provided, falls back to guessing by common column name variants.
const MAX_CSV_UPLOAD_ROWS = 10000;

router.post('/upload', async (req, res, next) => {
  try {
    const { csv, mapping } = req.body;
    if (!csv) return res.status(400).json({ error: 'csv field required' });

    let records;
    try {
      records = csvParse(csv, { columns: true, skip_empty_lines: true, trim: true });
    } catch {
      return res.status(400).json({ error: 'Could not parse CSV — check the file format' });
    }
    if (records.length === 0) return res.status(400).json({ error: 'CSV contains no rows' });
    // Cap bulk rows per upload — bounds the per-row DB-write amplification a
    // single 10 MB upload could otherwise cause on the shared pool (mirrors the
    // data API's 1000-record cap, looser here for bulk onboarding).
    if (records.length > MAX_CSV_UPLOAD_ROWS) {
      return res.status(400).json({ error: `CSV has too many rows (${records.length}). Maximum ${MAX_CSV_UPLOAD_ROWS} per upload — split the file and retry.` });
    }

    // Load subscription and current customer count to enforce limits
    const sub = await getSubscription(req.portal.tenant_id);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM customers WHERE tenant_id = $1 AND deleted_at IS NULL AND ${anonEmailNotLikeGuard()}`,
      [req.portal.tenant_id]
    );

    // Fetch agent soul template to pre-populate new customers
    const { rows: tenantSoulRows } = await db.query(
      `SELECT agent_soul_template FROM tenants WHERE id = $1`,
      [req.portal.tenant_id]
    );
    const soulTemplate = tenantSoulRows[0]?.agent_soul_template || null;
    let currentCount = parseInt(countRows[0].count);
    const maxCustomers = sub ? sub.max_customers : null;
    const isUnrestricted = sub && UNRESTRICTED_PLANS.includes(sub.plan);

    // Build a resolver: given a row, extract a named field using the mapping
    // Falls back to common name variants if no mapping provided
    const FALLBACKS = {
      email:       ['email', 'Email', 'EMAIL', 'e-mail', 'E-Mail'],
      first_name:  ['first_name', 'firstName', 'First Name', 'first', 'given_name', 'name'],
      last_name:   ['last_name',  'lastName',  'Last Name',  'last',  'surname', 'family_name'],
      external_id: ['external_id', 'id', 'ID', 'user_id', 'customer_id', 'account_id', 'member_id'],
      notes:       ['notes', 'Notes', 'NOTES', 'comments', 'Comments', 'tags', 'Tags'],
    };

    function resolve(row, field) {
      if (mapping) {
        // Find the CSV column(s) that map to this field
        for (const [col, mappedField] of Object.entries(mapping)) {
          if (mappedField === field && row[col] !== undefined) return (row[col] || '').trim();
        }
        return '';
      }
      // Fallback: try common variants
      for (const variant of FALLBACKS[field] || []) {
        if (row[variant] !== undefined) return (row[variant] || '').trim();
      }
      return '';
    }

    let inserted = 0;
    let updated  = 0;
    const errors = [];

    for (const [i, row] of records.entries()) {
      const email = resolve(row, 'email').toLowerCase();
      if (!email) { errors.push(`Row ${i + 2}: no email found`); continue; }

      const firstName  = resolve(row, 'first_name');
      const lastName   = resolve(row, 'last_name');
      const externalId = resolve(row, 'external_id') || null;
      const notes      = resolve(row, 'notes')       || null;

      const upsert = async (customerId) => {
        if (externalId) {
          await db.query(
            `UPDATE customers SET external_id = $1 WHERE id = $2 AND (external_id IS NULL OR external_id = $1)`,
            [externalId, customerId]
          );
        }
        if (notes) {
          await db.query(
            `INSERT INTO customer_data (customer_id, category, label, value, value_type, source)
             VALUES ($1, 'profile', 'Notes', $2, 'text', 'csv_import')
             ON CONFLICT (customer_id, category, label) DO UPDATE SET
               value = EXCLUDED.value, recorded_at = NOW()`,
            [customerId, notes]
          );
        }
      };

      const { rows: existing } = await db.query(
        `SELECT id FROM customers
         WHERE tenant_id = $1 AND (email = $2 ${externalId ? 'OR external_id = $3' : ''})`,
        externalId ? [req.portal.tenant_id, email, externalId] : [req.portal.tenant_id, email]
      );

      if (existing.length > 0) {
        await db.query(
          `UPDATE customers SET
             first_name = COALESCE(NULLIF($1,''), first_name),
             last_name  = COALESCE(NULLIF($2,''), last_name),
             email      = COALESCE(NULLIF($3,''), email)
           WHERE id = $4`,
          [firstName, lastName, email, existing[0].id]
        );
        await upsert(existing[0].id);
        updated++;
      } else {
        // Enforce customer limit for new inserts
        if (!isUnrestricted && maxCustomers !== null && currentCount >= maxCustomers) {
          errors.push(`Row ${i + 2}: customer limit reached (${maxCustomers} max) — upgrade your plan to add more`);
          // Fire one-time notification email for trial tenants
          const { sendLimitNotificationIfNeeded } = require('../../middleware/subscription');
          sendLimitNotificationIfNeeded(req.portal.tenant_id);
          continue;
        }
        const { rows: newCust } = await db.query(
          `INSERT INTO customers (tenant_id, email, first_name, last_name, external_id, onboarding_status, soul_file)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb)
           RETURNING id`,
          [req.portal.tenant_id, email, firstName, lastName, externalId,
           JSON.stringify(encryptJson(soulTemplate || {}))]
        );
        await upsert(newCust[0].id);
        inserted++;
        currentCount++;
      }
    }

    await markStepComplete(req.portal.tenant_id, 'customers');
    const limitReached = !isUnrestricted && maxCustomers !== null && currentCount >= maxCustomers;
    res.json({ ok: true, inserted, updated, errors, limit_reached: limitReached, customers_count: currentCount, customers_limit: maxCustomers });
  } catch (err) { next(err); }
});

// GET /api/portal/customers — named/known customers only (excludes anonymous visitors)
router.get('/', async (req, res, next) => {
  try {
    const page   = parsePage(req.query.page);
    const limit  = parseLimit(req.query.limit);
    const offset = (page - 1) * limit;
    const q      = (req.query.q || '').trim().slice(0, 200);

    const params = [req.portal.tenant_id, limit, offset];
    let searchClause = '';

    if (q) {
      // Search by name or email (case-insensitive)
      params.push(`%${q}%`);
      const p = params.length;
      searchClause = `AND (
        first_name ILIKE $${p} OR
        last_name  ILIKE $${p} OR
        email      ILIKE $${p} OR
        (first_name || ' ' || last_name) ILIKE $${p}
      )`;
    }

    const { rows } = await db.query(
      `SELECT id, email,
              COALESCE(NULLIF(TRIM(first_name || ' ' || last_name), ''), email) AS display_name,
              first_name, last_name, onboarding_status,
              last_interaction_at, created_at,
              CASE
                WHEN last_interaction_at IS NOT NULL
                THEN ROUND(EXTRACT(EPOCH FROM (NOW() - last_interaction_at)) / 60)
                ELSE NULL
              END AS idle_minutes
       FROM customers
       WHERE tenant_id = $1 AND deleted_at IS NULL
         AND ${anonEmailNotLikeGuard()}
         ${searchClause}
       ORDER BY last_interaction_at DESC NULLS LAST, created_at DESC
       LIMIT $2 OFFSET $3`,
      params
    );

    const countParams = [req.portal.tenant_id];
    let countSearch = '';
    if (q) {
      countParams.push(`%${q}%`);
      const p = countParams.length;
      countSearch = `AND (
        first_name ILIKE $${p} OR last_name ILIKE $${p} OR email ILIKE $${p} OR
        (first_name || ' ' || last_name) ILIKE $${p}
      )`;
    }

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM customers
       WHERE tenant_id = $1 AND deleted_at IS NULL
         AND ${anonEmailNotLikeGuard()}
         ${countSearch}`,
      countParams
    );

    res.json({
      customers: rows,
      total:     parseInt(countRows[0].count),
      page,
      limit,
      query:     q || null,
    });
  } catch (err) { next(err); }
});

// GET /api/portal/customers/:id — customer detail with soul + memory + conversations
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.email, c.first_name, c.last_name, c.onboarding_status,
              c.soul_file, c.memory_file, c.last_interaction_at, c.created_at,
              c.consent_given_at, c.anonymized_at, c.deletion_requested_at,
              json_agg(json_build_object(
                'category', cd.category,
                'label',    cd.label,
                'value',    cd.value,
                'type',     cd.value_type,
                'metadata', cd.metadata
              ) ORDER BY cd.recorded_at) FILTER (WHERE cd.id IS NOT NULL) AS data,
              (SELECT COALESCE(json_agg(json_build_object(
                'id',              conv.id,
                'status',          conv.status,
                'created_at',      conv.created_at,
                'message_count',   (SELECT COUNT(*) FROM messages WHERE conversation_id = conv.id),
                'last_message_at', (SELECT created_at FROM messages WHERE conversation_id = conv.id ORDER BY created_at DESC LIMIT 1),
                'last_message',    (SELECT content FROM messages WHERE conversation_id = conv.id ORDER BY created_at DESC LIMIT 1)
              ) ORDER BY conv.created_at DESC), '[]')
               FROM conversations conv
               WHERE conv.customer_id = c.id) AS conversations
       FROM customers c
       LEFT JOIN customer_data cd ON cd.customer_id = c.id
       WHERE c.id = $1 AND c.tenant_id = $2
       GROUP BY c.id`,
      [req.params.id, req.portal.tenant_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Customer not found' });

    // Decrypt encrypted columns before returning to portal
    const customer = rows[0];
    customer.soul_file   = safeDecryptJson(customer.soul_file);
    customer.memory_file = safeDecryptJson(customer.memory_file);

    // Audit log: advisor accessed a customer profile
    writeAuditLog({
      actorType   : req.portal.role === 'admin' ? 'admin' : 'advisor',
      actorId     : req.portal.admin_id,
      actorEmail  : req.portal.email,
      tenantId    : req.portal.tenant_id,
      customerId  : req.params.id,
      eventType   : 'customer.read',
      resourceType: 'customer',
      resourceId  : req.params.id,
      description : `Advisor viewed customer profile (includes soul_file + memory_file)`,
      req,
      success     : true,
    });

    res.json({ customer });
  } catch (err) { next(err); }
});

// PUT /api/portal/customers/:id
// Body: { first_name?: string, last_name?: string }
router.put('/:id', async (req, res, next) => {
  try {
    const { first_name, last_name } = req.body || {};

    if (first_name !== undefined && first_name !== null && typeof first_name !== 'string') {
      return res.status(400).json({ error: 'first_name must be a string' });
    }
    if (last_name !== undefined && last_name !== null && typeof last_name !== 'string') {
      return res.status(400).json({ error: 'last_name must be a string' });
    }

    const cleanFirst = typeof first_name === 'string' ? first_name.trim().slice(0, 100) : null;
    const cleanLast  = typeof last_name  === 'string' ? last_name.trim().slice(0, 100)  : null;

    const { rowCount } = await db.query(
      `UPDATE customers SET
         first_name = COALESCE($1, first_name),
         last_name  = COALESCE($2, last_name)
       WHERE id = $3 AND tenant_id = $4 AND deleted_at IS NULL`,
      [cleanFirst, cleanLast, req.params.id, req.portal.tenant_id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Customer not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/portal/customers/:id
//
// Right-to-Erasure — GDPR Article 17, CCPA Section 1798.105
//
// Fully anonymises the customer record:
//   - PII fields (name, email, phone, DOB, location) → placeholder values
//   - memory_file + soul_file wiped to {}
//   - customer_data records deleted
//   - flags deleted (contain PII in description)
//   - message content replaced with deletion notice
//   - conversation metadata kept (no PII) for analytics
//   - audit log entry written
//
// The customer row is NOT hard-deleted — foreign key references (conversations,
// flags, audit_logs) require the row to exist for referential integrity.
router.delete('/:id', async (req, res, next) => {
  try {
    // Verify customer belongs to this tenant
    const { rows: check } = await db.query(
      `SELECT id, anonymized_at FROM customers WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.portal.tenant_id]
    );
    if (check.length === 0) return res.status(404).json({ error: 'Customer not found' });
    if (check[0].anonymized_at) {
      return res.status(409).json({ error: 'Customer data has already been erased' });
    }

    // Audit: log the erasure request BEFORE executing (so there's a record even if it fails)
    writeAuditLog({
      actorType   : req.portal.role === 'admin' ? 'admin' : 'advisor',
      actorId     : req.portal.admin_id,
      actorEmail  : req.portal.email,
      tenantId    : req.portal.tenant_id,
      customerId  : req.params.id,
      eventType   : 'customer.erasure_requested',
      resourceType: 'customer',
      resourceId  : req.params.id,
      description : `Right-to-erasure invoked by advisor — immediate anonymisation`,
      req,
      success     : true,
    });

    // Mark deletion requested (for queue visibility), then immediately process
    await db.query(
      `UPDATE customers SET deletion_requested_at = NOW(), deletion_requested_by = $2
       WHERE id = $1`,
      [req.params.id, req.portal.admin_id]
    );

    // Execute anonymisation immediately (not deferred — advisor expects it now)
    await anonymizeCustomer(req.params.id, req.portal.tenant_id, req.portal.admin_id);

    console.log(`[Portal] Customer ${req.params.id} anonymised (right-to-erasure) by advisor ${req.portal.admin_id}`);
    res.json({ ok: true, message: 'Customer data has been permanently anonymised and removed.' });
  } catch (err) { next(err); }
});

// GET /api/portal/customers/:id/export
//
// Right-to-Access (Data Portability) — GDPR Article 20, CCPA Section 1798.100
//
// Returns a structured JSON object containing all data held about the customer:
//   - Personal profile (name, email, phone, DOB, location)
//   - Memory file (conversation history, goals, profile extracted by AI)
//   - Soul file (communication preferences, agent nickname)
//   - Structured data records (financial, health, etc.)
//   - Conversation metadata (dates, summaries, topics — not raw messages)
//   - Consent record
//
// The response is suitable for providing directly to the customer as their
// GDPR "data subject access request" (DSAR) response.
router.get('/:id/export', async (req, res, next) => {
  try {
    // Verify customer belongs to this tenant
    const { rows: customerRows } = await db.query(
      `SELECT c.*, t.name AS tenant_name, t.gdpr_contact_email
       FROM customers c
       JOIN tenants t ON c.tenant_id = t.id
       WHERE c.id = $1 AND c.tenant_id = $2`,
      [req.params.id, req.portal.tenant_id]
    );
    if (customerRows.length === 0) return res.status(404).json({ error: 'Customer not found' });
    const customer = customerRows[0];
    // Decrypt encrypted columns before building the export package
    customer.soul_file   = safeDecryptJson(customer.soul_file);
    customer.memory_file = safeDecryptJson(customer.memory_file);

    // Structured data records
    const { rows: dataRows } = await db.query(
      `SELECT category, label, value, secondary_value, value_type, source, recorded_at
       FROM customer_data WHERE customer_id = $1 ORDER BY category, label`,
      [req.params.id]
    );

    // Conversation metadata (no message content — that's separately accessible)
    const { rows: convRows } = await db.query(
      `SELECT id, session_type, status, summary, topics_covered,
              started_at, ended_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = conversations.id) AS message_count
       FROM conversations
       WHERE customer_id = $1
       ORDER BY started_at DESC`,
      [req.params.id]
    );

    // Flags (excluding already-deleted ones)
    const { rows: flagRows } = await db.query(
      `SELECT flag_type, severity, description, status, created_at, resolved_at
       FROM flags WHERE customer_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );

    // Audit log entries for this customer (what data was accessed and by whom)
    const { rows: auditRows } = await db.query(
      `SELECT event_type, actor_type, actor_email, description, created_at, success
       FROM audit_logs
       WHERE customer_id = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.params.id]
    );

    // Audit: log the export
    writeAuditLog({
      actorType   : req.portal.role === 'admin' ? 'admin' : 'advisor',
      actorId     : req.portal.admin_id,
      actorEmail  : req.portal.email,
      tenantId    : req.portal.tenant_id,
      customerId  : req.params.id,
      eventType   : 'customer.data_export',
      resourceType: 'customer',
      resourceId  : req.params.id,
      description : `Full data export (GDPR DSAR / CCPA access request)`,
      req,
      success     : true,
    });

    // Build the export package
    const exportPackage = {
      export_metadata: {
        generated_at      : new Date().toISOString(),
        generated_by      : req.portal.email,
        data_controller   : customer.tenant_name,
        gdpr_contact      : customer.gdpr_contact_email || 'See your service provider\'s privacy policy',
        export_format     : 'application/json',
        schema_version    : '1.0',
      },
      personal_data: {
        id              : customer.id,
        name            : `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
        email           : customer.email,
        phone           : customer.phone,
        date_of_birth   : customer.date_of_birth,
        location        : customer.location,
        created_at      : customer.created_at,
        last_interaction: customer.last_interaction_at,
      },
      consent: {
        consent_given_at : customer.consent_given_at,
        consent_version  : customer.consent_version,
        consent_ip       : customer.consent_ip ? String(customer.consent_ip) : null,
      },
      ai_memory: {
        memory_file      : customer.memory_file || {},
        soul_file        : customer.soul_file   || {},
      },
      structured_data   : dataRows,
      conversations     : convRows,
      flags             : flagRows,
      access_log        : auditRows,
    };

    // Respond as a downloadable JSON file
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="customer_data_export_${req.params.id}_${new Date().toISOString().split('T')[0]}.json"`
    );
    res.json(exportPackage);
  } catch (err) { next(err); }
});

// GET /api/portal/customers/:id/data — list all data records grouped by category
router.get('/:id/data', async (req, res, next) => {
  try {
    const { id } = req.params;
    const category = req.query.category;

    if (!await verifyCustomerOwnership(res, id, req.portal.tenant_id)) return;

    const { rows } = await db.query(
      `SELECT id, category, label, value, secondary_value, value_type, metadata, recorded_at, source
       FROM customer_data
       WHERE customer_id = $1 ${category ? 'AND category = $2' : ''}
       ORDER BY category, label`,
      category ? [id, category] : [id]
    );

    // Group by category
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row);
    }

    res.json({ records: grouped, total: rows.length });
  } catch (err) { next(err); }
});

// POST /api/portal/customers/:id/data — add or update a single data record
// Body: { category: string, label: string, value?, secondary_value?, value_type?: string,
//         metadata?: object }
router.post('/:id/data', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { category, label, value, secondary_value, value_type, metadata } = req.body || {};

    if (typeof category !== 'string' || !category.trim()) {
      return res.status(400).json({ error: 'category is required' });
    }
    if (typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ error: 'label is required' });
    }
    if (value_type !== undefined && value_type !== null && typeof value_type !== 'string') {
      return res.status(400).json({ error: 'value_type must be a string' });
    }
    // metadata is stored as JSONB — reject anything that won't round-trip
    if (metadata !== undefined && metadata !== null &&
        (typeof metadata !== 'object' || Array.isArray(metadata))) {
      return res.status(400).json({ error: 'metadata must be an object' });
    }

    if (!await verifyCustomerOwnership(res, id, req.portal.tenant_id)) return;

    const { rows } = await db.query(
      `INSERT INTO customer_data
         (customer_id, category, label, value, secondary_value, value_type, metadata, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'portal')
       ON CONFLICT (customer_id, category, label)
       DO UPDATE SET
         value           = EXCLUDED.value,
         secondary_value = EXCLUDED.secondary_value,
         value_type      = COALESCE(EXCLUDED.value_type, customer_data.value_type),
         metadata        = COALESCE(EXCLUDED.metadata, customer_data.metadata),
         recorded_at     = NOW()
       RETURNING id, category, label, value, secondary_value, value_type, recorded_at, source`,
      [
        id, category, label,
        value != null ? String(value) : null,
        secondary_value != null ? String(secondary_value) : null,
        value_type || null,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );

    res.status(201).json({ record: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/portal/customers/:id/data/:category — clear all records for a category
router.delete('/:id/data/:category', async (req, res, next) => {
  try {
    const { id, category } = req.params;

    if (!await verifyCustomerOwnership(res, id, req.portal.tenant_id)) return;

    const { rowCount } = await db.query(
      `DELETE FROM customer_data
       WHERE customer_id = $1 AND category = $2
         AND customer_id IN (SELECT id FROM customers WHERE tenant_id = $3 AND deleted_at IS NULL)`,
      [id, category, req.portal.tenant_id]
    );

    res.json({ success: true, deleted: rowCount, category });
  } catch (err) { next(err); }
});

// DELETE /api/portal/customers/:id/data/:category/:label — delete a single record
router.delete('/:id/data/:category/:label', async (req, res, next) => {
  try {
    const { id, category, label } = req.params;

    if (!await verifyCustomerOwnership(res, id, req.portal.tenant_id)) return;

    const { rowCount } = await db.query(
      `DELETE FROM customer_data
       WHERE customer_id = $1 AND category = $2 AND label = $3
         AND customer_id IN (SELECT id FROM customers WHERE tenant_id = $4 AND deleted_at IS NULL)`,
      [id, category, label, req.portal.tenant_id]
    );

    res.json({ success: true, deleted: rowCount });
  } catch (err) { next(err); }
});

module.exports = router;
