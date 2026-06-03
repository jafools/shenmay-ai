/**
 * SHENMAY AI — Tenant Onboarding Routes
 *
 * Self-serve registration and login for tenant admins at pontensolutions.com.
 * These routes are PUBLIC (no auth required).
 *
 *   POST /api/onboard/register              — Create a new tenant + send verification email
 *   GET  /api/onboard/verify/:token         — Verify email + issue portal JWT
 *   POST /api/onboard/resend-verification   — Re-send verification email
 *   POST /api/onboard/login                 — Authenticate a tenant admin
 *   POST /api/onboard/forgot-password       — Send password-reset email
 *   POST /api/onboard/reset-password        — Verify token + set new password
 *
 * Auth model:
 *   Issues a "portal JWT" with { portal: true, tenant_id, admin_id, email }.
 *   Consumed by all /api/portal/* routes.
 *   JWT is only issued AFTER email is verified.
 */

const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../db');
const { sendVerificationEmail, sendWelcomeEmail, sendPasswordResetEmail } = require('../services/emailService');
const { isSelfHosted, PLAN_LIMITS } = require('../config/plans');

const PORTAL_JWT_SECRET = process.env.JWT_SECRET || 'shenmay-dev-secret';
const PORTAL_JWT_EXPIRY = process.env.JWT_EXPIRY  || '7d';

// Allowed vertical values
const VALID_VERTICALS = [
  'financial',
  'retirement',
  'ministry',
  'healthcare',
  'insurance',
  'education',
  'ecommerce',
  'other',
];

// ── Helper: issue portal JWT ───────────────────────────────────────────────
function issueToken({ tenant_id, admin_id, email, role }) {
  return jwt.sign(
    { portal: true, tenant_id, admin_id, email, role },
    PORTAL_JWT_SECRET,
    { expiresIn: PORTAL_JWT_EXPIRY }
  );
}

// ── Helper: build the {token, tenant, admin} response body ─────────────────
//
// Two endpoints (verify, login) build the same payload from a freshly-loaded
// `row` object after issuing a portal JWT. The shape is consumed by
// client/src/contexts/ShenmayAuthContext.jsx.
//
// `row` must expose the columns listed below (verify omits widget_verified_at
// so the caller passes widgetVerified=false; login selects it and passes
// `row.widget_verified_at !== null`).
function buildAuthResponse(token, row, { widgetVerified }) {
  return {
    token,
    tenant: {
      id:               row.tenant_id,
      name:             row.tenant_name,
      slug:             row.slug,
      agent_name:       row.agent_name,
      widget_key:       row.widget_api_key,
      primary_color:    row.primary_color,
      secondary_color:  row.secondary_color,
      onboarding_steps: row.onboarding_steps,
      widget_verified:  widgetVerified,
    },
    admin: {
      id:         row.admin_id,
      email:      row.email,
      first_name: row.first_name,
      last_name:  row.last_name,
      role:       row.role,
    },
  };
}


// ── POST /api/onboard/register ─────────────────────────────────────────────
//
// Creates a new tenant and the first admin account for that tenant.
// Sends a verification email. Does NOT issue a JWT until email is confirmed.
//
router.post('/register', async (req, res, next) => {
  // Self-hosted deployments are single-tenant. The tenant is auto-seeded on
  // first boot. Allowing additional tenant registrations would be confusing
  // and could bypass license enforcement.
  if (isSelfHosted()) {
    return res.status(403).json({
      error: 'registration_disabled',
      message: 'This is a single-tenant self-hosted installation. Use the admin account created during setup.',
    });
  }

  try {
    const {
      email,
      password,
      first_name,
      last_name,
      company_name,
      vertical        = 'other',
      agent_name,
      primary_color   = '#1E3A5F',
      secondary_color = '#C9A84C',
      website_url,
      newsletter_opt_in = false,
      tos_accepted,   // must be true — tenant confirms right to upload customer data
    } = req.body;

    // ── Validation ──────────────────────────────────────────────────────────
    if (!email || !password || !company_name) {
      return res.status(400).json({
        error: 'email, password, and company_name are required',
      });
    }
    if (!tos_accepted) {
      return res.status(400).json({
        error: 'You must accept the Terms of Service and confirm you have the right to upload customer data.',
        field: 'tos_accepted',
        hint: 'Send {"tos_accepted": true} in the request body.',
      });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!VALID_VERTICALS.includes(vertical)) {
      return res.status(400).json({ error: `vertical must be one of: ${VALID_VERTICALS.join(', ')}` });
    }

    // ── Check email not already registered ─────────────────────────────────
    const { rows: existingEmail } = await db.query(
      'SELECT id FROM tenant_admins WHERE email = $1',
      [email.toLowerCase()]
    );
    if (existingEmail.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // ── Check company name not already taken (case-insensitive) ────────────
    const { rows: existingName } = await db.query(
      'SELECT id FROM tenants WHERE LOWER(name) = LOWER($1)',
      [company_name]
    );
    if (existingName.length > 0) {
      return res.status(409).json({
        error: 'A company with this name already exists. Please choose a different name or contact support if this is your company.',
        code:  'company_name_taken',
      });
    }

    // ── Create tenant ───────────────────────────────────────────────────────
    const tenantSlug    = company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const widgetApiKey  = crypto.randomBytes(32).toString('hex');
    const resolvedAgent = agent_name || `${company_name} Assistant`;

    const { rows: tenantRows } = await db.query(
      `INSERT INTO tenants (
         name, slug, agent_name, vertical,
         primary_color, secondary_color,
         widget_api_key, website_url,
         is_active, onboarding_steps
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, '{}')
       RETURNING id, name, slug, agent_name, widget_api_key, primary_color, secondary_color`,
      [
        company_name,
        tenantSlug,
        resolvedAgent,
        vertical,
        primary_color,
        secondary_color,
        widgetApiKey,
        website_url || null,
      ]
    );
    const tenant = tenantRows[0];

    // ── Create tenant admin ─────────────────────────────────────────────────
    const passwordHash = await bcrypt.hash(password, 10);
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                  || req.socket?.remoteAddress
                  || null;

    // Generate email verification token (expires 24h)
    const verificationToken   = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const { rows: adminRows } = await db.query(
      `INSERT INTO tenant_admins
         (tenant_id, email, password_hash, first_name, last_name, role,
          tos_accepted_at, tos_accepted_ip,
          email_verified, email_verification_token, email_verification_expires,
          newsletter_opt_in)
       VALUES ($1, $2, $3, $4, $5, 'owner', NOW(), $6,
               false, $7, $8, $9)
       RETURNING id, email, first_name, last_name, role`,
      [
        tenant.id,
        email.toLowerCase(),
        passwordHash,
        first_name || '',
        last_name  || '',
        clientIp,
        verificationToken,
        verificationExpires,
        newsletter_opt_in ? true : false,
      ]
    );
    const admin = adminRows[0];

    // ── Create trial subscription ─────────────────────────────────────────
    // Master account check: if the registering email matches MASTER_EMAIL env var,
    // give them a master plan that never expires
    const isMaster = process.env.MASTER_EMAIL
      && email.toLowerCase().trim() === process.env.MASTER_EMAIL.toLowerCase().trim();

    if (isMaster) {
      await db.query(
        `INSERT INTO subscriptions (tenant_id, plan, status, max_customers, max_messages_month, managed_ai_enabled,
           trial_ends_at)
         VALUES ($1, 'master', 'active', 99999, 999999, true, NOW() + INTERVAL '100 years')`,
        [tenant.id]
      );
      console.log(`[Onboard] MASTER account created for ${email}`);
    } else {
      // Trial limits come from the single source of truth (PLAN_LIMITS.trial),
      // NOT a hardcoded literal — otherwise a bump to the constant (e.g. the
      // v3.4.2 1/20 → 3/50 change) silently never reaches new SaaS signups.
      const t = PLAN_LIMITS.trial;
      await db.query(
        `INSERT INTO subscriptions (tenant_id, plan, status, max_customers, max_messages_month, managed_ai_enabled, max_agents)
         VALUES ($1, 'trial', 'active', $2, $3, $4, $5)`,
        [tenant.id, t.max_customers, t.max_messages_month, t.managed_ai, t.max_agents]
      );
    }

    // ── Send verification email (fire-and-forget) ─────────────────────────
    // Awaiting the SMTP send blocks the HTTP response — a 30s One.com
    // transient delay turns into a Cloudflare 504 and a broken signup.
    // The user doesn't need delivery confirmation inline (the "check your
    // email" message sets the right expectation); errors go to logs.
    sendVerificationEmail({
      to:        admin.email,
      token:     verificationToken,
      firstName: admin.first_name,
    }).catch(err => console.error('[Onboard] Verification email failed:', err.message));

    console.log(`[Onboard] New tenant registered (pending verification): ${company_name} <${email}>`);

    res.status(201).json({
      pending_verification: true,
      email:   admin.email,
      message: 'Please check your email to verify your account before logging in.',
    });

  } catch (err) { next(err); }
});


// ── GET /api/onboard/verify/:token ─────────────────────────────────────────
//
// Verifies an email address and issues a portal JWT.
// The token comes from the link in the verification email.
//
router.get('/verify/:token', async (req, res, next) => {
  try {
    const { token } = req.params;

    if (!token) return res.status(400).json({ error: 'Token required' });

    // Find admin with this token and check it hasn't expired
    const { rows } = await db.query(
      `SELECT
         a.id         AS admin_id,
         a.email,
         a.first_name,
         a.last_name,
         a.role,
         a.email_verified,
         t.id         AS tenant_id,
         t.name       AS tenant_name,
         t.slug,
         t.agent_name,
         t.widget_api_key,
         t.primary_color,
         t.secondary_color,
         t.onboarding_steps
       FROM tenant_admins a
       JOIN tenants t ON a.tenant_id = t.id
       WHERE a.email_verification_token = $1
         AND t.is_active = true`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification link. Please request a new one.' });
    }

    const row = rows[0];

    // Check expiry — unless already verified (idempotent re-use)
    if (!row.email_verified) {
      const { rows: adminDetail } = await db.query(
        'SELECT email_verification_expires FROM tenant_admins WHERE id = $1',
        [row.admin_id]
      );
      const expires = adminDetail[0]?.email_verification_expires;
      if (expires && new Date(expires) < new Date()) {
        return res.status(400).json({
          error: 'This verification link has expired. Please request a new one.',
          code:  'token_expired',
        });
      }
    }

    // Mark email as verified and clear the token
    await db.query(
      `UPDATE tenant_admins
       SET email_verified            = true,
           email_verification_token  = NULL,
           email_verification_expires = NULL,
           last_login_at             = NOW()
       WHERE id = $1`,
      [row.admin_id]
    );

    // Send welcome email (fire-and-forget)
    sendWelcomeEmail({
      to:          row.email,
      firstName:   row.first_name,
      companyName: row.tenant_name,
    }).catch(err => console.error('[Onboard] Welcome email failed:', err.message));

    // Issue portal JWT
    const jwtToken = issueToken({
      tenant_id: row.tenant_id,
      admin_id:  row.admin_id,
      email:     row.email,
      role:      row.role,
    });

    console.log(`[Onboard] Email verified: ${row.email}`);

    // verify query doesn't select widget_verified_at — admin is fresh out of
    // signup so widget cannot have been verified yet.
    res.json(buildAuthResponse(jwtToken, row, { widgetVerified: false }));

  } catch (err) { next(err); }
});


// ── POST /api/onboard/resend-verification ──────────────────────────────────
//
// Re-sends the verification email with a fresh token.
//
router.post('/resend-verification', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const { rows } = await db.query(
      'SELECT id, first_name, email_verified FROM tenant_admins WHERE email = $1',
      [email.toLowerCase()]
    );

    // Always return success to prevent email enumeration
    if (rows.length === 0 || rows[0].email_verified) {
      return res.json({ ok: true, message: 'If that email is registered and unverified, a new link has been sent.' });
    }

    const admin = rows[0];
    const newToken   = crypto.randomBytes(32).toString('hex');
    const newExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.query(
      `UPDATE tenant_admins
       SET email_verification_token   = $1,
           email_verification_expires = $2
       WHERE id = $3`,
      [newToken, newExpires, admin.id]
    );

    // Fire-and-forget — don't hold the response for SMTP.
    sendVerificationEmail({
      to:        email.toLowerCase(),
      token:     newToken,
      firstName: admin.first_name,
    }).catch(err => console.error('[Onboard] Resend verification email failed:', err.message));

    res.json({ ok: true, message: 'A new verification link has been sent to your email.' });

  } catch (err) { next(err); }
});


// ── POST /api/onboard/login ────────────────────────────────────────────────
//
// Authenticates a tenant admin and returns a fresh portal JWT.
// Blocks login if email has not been verified.
//
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    // ── Look up admin + their tenant ────────────────────────────────────────
    const { rows } = await db.query(
      `SELECT
         a.id             AS admin_id,
         a.email,
         a.password_hash,
         a.first_name,
         a.last_name,
         a.role,
         a.email_verified,
         t.id             AS tenant_id,
         t.name           AS tenant_name,
         t.slug,
         t.agent_name,
         t.widget_api_key,
         t.primary_color,
         t.secondary_color,
         t.onboarding_steps,
         t.widget_verified_at
       FROM tenant_admins a
       JOIN tenants t ON a.tenant_id = t.id
       WHERE a.email = $1 AND t.is_active = true`,
      [email.toLowerCase()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const row   = rows[0];
    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // ── Block unverified accounts ───────────────────────────────────────────
    if (!row.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email address before logging in. Check your inbox for a verification link.',
        code:  'email_unverified',
        email: row.email,
      });
    }

    // ── Update last_login_at ────────────────────────────────────────────────
    await db.query(
      'UPDATE tenant_admins SET last_login_at = NOW() WHERE id = $1',
      [row.admin_id]
    );

    // ── Issue portal JWT ────────────────────────────────────────────────────
    const token = issueToken({
      tenant_id: row.tenant_id,
      admin_id:  row.admin_id,
      email:     row.email,
      role:      row.role,
    });

    res.json(buildAuthResponse(token, row, {
      widgetVerified: row.widget_verified_at !== null,
    }));

  } catch (err) { next(err); }
});


// ── POST /api/onboard/forgot-password ──────────────────────────────────────
//
// Sends a password-reset email with a 1-hour token.
// Always returns success to prevent email enumeration.
//
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const { rows } = await db.query(
      'SELECT id, first_name, email_verified FROM tenant_admins WHERE email = $1',
      [email.toLowerCase()]
    );

    // Always return success to prevent email enumeration
    const successMsg = { ok: true, message: 'If that email is registered, a password reset link has been sent.' };

    if (rows.length === 0 || !rows[0].email_verified) {
      return res.json(successMsg);
    }

    const admin = rows[0];
    const resetToken   = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query(
      `UPDATE tenant_admins
       SET password_reset_token   = $1,
           password_reset_expires = $2
       WHERE id = $3`,
      [resetToken, resetExpires, admin.id]
    );

    // Fire-and-forget — the response is identical for "email sent" and
    // "no such account" anyway (to prevent enumeration); don't let SMTP
    // latency leak a timing side-channel either.
    sendPasswordResetEmail({
      to:        email.toLowerCase(),
      token:     resetToken,
      firstName: admin.first_name,
    }).catch(err => console.error('[Onboard] Password reset email failed:', err.message));

    res.json(successMsg);
  } catch (err) { next(err); }
});


// ── POST /api/onboard/reset-password ──────────────────────────────────────
//
// Verifies the reset token and sets a new password.
//
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, new_password } = req.body;

    if (!token || !new_password) {
      return res.status(400).json({ error: 'token and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const { rows } = await db.query(
      `SELECT id, email, first_name, password_reset_expires
       FROM tenant_admins
       WHERE password_reset_token = $1`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    const admin = rows[0];

    // Check expiry
    if (admin.password_reset_expires && new Date(admin.password_reset_expires) < new Date()) {
      return res.status(400).json({
        error: 'This reset link has expired. Please request a new one.',
        code:  'token_expired',
      });
    }

    // Hash new password and clear reset token
    const newHash = await bcrypt.hash(new_password, 10);

    await db.query(
      `UPDATE tenant_admins
       SET password_hash           = $1,
           password_reset_token    = NULL,
           password_reset_expires  = NULL
       WHERE id = $2`,
      [newHash, admin.id]
    );

    console.log(`[Onboard] Password reset: ${admin.email}`);

    res.json({ ok: true, message: 'Your password has been reset. You can now log in with your new password.' });
  } catch (err) { next(err); }
});


// ── GET /api/onboard/invite/:token ──────────────────────────────────────────
//
// Look up invite token — returns basic info (name of company, email).
// Used by the accept-invite page to pre-fill and validate the form.
//
router.get('/invite/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const { rows } = await db.query(
      `SELECT a.id, a.email, a.first_name, a.last_name, a.invite_expires_at,
              t.name AS company_name
       FROM tenant_admins a
       JOIN tenants t ON a.tenant_id = t.id
       WHERE a.invite_token = $1`,
      [token]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Invite link is invalid or has already been used.' });
    }
    const row = rows[0];
    if (row.invite_expires_at && new Date(row.invite_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This invite link has expired. Please ask to be re-invited.' });
    }
    res.json({
      email:        row.email,
      first_name:   row.first_name,
      last_name:    row.last_name,
      company_name: row.company_name,
    });
  } catch (err) { next(err); }
});


// ── POST /api/onboard/accept-invite ─────────────────────────────────────────
//
// Accept an agent invite: set password, mark email verified, issue JWT.
//
router.post('/accept-invite', async (req, res, next) => {
  try {
    const { token, password, first_name, last_name } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'token and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const { rows } = await db.query(
      `SELECT a.id AS admin_id, a.email, a.role, a.invite_expires_at, a.tenant_id,
              t.name AS company_name
       FROM tenant_admins a
       JOIN tenants t ON a.tenant_id = t.id
       WHERE a.invite_token = $1`,
      [token]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Invite link is invalid or has already been used.' });
    }
    const row = rows[0];
    if (row.invite_expires_at && new Date(row.invite_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This invite link has expired. Please ask to be re-invited.' });
    }

    const hash = await bcrypt.hash(password, 12);

    await db.query(
      `UPDATE tenant_admins
       SET password_hash    = $1,
           first_name       = COALESCE($2, first_name),
           last_name        = COALESCE($3, last_name),
           email_verified   = true,
           invite_token     = NULL,
           invite_expires_at = NULL,
           last_login_at    = NOW()
       WHERE id = $4`,
      [hash, first_name || null, last_name || null, row.admin_id]
    );

    const jwtToken = issueToken({
      tenant_id: row.tenant_id,
      admin_id:  row.admin_id,
      email:     row.email,
      role:      row.role,
    });

    res.json({
      token: jwtToken,
      admin: {
        id:           row.admin_id,
        email:        row.email,
        role:         row.role,
        company_name: row.company_name,
      },
    });
  } catch (err) { next(err); }
});


module.exports = router;
