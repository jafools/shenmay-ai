/**
 * SHENMAY AI — License Endpoints (cloud master only)
 *
 * POST /api/license/validate
 *   Called by self-hosted instances on startup + every 24h.
 *   Body: { license_key, instance_id }
 *   Returns: { valid, plan, expires_at }
 *
 * POST /api/license/trial
 *   Called once during install to register a trial instance.
 *   Body: { email, instance_id }
 *   Returns: { trial_key, expires_at, plan: 'trial' }
 *   Rate-limited: 3 trials per email ever, 5 per IP per day.
 *
 * Both endpoints are ONLY active when SHENMAY_LICENSE_MASTER=true.
 * Self-hosted instances do not expose these routes.
 */

const router = require('express').Router();
const crypto = require('crypto');
const db     = require('../db');
const { envVar } = require('../utils/env');

// Guard: only expose the validation endpoint on the master (cloud) instance.
// Self-hosted instances must NOT set SHENMAY_LICENSE_MASTER.
const isMaster = envVar('LICENSE_MASTER') === 'true';

router.post('/validate', async (req, res, next) => {
  if (!isMaster) {
    // On self-hosted instances, this route is intentionally absent.
    return res.status(404).json({ error: 'Not found' });
  }

  const { license_key, instance_id } = req.body;

  if (!license_key || typeof license_key !== 'string') {
    return res.status(400).json({ error: 'license_key is required' });
  }

  try {
    const { rows } = await db.query(
      `SELECT id, plan, expires_at, is_active, instance_id
       FROM licenses
       WHERE license_key = $1
       LIMIT 1`,
      [license_key.trim()]
    );

    if (rows.length === 0) {
      return res.status(403).json({ error: 'License key not found' });
    }

    const license = rows[0];

    if (!license.is_active) {
      return res.status(403).json({ error: 'License has been revoked' });
    }

    if (license.expires_at && new Date(license.expires_at) < new Date()) {
      return res.status(403).json({ error: 'License has expired' });
    }

    // On first use, bind the license to this instance_id.
    // On subsequent pings, reject if a different instance tries to use the same key.
    if (license.instance_id && instance_id && license.instance_id !== instance_id) {
      return res.status(403).json({
        error: 'License key is already bound to a different instance. Contact support to transfer.',
      });
    }

    // Record the instance_id and update last_ping_at
    await db.query(
      `UPDATE licenses
       SET instance_id  = COALESCE(instance_id, $1),
           last_ping_at = NOW()
       WHERE id = $2`,
      [instance_id || null, license.id]
    );

    return res.json({
      valid:      true,
      plan:       license.plan,
      expires_at: license.expires_at,
    });

  } catch (err) { next(err); }
});

// Trial key issuance: 14-day expiry, plan='trial' (20 msg/mo, 1 customer).
// One active trial per email — re-requests return the existing key.
router.post('/trial', async (req, res, next) => {
  if (!isMaster) {
    return res.status(404).json({ error: 'Not found' });
  }

  const { email, instance_id } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  try {
    // Check for an existing active trial for this email
    const { rows: existing } = await db.query(
      `SELECT id, license_key, expires_at
       FROM licenses
       WHERE issued_to_email = $1
         AND plan = 'trial'
         AND is_active = true
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [email.toLowerCase().trim()]
    );

    // Return the existing trial key rather than issuing a duplicate
    if (existing.length > 0) {
      return res.json({
        trial_key:  existing[0].license_key,
        expires_at: existing[0].expires_at,
        plan:       'trial',
        existing:   true,
      });
    }

    // Lifetime per-email cap (the documented "3 per email ever"). The active-
    // trial fast-path above already returns an in-flight key; this stops a
    // throwaway-email farm from minting unbounded keys over time — the DB index
    // on issued_to_email is non-unique, so nothing else bounds it.
    const { rows: priorRows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM licenses WHERE issued_to_email = $1 AND plan = 'trial'`,
      [email.toLowerCase().trim()]
    );
    if (priorRows[0].n >= 3) {
      return res.status(429).json({ error: 'Trial limit reached for this email. Please contact sales to continue.' });
    }

    // Generate new trial key (14-day expiry)
    const hex         = crypto.randomBytes(8).toString('hex').toUpperCase();
    const trial_key   = `SHENMAY-${hex.slice(0,4)}-${hex.slice(4,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}`;
    const expires_at  = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO licenses
         (license_key, plan, issued_to_email, expires_at, instance_id, is_active, notes)
       VALUES ($1, 'trial', $2, $3, $4, true, 'Auto-issued trial via install.sh')`,
      [trial_key, email.toLowerCase().trim(), expires_at, instance_id || null]
    );

    console.log(`[License] Trial issued: ${email} → ${trial_key} (expires ${expires_at.toDateString()})`);

    return res.status(201).json({
      trial_key,
      expires_at,
      plan: 'trial',
      existing: false,
    });

  } catch (err) { next(err); }
});

module.exports = router;
