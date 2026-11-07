/**
 * SHENMAY AI — Tenant Portal: Self-Hosted License Routes
 *
 * Sub-router mounted by ../portal.js at `/api/portal/license`.
 * All requests have already passed `requirePortalAuth` (set by the parent),
 * so `req.portal` is populated.
 *
 *   GET    /api/portal/license            — current license status (key masked)
 *   POST   /api/portal/license/activate   — validate + persist + lift limits
 *   DELETE /api/portal/license            — clear key + revert to trial limits
 *
 * These endpoints are only exposed on self-hosted instances. The
 * env-var path (`SHENMAY_LICENSE_KEY` in `.env`) still works and takes
 * precedence — operators who provisioned via install.sh aren't affected.
 */

const router = require('express').Router();
const { isSelfHosted } = require('../../config/plans');
const { envVar }       = require('../../utils/env');

function requireSelfHostedDeployment(req, res, next) {
  if (!isSelfHosted()) {
    return res.status(404).json({ error: 'Not available on this deployment' });
  }
  next();
}

router.use(requireSelfHostedDeployment);

// GET /api/portal/license  — current license status (key masked)
router.get('/', async (req, res, next) => {
  try {
    const { getLicenseStatus } = require('../../services/licenseService');
    const status = await getLicenseStatus(req.portal.tenant_id);
    if (!status) return res.status(404).json({ error: 'Tenant not found' });
    res.json(status);
  } catch (err) { next(err); }
});

// POST /api/portal/license/activate  — validate + persist + lift limits
router.post('/activate', async (req, res, next) => {
  try {
    const { license_key } = req.body || {};
    if (!license_key || !license_key.trim()) {
      return res.status(400).json({ error: 'License key is required' });
    }
    if (envVar('LICENSE_KEY')) {
      return res.status(409).json({
        error: 'A license key is already pinned in SHENMAY_LICENSE_KEY. Remove it from .env and restart, then re-activate from the dashboard.',
      });
    }

    const { activateLicense } = require('../../services/licenseService');
    const result = await activateLicense(license_key.trim(), req.portal.tenant_id);

    res.json({
      activated:  true,
      plan:       result.plan,
      expires_at: result.expires_at,
    });
  } catch (err) {
    // callValidate throws "License invalid: <reason>" — bubble that to the user
    if (err.message && err.message.startsWith('License invalid:')) {
      return res.status(400).json({ error: err.message.replace('License invalid: ', '') });
    }
    // The license server couldn't be reached at all (DNS, network, timeout).
    // Not the key's fault and nothing was changed, so say that instead of a 500.
    if (err.code === 'LICENSE_SERVER_UNREACHABLE') {
      return res.status(503).json({
        error: "Couldn't reach the Shenmay license server. Check this server's internet connection and try again. Your current plan hasn't changed.",
      });
    }
    next(err);
  }
});

// DELETE /api/portal/license  — clear key + revert to trial limits
router.delete('/', async (req, res, next) => {
  try {
    if (envVar('LICENSE_KEY')) {
      return res.status(409).json({
        error: 'License is pinned in SHENMAY_LICENSE_KEY. Remove it from .env and restart to deactivate from the dashboard.',
      });
    }
    const { deactivateLicense } = require('../../services/licenseService');
    await deactivateLicense(req.portal.tenant_id);
    res.json({ deactivated: true });
  } catch (err) { next(err); }
});

module.exports = router;
