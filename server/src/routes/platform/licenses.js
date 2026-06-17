/**
 * SHENMAY AI — Platform Admin: License Management
 *
 * GET    /api/platform/licenses             — List all licenses
 * POST   /api/platform/licenses             — Issue a new license key
 * GET    /api/platform/licenses/:id         — Get license detail
 * PATCH  /api/platform/licenses/:id/revoke  — Revoke a license
 * PATCH  /api/platform/licenses/:id/reactivate — Reactivate a revoked license
 * PATCH  /api/platform/licenses/:id/unbind  — Clear/transfer the instance binding
 * DELETE /api/platform/licenses/:id         — Hard-delete (use revoke instead)
 *
 * All routes require platform admin auth.
 * On issuance, an email with the key is sent to the operator.
 */

const router = require('express').Router();
const crypto = require('crypto');
const db     = require('../../db');
const { requirePlatformAuth } = require('../../middleware/platformAuth');
const { sendLicenseKeyEmail } = require('../../services/emailService');
const { VALID_LICENSE_PLANS } = require('../../config/plans');

router.use(requirePlatformAuth());

// ── Key generation ─────────────────────────────────────────────────────────────
// Format: SHENMAY-XXXX-XXXX-XXXX-XXXX  (readable, copy-pasteable)
// Legacy NOMII-prefixed keys remain valid (validation does an exact-string DB lookup);
// only newly issued keys carry the SHENMAY- prefix.
function generateLicenseKey() {
  const hex = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `SHENMAY-${hex.slice(0,4)}-${hex.slice(4,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}`;
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        id, license_key, plan, issued_to_email, issued_to_name,
        issued_at, expires_at, instance_id, last_ping_at, is_active, notes
      FROM licenses
      ORDER BY issued_at DESC
    `);
    res.json({ licenses: rows });
  } catch (err) { next(err); }
});

// Body: { issued_to_email, issued_to_name?, plan?, expires_at?, notes?, send_email? }
router.post('/', async (req, res, next) => {
  try {
    const {
      issued_to_email,
      issued_to_name,
      plan       = 'starter',
      expires_at = null,  // null = perpetual
      notes      = null,
      send_email = true,
    } = req.body;

    if (!issued_to_email) {
      return res.status(400).json({ error: 'issued_to_email is required' });
    }

    if (!VALID_LICENSE_PLANS.includes(plan)) {
      return res.status(400).json({ error: `plan must be one of: ${VALID_LICENSE_PLANS.join(', ')}` });
    }

    const license_key = generateLicenseKey();

    const { rows } = await db.query(
      `INSERT INTO licenses
         (license_key, plan, issued_to_email, issued_to_name, expires_at, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [license_key, plan, issued_to_email, issued_to_name || null, expires_at || null, notes || null]
    );

    const license = rows[0];

    // Email the key to the operator (best-effort — don't fail the API response)
    if (send_email) {
      sendLicenseKeyEmail({
        to:          issued_to_email,
        firstName:   issued_to_name || issued_to_email.split('@')[0],
        licenseKey:  license_key,
        plan,
        expiresAt:   expires_at,
      }).catch((err) => {
        console.warn('[License] Failed to send license key email:', err.message);
      });
    }

    res.status(201).json({ license });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM licenses WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'License not found' });
    res.json({ license: rows[0] });
  } catch (err) { next(err); }
});

router.patch('/:id/revoke', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE licenses SET is_active = FALSE WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'License not found' });
    res.json({ license: rows[0] });
  } catch (err) { next(err); }
});

router.patch('/:id/reactivate', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE licenses SET is_active = TRUE WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'License not found' });
    res.json({ license: rows[0] });
  } catch (err) { next(err); }
});

// PATCH /:id/unbind — clear (or transfer) the instance binding.
//
// The license master binds a key to the first instance_id that validates and
// rejects any mismatch ("License key is already bound … Contact support to
// transfer"). This is the admin-only transfer path (NOT self-serve): use it for
// legitimate server moves or domain changes that produced a new instance id.
//
//   * No body / { instance_id: null }  → clears the binding; the NEXT instance
//     that validates re-binds the key to itself.
//   * { instance_id: "<id>" }          → transfers the binding directly to a
//     known id (that exact instance must then validate to succeed).
//
// last_ping_at is reset so the dashboard/list clearly shows the key is awaiting
// its next bind rather than still reporting the old instance's last heartbeat.
router.patch('/:id/unbind', async (req, res, next) => {
  try {
    const newInstanceId =
      req.body && typeof req.body.instance_id === 'string' && req.body.instance_id.trim()
        ? req.body.instance_id.trim()
        : null;

    const { rows } = await db.query(
      `UPDATE licenses
          SET instance_id  = $1,
              last_ping_at = NULL
        WHERE id = $2
        RETURNING *`,
      [newInstanceId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'License not found' });
    res.json({ license: rows[0] });
  } catch (err) { next(err); }
});

// DELETE — hard delete. Prefer revoke for audit trail; use delete only for test data.
router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM licenses WHERE id = $1',
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'License not found' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
