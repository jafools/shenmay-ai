/**
 * Public Customer License Portal — Shenmay-native auth
 *
 * This module serves the customer-facing license portal at pontensolutions.com/license.
 * Flow:
 *   POST /api/public/portal/request-login   { email }             → sends magic link
 *   POST /api/public/portal/verify          { token }             → issues session
 *   GET  /api/public/portal/licenses        (Bearer session)       → list licenses
 *   POST /api/public/portal/logout          (Bearer session)       → revoke session
 *
 * Only Shenmay (ex-Nomii) self-hosted licenses are served here — Kaldryn
 * licenses have their own portal infra. An email with zero Shenmay licenses
 * gets the enumeration-safe `{ok:true}` response with no actual email sent.
 *
 * Gate: only active when SHENMAY_LICENSE_MASTER=true (cloud instance only).
 */

const express  = require('express');
const crypto   = require('crypto');
const db       = require('../db');
const { envVar } = require('../utils/env');
const { sendPortalMagicLinkEmail } = require('../services/emailService');

const router = express.Router();

// ── Constants ────────────────────────────────────────────────────────────────

const TOKEN_TTL_SECONDS   = 15 * 60;          // 15 min for magic-link tokens
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days for sessions

const RATE_LIMIT_PER_EMAIL = 5;   // requests/hour
const RATE_LIMIT_PER_IP    = 20;  // requests/hour

const PUBLIC_PORTAL_URL =
  (process.env.PUBLIC_PORTAL_URL || 'https://pontensolutions.com/license').replace(/\/$/, '');

// ── Utilities ────────────────────────────────────────────────────────────────

function isLicenseMaster() {
  return envVar('LICENSE_MASTER') === 'true';
}

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function clientIp(req) {
  // Use req.ip, which Express derives correctly under the app's `trust proxy`
  // setting (index.js) — it strips the proxy-appended hops and yields the
  // Cloudflare-reported client. The raw X-Forwarded-For[0] is the LEFTMOST
  // entry, which a client can spoof, so it must not key a rate limiter.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function hourBucket() {
  return Math.floor(Date.now() / 3_600_000);
}

async function incrementRateLimit(scope, identifier) {
  const bucket = hourBucket();
  const { rows } = await db.query(
    `INSERT INTO portal_rate_limits (scope, identifier, bucket_hour, count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (scope, identifier, bucket_hour)
       DO UPDATE SET count = portal_rate_limits.count + 1
     RETURNING count`,
    [scope, identifier, bucket]
  );
  return rows[0].count;
}

// Shape mirrors docs/portal-api.md in the ponten-solutions repo:
//   200 → { ok:true } whether-or-not licenses exist (enumeration defense)
//   400 → { ok:false, error:'invalid_email' | 'malformed_request' }
//   429 → { ok:false, error:'rate_limited', retry_after_seconds }
//   401 → { ok:false, error:'missing_auth' | 'invalid_session' | 'expired_session' }
function errBody(code, extras = {}) {
  return { ok: false, error: code, ...extras };
}

// ── POST /request-login ──────────────────────────────────────────────────────

router.post('/request-login', async (req, res) => {
  if (!isLicenseMaster()) return res.status(404).json({ ok: false, error: 'not_available' });

  const emailRaw = req.body?.email;
  if (!emailRaw || typeof emailRaw !== 'string') {
    return res.status(400).json(errBody('malformed_request'));
  }
  const email = normalizeEmail(emailRaw);
  if (!isValidEmail(email)) {
    return res.status(400).json(errBody('invalid_email'));
  }

  // Rate-limit check FIRST, before any email_index lookup, so behavior doesn't
  // differ between rate-limited and normal paths (enumeration defense).
  try {
    const [emailCount, ipCount] = await Promise.all([
      incrementRateLimit('email', email),
      incrementRateLimit('ip', clientIp(req)),
    ]);
    if (emailCount > RATE_LIMIT_PER_EMAIL || ipCount > RATE_LIMIT_PER_IP) {
      // 3600s retry window — bucket is hourly
      return res.status(429).json(errBody('rate_limited', { retry_after_seconds: 3600 }));
    }
  } catch (err) {
    console.error('[Portal] rate-limit check failed:', err.message);
    // Fail open (don't hard-block the portal on counter failure)
  }

  // Look up active, non-expired Shenmay licenses for this email.
  let hasLicense = false;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM licenses
        WHERE LOWER(issued_to_email) = $1
          AND is_active = true
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1`,
      [email]
    );
    hasLicense = rows.length > 0;
  } catch (err) {
    console.error('[Portal] license lookup failed:', err.message);
    // Fail closed for safety — return ok:true so we don't leak DB state via a
    // differential response, but don't send an email we can't generate a token for.
    return res.status(200).json({ ok: true });
  }

  if (!hasLicense) {
    // Enumeration defense: same response as the happy path.
    return res.status(200).json({ ok: true });
  }

  // Generate + persist a magic-link token.
  const token = newToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);
  try {
    await db.query(
      `INSERT INTO portal_login_tokens (token, email, expires_at)
       VALUES ($1, $2, $3)`,
      [token, email, expiresAt]
    );
  } catch (err) {
    console.error('[Portal] token insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }

  const verifyUrl = `${PUBLIC_PORTAL_URL}/verify?token=${encodeURIComponent(token)}`;

  // Fire-and-forget the email send so the response returns immediately.
  // The token is already persisted; if SMTP transient-fails, the user
  // can request a new link rather than the request handler hanging long
  // enough for Cloudflare to 504. SMTP errors land in the logs.
  sendPortalMagicLinkEmail({ to: email, verifyUrl }).catch((err) => {
    console.error('[Portal] magic-link send failed:', err.message);
  });

  return res.status(200).json({ ok: true });
});

// ── POST /verify ─────────────────────────────────────────────────────────────

router.post('/verify', async (req, res) => {
  if (!isLicenseMaster()) return res.status(404).json({ ok: false, error: 'not_available' });

  const token = req.body?.token;
  if (!token || typeof token !== 'string') {
    return res.status(400).json(errBody('malformed_request'));
  }

  // Atomically consume the token (single-use enforcement). If it's already
  // consumed OR expired OR never-existed, treat all three as invalid_token.
  let row;
  try {
    const result = await db.query(
      `UPDATE portal_login_tokens
          SET consumed_at = NOW()
        WHERE token = $1
          AND consumed_at IS NULL
          AND expires_at > NOW()
        RETURNING email`,
      [token]
    );
    row = result.rows[0];
  } catch (err) {
    console.error('[Portal] token consume failed:', err.message);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }

  if (!row) {
    return res.status(400).json(errBody('invalid_token'));
  }

  // Issue a session token.
  const sessionToken = newToken();
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  try {
    await db.query(
      `INSERT INTO portal_sessions (session_token, email, expires_at)
       VALUES ($1, $2, $3)`,
      [sessionToken, row.email, sessionExpiresAt]
    );
  } catch (err) {
    console.error('[Portal] session insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }

  return res.status(200).json({
    ok: true,
    session_token: sessionToken,
    email: row.email,
    expires_at: sessionExpiresAt.toISOString(),
  });
});

// ── Bearer-auth helper ───────────────────────────────────────────────────────

async function authenticateSession(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json(errBody('missing_auth'));
    return null;
  }
  const sessionToken = match[1].trim();

  let row;
  try {
    const result = await db.query(
      `SELECT email, expires_at, revoked_at
         FROM portal_sessions
        WHERE session_token = $1`,
      [sessionToken]
    );
    row = result.rows[0];
  } catch (err) {
    console.error('[Portal] session lookup failed:', err.message);
    res.status(500).json({ ok: false, error: 'internal_error' });
    return null;
  }

  if (!row || row.revoked_at) {
    res.status(401).json(errBody('invalid_session'));
    return null;
  }
  if (new Date(row.expires_at) <= new Date()) {
    res.status(401).json(errBody('expired_session'));
    return null;
  }

  return { email: row.email, sessionToken };
}

// ── GET /licenses ────────────────────────────────────────────────────────────

router.get('/licenses', async (req, res) => {
  if (!isLicenseMaster()) return res.status(404).json({ ok: false, error: 'not_available' });

  const session = await authenticateSession(req, res);
  if (!session) return; // authenticateSession already responded

  try {
    const { rows } = await db.query(
      `SELECT id, license_key, plan, issued_to_email, issued_at,
              expires_at, is_active, instance_id, last_ping_at
         FROM licenses
        WHERE LOWER(issued_to_email) = $1
        ORDER BY issued_at DESC`,
      [session.email]
    );

    const licenses = rows.map((r) => ({
      license_id:  String(r.id),
      license_key: r.license_key,
      plan:        r.plan,
      status:      !r.is_active
        ? 'revoked'
        : (r.expires_at && new Date(r.expires_at) < new Date() ? 'expired' : 'active'),
      issued_at:    r.issued_at?.toISOString() ?? null,
      expires_at:   r.expires_at?.toISOString() ?? null,
      instance_id:  r.instance_id ?? null,
      last_ping_at: r.last_ping_at?.toISOString() ?? null,
    }));

    return res.json({ email: session.email, product: 'shenmay', licenses });
  } catch (err) {
    console.error('[Portal] license query failed:', err.message);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ── POST /logout ─────────────────────────────────────────────────────────────

router.post('/logout', async (req, res) => {
  if (!isLicenseMaster()) return res.status(404).json({ ok: false, error: 'not_available' });

  const session = await authenticateSession(req, res);
  if (!session) return;

  try {
    await db.query(
      `UPDATE portal_sessions
          SET revoked_at = NOW()
        WHERE session_token = $1`,
      [session.sessionToken]
    );
  } catch (err) {
    console.error('[Portal] logout failed:', err.message);
    // Idempotent — return ok:true even on failure, client clears local state anyway.
  }

  return res.status(200).json({ ok: true });
});

module.exports = router;
