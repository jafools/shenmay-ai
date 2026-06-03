/**
 * SHENMAY AI — Portal Owner Gate
 *
 * Use AFTER requirePortalAuth (which sets req.portal = { tenant_id, admin_id,
 * email, role }). Roles, most-to-least privileged: owner > member ("Admin") >
 * agent.
 *
 * `requireOwner` restricts an action to the tenant account owner — mirroring the
 * inline `req.portal.role === 'owner'` checks already used by the privacy /
 * anonymous-only-mode / brand-learning routes, centralized so newly-added portal
 * sub-routers can't silently ship un-gated mutations.
 *
 * `requireOwnerForWrites` is a mount-level guard: read-only methods (GET/HEAD/
 * OPTIONS) pass through to any authenticated seat, but every state-changing
 * method (POST/PUT/PATCH/DELETE) requires owner. Applied at a sub-router mount,
 * it owner-gates the whole write surface by default — the fix for sub-routers
 * (api-key, connectors, webhooks, tools) that previously enforced only
 * requirePortalAuth, letting any seat (including a low-privilege agent) mutate
 * tenant-wide config.
 */

'use strict';

function requireOwner(req, res, next) {
  if (!req.portal || req.portal.role !== 'owner') {
    return res.status(403).json({ error: 'Only the account owner can perform this action.' });
  }
  return next();
}

function requireOwnerForWrites(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  return requireOwner(req, res, next);
}

module.exports = { requireOwner, requireOwnerForWrites };
