/**
 * SHENMAY AI — External Data Ingestion API  (v1)
 *
 * Allows tenants to push customer data into Shenmay programmatically
 * from their own CRM, backend, or nightly sync job.
 *
 * Authentication:
 *   Authorization: Bearer shenmay_da_<key>
 *   Key is generated in the tenant portal → Settings → Data API.
 *   Stored as a bcrypt hash — never recoverable after generation.
 *
 * Endpoints:
 *   POST   /api/v1/customers                              — upsert a customer
 *   GET    /api/v1/customers                              — list customers
 *   POST   /api/v1/customers/:external_id/records         — push data records (bulk)
 *   DELETE /api/v1/customers/:external_id/records         — clear all records for customer
 *   DELETE /api/v1/customers/:external_id/records/:cat    — clear records for one category
 *   GET    /api/v1/customers/:external_id/records         — list records for a customer
 *
 * Rate limits:
 *   IP-level: applied upstream in index.js (120 req/min per IP)
 *   Key-level: per API key — 120 req/min default (DATA_API_RATE_LIMIT env var to override)
 *
 * Design decisions:
 *   - customers are identified by external_id (your CRM ID) — Shenmay UUID is returned but not required
 *   - records are upserted by (customer_id, category, label) — safe to re-push the same data
 *   - value is always stored as TEXT; numeric aggregation in tools handles parsing
 */

const router = require('express').Router();
const db     = require('../db');
const crypto = require('crypto');
const { encryptJson } = require('../services/cryptoService');

// ── Per-key rate limiting ──────────────────────────────────────────────────────
// Tracks request counts per API key prefix in memory.
// Window: 60 seconds. Limit: configurable via DATA_API_RATE_LIMIT env var (default 120).
const KEY_RATE_LIMIT  = parseInt(process.env.DATA_API_RATE_LIMIT || '120');
const KEY_RATE_WINDOW = 60 * 1000; // 1 minute in ms
const _keyRateMap     = new Map(); // prefix → { count, windowStart }

function checkKeyRateLimit(prefix) {
  const now     = Date.now();
  const entry   = _keyRateMap.get(prefix) || { count: 0, windowStart: now };

  if (now - entry.windowStart > KEY_RATE_WINDOW) {
    // New window
    entry.count       = 1;
    entry.windowStart = now;
    _keyRateMap.set(prefix, entry);
    return true;
  }

  entry.count++;
  _keyRateMap.set(prefix, entry);
  return entry.count <= KEY_RATE_LIMIT;
}

// Prune stale entries every 5 minutes to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _keyRateMap) {
    if (now - entry.windowStart > KEY_RATE_WINDOW * 2) _keyRateMap.delete(key);
  }
}, 5 * 60 * 1000);

// ── bcrypt (graceful fallback if not installed) ────────────────────────────────
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch {
  try { bcrypt = require('bcrypt'); } catch {
    bcrypt = null;
  }
}

// ── Auth middleware ────────────────────────────────────────────────────────────

// API key prefix for data ingestion — validated against bcrypt hash stored on tenants.
const DATA_API_KEY_PREFIX = 'shenmay_da_';

async function requireDataApiKey(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const key  = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;

    if (!key || !key.startsWith(DATA_API_KEY_PREFIX)) {
      return res.status(401).json({
        error: 'Missing or invalid API key. Pass: Authorization: Bearer shenmay_da_<key>',
      });
    }

    if (!bcrypt) {
      return res.status(500).json({ error: 'Server auth module not available.' });
    }

    // data_api_key_prefix stores the full prefix plus the first 8 chars of the
    // random tail — 19 chars total (11-char `shenmay_da_` + 8).
    const prefix = key.slice(0, DATA_API_KEY_PREFIX.length + 8);
    const { rows } = await db.query(
      `SELECT id AS tenant_id, data_api_key_hash
       FROM tenants
       WHERE data_api_key_prefix = $1 AND data_api_key_hash IS NOT NULL`,
      [prefix]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key.' });
    }

    const tenant = rows[0];
    const valid  = await bcrypt.compare(key, tenant.data_api_key_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid API key.' });
    }

    // Per-key rate limit — enforced after auth so anonymous probes don't consume quota
    if (!checkKeyRateLimit(prefix)) {
      return res.status(429).json({
        error: 'Rate limit exceeded.',
        detail: `This API key is limited to ${KEY_RATE_LIMIT} requests per minute. Please slow down or contact support to increase your limit.`,
      });
    }

    req.tenantId  = tenant.tenant_id;
    req.keyPrefix = prefix; // available for logging if needed
    next();
  } catch (err) {
    // A transient DB error or a bcrypt failure here used to become an unhandled
    // promise rejection — Express 4 does not forward async-middleware rejections
    // to the error handler — which terminated the single backend replica for
    // ALL tenants (widget chats mid-request included). Forward to the central
    // error handler so the request gets a clean 500 and the process survives.
    next(err);
  }
}


// ── Helper: resolve a customer by external_id, enforcing tenant scope ─────────
//
// Every /customers/:external_id/records handler shares this lookup. Returns
// the customer UUID string on success, or null after writing a 404 — the
// caller should `return;` immediately when null is returned. Caller can pass
// a custom 404 message (the POST endpoint suggests creating the customer
// first; GET/DELETE endpoints use a plain "not found" message).
async function resolveCustomerByExternalId(res, tenantId, externalId, notFoundMessage) {
  const { rows } = await db.query(
    `SELECT id FROM customers WHERE tenant_id = $1 AND external_id = $2 AND deleted_at IS NULL`,
    [tenantId, externalId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: notFoundMessage || `Customer "${externalId}" not found.` });
    return null;
  }
  return rows[0].id;
}


// ── POST /api/v1/customers ─────────────────────────────────────────────────────
// Create or update a customer by external_id.
// If a customer with this external_id already exists for this tenant, it is updated.
// Returns the Shenmay customer UUID.
//
// Body:
//   { external_id, name, email, phone?, metadata? }

router.post('/customers', requireDataApiKey, async (req, res, next) => {
  try {
    const { external_id, name, email, phone, metadata } = req.body;

    if (!external_id) return res.status(400).json({ error: 'external_id is required' });
    if (!name)        return res.status(400).json({ error: 'name is required' });

    // Fetch soul template to seed new customer soul_file
    const { rows: tRows } = await db.query(
      `SELECT agent_soul_template FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    const soulTemplate = tRows[0]?.agent_soul_template || null;

    const { rows } = await db.query(
      `INSERT INTO customers (tenant_id, external_id, name, email, phone, metadata, soul_file)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       ON CONFLICT (tenant_id, external_id)
       DO UPDATE SET
         name     = EXCLUDED.name,
         email    = COALESCE(EXCLUDED.email, customers.email),
         phone    = COALESCE(EXCLUDED.phone, customers.phone),
         metadata = COALESCE(EXCLUDED.metadata::jsonb, customers.metadata),
         updated_at = NOW()
       RETURNING id, external_id, name, email, created_at`,
      [req.tenantId, external_id, name, email || null, phone || null,
       metadata ? JSON.stringify(metadata) : null,
       JSON.stringify(encryptJson(soulTemplate || {}))]
    );

    res.status(201).json({ customer: rows[0] });
  } catch (err) { next(err); }
});


// ── GET /api/v1/customers ──────────────────────────────────────────────────────
// List customers for this tenant. Supports ?search=, ?limit=, ?offset=

router.get('/customers', requireDataApiKey, async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const search = req.query.search ? `%${req.query.search.slice(0, 200)}%` : null;

    const params = [req.tenantId, limit, offset];
    let searchClause = '';
    if (search) {
      params.push(search);
      searchClause = `AND (name ILIKE $4 OR email ILIKE $4 OR external_id ILIKE $4)`;
    }

    const { rows } = await db.query(
      `SELECT id, external_id, name, email, phone, created_at
       FROM customers
       WHERE tenant_id = $1
         AND deleted_at IS NULL
         ${searchClause}
       ORDER BY name
       LIMIT $2 OFFSET $3`,
      params
    );

    res.json({ customers: rows, limit, offset });
  } catch (err) { next(err); }
});


// ── POST /api/v1/customers/:external_id/records ───────────────────────────────
// Bulk push data records for a customer. Upserts by (customer_id, category, label).
// Safe to call repeatedly — no duplicate rows created.
//
// Body:
//   {
//     records: [
//       { category, label, value, secondary_value?, metadata?, value_type? }
//     ],
//     replace_category?: "portfolio"  // if set, deletes existing records in this
//                                     // category before inserting — useful for full syncs
//   }

router.post('/customers/:external_id/records', requireDataApiKey, async (req, res, next) => {
  try {
    const { external_id } = req.params;
    const { records = [], replace_category } = req.body;

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'records must be a non-empty array' });
    }

    if (records.length > 1000) {
      return res.status(400).json({ error: 'Maximum 1000 records per request' });
    }

    // Resolve customer
    const customerId = await resolveCustomerByExternalId(
      res, req.tenantId, external_id,
      `Customer with external_id "${external_id}" not found. Create them first via POST /api/v1/customers.`
    );
    if (customerId === null) return;

    // Optional: clear a category before full re-sync
    if (replace_category) {
      await db.query(
        `DELETE FROM customer_data WHERE customer_id = $1 AND category = $2`,
        [customerId, replace_category]
      );
    }

    // Upsert records
    let inserted = 0;
    const errors   = [];

    for (const rec of records) {
      const { category, label, value, secondary_value, metadata, value_type } = rec;

      if (!category || !label) {
        errors.push({ record: rec, error: 'category and label are required' });
        continue;
      }

      await db.query(
        `INSERT INTO customer_data
           (customer_id, category, label, value, secondary_value, metadata, value_type, source)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'api')
         ON CONFLICT (customer_id, category, label)
         DO UPDATE SET
           value           = EXCLUDED.value,
           secondary_value = EXCLUDED.secondary_value,
           metadata        = COALESCE(EXCLUDED.metadata, customer_data.metadata),
           value_type      = COALESCE(EXCLUDED.value_type, customer_data.value_type),
           recorded_at     = NOW()`,
        [
          customerId, category, label,
          value != null ? String(value) : null,
          secondary_value != null ? String(secondary_value) : null,
          metadata ? JSON.stringify(metadata) : null,
          value_type || null,
        ]
      );
      inserted++;
    }

    res.json({
      success:  true,
      inserted,
      errors:   errors.length ? errors : undefined,
      customer_id: customerId,
    });
  } catch (err) { next(err); }
});


// ── GET /api/v1/customers/:external_id/records ────────────────────────────────
// List all data records for a customer, grouped by category.
// Optional: ?category=portfolio

router.get('/customers/:external_id/records', requireDataApiKey, async (req, res, next) => {
  try {
    const { external_id } = req.params;
    const { category }    = req.query;

    const customerId = await resolveCustomerByExternalId(res, req.tenantId, external_id);
    if (customerId === null) return;

    const { rows } = await db.query(
      `SELECT category, label, value, secondary_value, metadata, value_type, recorded_at, source
       FROM customer_data
       WHERE customer_id = $1 ${category ? 'AND category = $2' : ''}
       ORDER BY category, label`,
      category ? [customerId, category] : [customerId]
    );

    // Group by category
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row);
    }

    res.json({ external_id, records: grouped, total: rows.length });
  } catch (err) { next(err); }
});


// ── DELETE /api/v1/customers/:external_id/records ─────────────────────────────
// Clear ALL data records for a customer.
// Use with caution — clears the entire customer_data history.

router.delete('/customers/:external_id/records', requireDataApiKey, async (req, res, next) => {
  try {
    const { external_id } = req.params;

    const customerId = await resolveCustomerByExternalId(res, req.tenantId, external_id);
    if (customerId === null) return;

    const { rowCount } = await db.query(
      `DELETE FROM customer_data WHERE customer_id = $1`,
      [customerId]
    );

    res.json({ success: true, deleted: rowCount });
  } catch (err) { next(err); }
});


// ── DELETE /api/v1/customers/:external_id/records/:category ───────────────────
// Clear records for a specific category only.

router.delete('/customers/:external_id/records/:category', requireDataApiKey, async (req, res, next) => {
  try {
    const { external_id, category } = req.params;

    const customerId = await resolveCustomerByExternalId(res, req.tenantId, external_id);
    if (customerId === null) return;

    const { rowCount } = await db.query(
      `DELETE FROM customer_data WHERE customer_id = $1 AND category = $2`,
      [customerId, category]
    );

    res.json({ success: true, deleted: rowCount, category });
  } catch (err) { next(err); }
});


module.exports = router;
