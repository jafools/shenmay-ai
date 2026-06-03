/**
 * SHENMAY AI — Tenant Portal: Products / Services
 *
 * Sub-router mounted by ../portal.js at `/api/portal/products`.
 * All requests have already passed `requirePortalAuth` (set by the parent),
 * so `req.portal` is populated.
 *
 *   GET    /api/portal/products              — list products/services
 *   POST   /api/portal/products              — add a product
 *   PUT    /api/portal/products/:id          — edit a product
 *   DELETE /api/portal/products/:id          — remove a product
 *   POST   /api/portal/products/upload       — bulk CSV import
 *   POST   /api/portal/products/ai-suggest   — AI extraction from URL or description (preview only)
 *   POST   /api/portal/products/bulk-save    — save AI-suggested products after user approval
 */

const router = require('express').Router();
const { parse: csvParse } = require('csv-parse/sync');

const db = require('../../db');
const { validateWebhookUrlAsync } = require('../../utils/validateWebhookUrl');
const { resolveApiKey, callClaude, buildTokenizer } = require('../../services/llmService');
const { BreachError } = require('../../services/piiTokenizer');
const { markStepComplete } = require('../../utils/onboarding');

// GET /api/portal/products
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, description, category, price_info, notes, metadata, sort_order, created_at
       FROM tenant_products
       WHERE tenant_id = $1
       ORDER BY sort_order ASC, created_at ASC`,
      [req.portal.tenant_id]
    );
    res.json({ products: rows });
  } catch (err) { next(err); }
});

const MAX_CSV_UPLOAD_ROWS = 10000;

// POST /api/portal/products/upload  (declared before /:id routes so Express matches it)
router.post('/upload', async (req, res, next) => {
  try {
    const { csv } = req.body;  // raw CSV string sent from Lovable
    if (!csv) return res.status(400).json({ error: 'csv field required' });

    let records;
    try {
      records = csvParse(csv, { columns: true, skip_empty_lines: true, trim: true });
    } catch {
      return res.status(400).json({ error: 'Could not parse CSV — check formatting' });
    }

    if (records.length === 0) return res.status(400).json({ error: 'CSV contains no rows' });
    // Cap bulk rows per upload — bounds per-row DB-write amplification on the
    // shared pool (mirrors the data API's 1000-record cap, looser for bulk import).
    if (records.length > MAX_CSV_UPLOAD_ROWS) {
      return res.status(400).json({ error: `CSV has too many rows (${records.length}). Maximum ${MAX_CSV_UPLOAD_ROWS} per upload — split the file and retry.` });
    }

    let inserted = 0;
    for (const row of records) {
      const name = row.name || row.Name || row.product || row.Product;
      if (!name) continue;

      await db.query(
        `INSERT INTO tenant_products (tenant_id, name, description, category, price_info, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.portal.tenant_id,
          name.trim(),
          (row.description || row.Description || '').trim() || null,
          (row.category    || row.Category    || '').trim() || null,
          (row.price       || row.price_info  || row.Price  || '').trim() || null,
          (row.notes       || row.Notes       || '').trim() || null,
        ]
      );
      inserted++;
    }

    await markStepComplete(req.portal.tenant_id, 'products');
    res.json({ ok: true, inserted });
  } catch (err) { next(err); }
});

// POST /api/portal/products
// Body: { name: string (required),
//         description?, category?, price_info?, notes?: string }
router.post('/', async (req, res, next) => {
  try {
    const { name, description, category, price_info, notes } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const { rows } = await db.query(
      `INSERT INTO tenant_products (tenant_id, name, description, category, price_info, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.portal.tenant_id,
       name.trim().slice(0, 255),
       typeof description === 'string' ? description.slice(0, 2000) : null,
       typeof category    === 'string' ? category.slice(0, 100)     : null,
       typeof price_info  === 'string' ? price_info.slice(0, 255)   : null,
       typeof notes       === 'string' ? notes.slice(0, 1000)       : null]
    );

    await markStepComplete(req.portal.tenant_id, 'products');
    res.status(201).json({ product: rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/portal/products/:id
router.put('/:id', async (req, res, next) => {
  try {
    const { name, description, category, price_info, notes, sort_order } = req.body;

    const { rowCount } = await db.query(
      `UPDATE tenant_products SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         category    = COALESCE($3, category),
         price_info  = COALESCE($4, price_info),
         notes       = COALESCE($5, notes),
         sort_order  = COALESCE($6, sort_order)
       WHERE id = $7 AND tenant_id = $8`,
      [name, description, category, price_info, notes, sort_order,
       req.params.id, req.portal.tenant_id]
    );

    if (rowCount === 0) return res.status(404).json({ error: 'Product not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/portal/products/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await db.query(
      'DELETE FROM tenant_products WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.portal.tenant_id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});


// POST /api/portal/products/ai-suggest
// Accepts { url } OR { description }.
// For URL: fetches the page, strips HTML, sends to Claude.
// For description: sends text directly to Claude.
// Returns proposed products array — NOT saved yet. Frontend shows a preview.
router.post('/ai-suggest', async (req, res, next) => {
  try {
    let sourceText = '';
    let sourceLabel = '';

    if (req.body.url) {
      // ── URL path: fetch + strip HTML ──────────────────────────────────────
      let url = req.body.url.trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

      // SSRF guard: require HTTPS + reject hosts that resolve to internal IPs.
      const urlErr = await validateWebhookUrlAsync(url);
      if (urlErr) return res.status(400).json({ error: `Could not use that URL: ${urlErr}` });

      let html;
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NomiiBot/1.0)' },
          redirect: 'manual', // don't let a public URL 3xx-redirect to an internal host
          signal: AbortSignal.timeout(10000),
        });
        if (resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400)) {
          return res.status(422).json({ error: 'That URL attempted a redirect, which is blocked. Use the final URL, or paste a description instead.' });
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        html = await resp.text();
      } catch {
        // Generic message — do NOT reflect the fetch error (would be a host/port oracle).
        return res.status(422).json({ error: 'Could not fetch that URL. Check it is publicly reachable, or paste a description instead.' });
      }

      // Strip tags, collapse whitespace, cap at ~8 000 chars to keep tokens low
      sourceText = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);

      sourceLabel = `website (${url})`;

      if (sourceText.length < 300) {
        return res.status(422).json({
          error: 'The page returned very little readable text — it may be a JavaScript-only site. Try pasting a description of what you offer instead.',
          fallback: true,
        });
      }

    } else if (req.body.description) {
      // ── Description path: use text directly ───────────────────────────────
      sourceText  = req.body.description.trim().slice(0, 8000);
      sourceLabel = 'description';
      if (sourceText.length < 20) {
        return res.status(400).json({ error: 'Description is too short to extract products from.' });
      }

    } else {
      return res.status(400).json({ error: 'Provide either a url or a description.' });
    }

    // Load tenant for tokenizer + API key resolution. Scraped website HTML
    // can carry staff emails, phone numbers, physical addresses; a free-text
    // description can too. Route the call through the same tokenize-before-
    // Anthropic guarantee the chat and CSV-import paths use.
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

    // ── Claude extraction ────────────────────────────────────────────────────
    const systemPrompt = `You are a data extraction assistant. Extract products and services from company content.
You must respond with ONLY a raw JSON array. No markdown. No code fences. No explanation. No text before or after.
Start your response with [ and end with ].
Each element must have exactly these string fields (use "" if unknown):
  "name"        - product or service name (required)
  "description" - 1-2 sentence description
  "category"    - one of: Product, Service, Plan, Package, Course, Membership, Other
  "price_info"  - any pricing mentioned, or ""
  "notes"       - any other useful detail, or ""
Extract up to 20 items. If no products or services are identifiable, respond with exactly: [].

The source content may contain opaque tokens like [EMAIL_N], [PHONE_N], [POSTCODE_N]
where a staff email, phone, or postcode was redacted before send. Treat those
tokens as non-product text — never copy them into product names, descriptions,
or notes. They are not data to extract.`;

    const userPrompt = `Extract products and services from this company's ${sourceLabel} as a JSON array:\n\n${sourceText}`;

    let rawText;
    try {
      rawText = await callClaude(
        systemPrompt,
        [{ role: 'user', content: userPrompt }],
        tenant.llm_provider === 'openai'
          ? (process.env.LLM_OPENAI_MINI_MODEL || 'gpt-4o-mini')
          : (process.env.LLM_HAIKU_MODEL || 'claude-haiku-4-5-20251001'),
        2048,
        apiKey,
        {
          tokenizer,
          breachCtx: {
            tenantId: req.portal.tenant_id,
            callSite: 'products_ai_suggest',
          },
          provider: tenant.llm_provider,
        }
      );
    } catch (err) {
      if (err instanceof BreachError) {
        return res.status(422).json({
          error: 'The content had unredacted personal data that our safety check blocked. Try pasting a shorter description without staff contact details, or pick a different page.',
          blocked_by_pii_guard: true,
        });
      }
      throw err;
    }

    let proposed = [];
    try {
      let raw = rawText.trim();

      // Strip markdown code fences if the model wrapped its output anyway
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

      // If the array is embedded in surrounding text, extract it
      const arrayMatch = raw.match(/\[[\s\S]*\]/);
      if (arrayMatch) raw = arrayMatch[0];

      proposed = JSON.parse(raw);
      if (!Array.isArray(proposed)) proposed = [];

      // Sanitise: ensure every item has the expected string fields
      proposed = proposed
        .filter(p => p && typeof p.name === 'string' && p.name.trim())
        .map(p => ({
          name:        (p.name        || '').trim(),
          description: (p.description || '').trim(),
          category:    (p.category    || 'Other').trim(),
          price_info:  (p.price_info  || '').trim(),
          notes:       (p.notes       || '').trim(),
        }));

    } catch {
      // Log the raw output to help debug future issues
      console.error('[ai-suggest] JSON parse failed. Raw output:', rawText?.slice(0, 500));
      return res.status(500).json({ error: 'AI returned an unexpected format. Try again or use the manual/CSV method.' });
    }

    // If we got content but zero products, treat as a soft fallback
    if (proposed.length === 0 && sourceText.length > 500) {
      return res.status(422).json({
        error: 'We couldn\'t identify distinct products or services from that content. Try pasting a description of what you offer instead.',
        fallback: true,
      });
    }

    res.json({ proposed, count: proposed.length });
  } catch (err) { next(err); }
});


// POST /api/portal/products/bulk-save
// Saves an array of products (from AI preview) the tenant approved.
router.post('/bulk-save', async (req, res, next) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'No products provided.' });
    }

    let saved = 0;
    for (const p of products) {
      if (!p.name) continue;
      await db.query(
        `INSERT INTO tenant_products (tenant_id, name, description, category, price_info, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.portal.tenant_id,
          (p.name        || '').slice(0, 255),
          (p.description || '').slice(0, 1000),
          (p.category    || 'Other').slice(0, 100),
          (p.price_info  || '').slice(0, 255),
          (p.notes       || '').slice(0, 500),
        ]
      );
      saved++;
    }

    await markStepComplete(req.portal.tenant_id, 'products');
    res.json({ ok: true, saved });
  } catch (err) { next(err); }
});

module.exports = router;
