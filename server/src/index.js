/**
 * SHENMAY AI — Server Entry Point
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { securityHeaders, portalCors } = require('./middleware/security');
const { isSelfHosted, DEPLOYMENT_MODES } = require('./config/plans');

// ── Startup secret validation ──────────────────────────────────────────────────
// Refuse to start in production with known-default secrets.
(function validateSecrets() {
  const BAD_SECRETS = new Set([
    'shenmay-dev-secret',
    'shenmay-dev-secret-change-in-production',
    'widget-dev-secret',
    'shenmay-dev-encryption-key',
    // Legacy nomii-prefixed dev secrets — kept in the deny-list so any stale
    // .env from before the v3.0.x rebrand still trips the prod boot check.
    'nomii-dev-secret',
    'nomii-dev-secret-change-in-production',
    'nomii-dev-encryption-key',
  ]);
  const isProd = process.env.NODE_ENV === 'production';
  const checks = [
    ['JWT_SECRET',                process.env.JWT_SECRET],
    ['WIDGET_JWT_SECRET',         process.env.WIDGET_JWT_SECRET],
    ['API_KEY_ENCRYPTION_SECRET', process.env.API_KEY_ENCRYPTION_SECRET],
  ];
  const issues = checks.filter(([, v]) => !v || BAD_SECRETS.has(v)).map(([k]) => k);
  if (issues.length > 0) {
    const msg = `[Security] WEAK / MISSING secrets: ${issues.join(', ')}`;
    if (isProd) {
      console.error(msg);
      console.error('[Security] Refusing to start in production with default secrets. Set proper values in .env');
      process.exit(1);
    } else {
      console.warn(msg);
      console.warn('[Security] Running with development fallback secrets — NEVER use this in production.\n');
    }
  }
})();

const app  = express();
const PORT = process.env.PORT || 3001;

// Trust the first proxy (Cloudflare Tunnel adds X-Forwarded-For)
// Required for express-rate-limit to correctly identify client IPs
app.set('trust proxy', 1);

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Helper extracted to ./middleware/rate-limit.js so widget.js can use the same
// install-or-passthrough pattern for its post-auth per-session/per-tenant
// limiters added in v3.3.15 (defense-in-depth follow-up to v3.3.14).
const { makeRateLimiter } = require('./middleware/rate-limit');

// Widget session creation: 60 new sessions per 5 min per IP
// Prevents widget-key scraping and anonymous session flooding while still
// accommodating shared-NAT scenarios (corporate office, mobile carriers,
// Cloudflare exit pools) where many real visitors share an outbound IP.
// Override via WIDGET_SESSION_RATE_LIMIT_MAX. Bumped from 6 → 60 in v3.3.14
// after the Apr 27 PM 50-concurrent load test exposed real customers behind
// shared NAT could be throttled at single-digit visitor counts.
const widgetSessionLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max:      parseInt(process.env.WIDGET_SESSION_RATE_LIMIT_MAX || '60', 10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many session requests. Please wait a moment.' },
});

// Widget chat: 100 messages per minute per IP
// Primary cost-protection guard — each message calls the LLM. Bumped from
// 10 → 100 in v3.3.14 after the Apr 27 PM load test showed 50 concurrent
// chats from a single IP (= corporate office NAT scenario) hit 0/50 success
// at the old limit. 100/min/IP still defends against single-attacker abuse
// while letting realistic NAT traffic through.
// Tighter per-tenant + per-session limits would be a better defense-in-depth
// posture (deferred — would require moving the limiter into the route after
// requireWidgetAuth so we can key by widget_key or session JWT).
const widgetChatLimiter = makeRateLimiter({
  windowMs: 60 * 1000,
  max:      parseInt(process.env.WIDGET_CHAT_RATE_LIMIT_MAX || '100', 10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Message rate limit reached. Please slow down.' },
});

// Tenant registration: 3 per hour per IP (prevents spam accounts)
// Override via REGISTER_RATE_LIMIT_MAX env var for test environments or
// shared-IP situations (corporate NAT, office networks) where 3 per hour
// is too aggressive.
const registerLimiter = makeRateLimiter({
  windowMs: 60 * 60 * 1000,
  max:      parseInt(process.env.REGISTER_RATE_LIMIT_MAX || '3', 10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many registration attempts. Try again later.' },
});

// Tenant + portal login: 3 per 15 min per IP (brute-force protection).
// Override via LOGIN_RATE_LIMIT_MAX env var — useful for test environments
// where many auth calls happen in quick succession (e.g. set to 200 in .env).
const loginLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max:      parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '3', 10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

// License trial issuance (license-master only): cap throwaway-email trial-key
// farming. The /trial handler additionally enforces a 3-per-email lifetime cap.
const licenseTrialLimiter = makeRateLimiter({
  windowMs: 60 * 60 * 1000,
  max:      parseInt(process.env.LICENSE_TRIAL_RATE_LIMIT_MAX || '5', 10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many trial requests. Try again later.' },
});

// Global safety net: 150 req/min per IP (catches all other endpoints).
// Override via GLOBAL_RATE_LIMIT_MAX env var — needed in CI where the full
// E2E suite shares an IP and can easily exceed the default.
const globalLimiter = makeRateLimiter({
  windowMs: 60 * 1000,
  max:      parseInt(process.env.GLOBAL_RATE_LIMIT_MAX || '150', 10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please slow down.' },
});

// ── Security headers (applied before everything except widget routes) ─────────
// Widget routes AND static widget files are excluded:
//   - /api/widget/* — widget API endpoints, manage their own permissive CORS
//   - /widget.html  — loaded cross-origin in customer iframes; frame-ancestors 'none' would block it
//   - /embed.js     — loaded on third-party pages; restrictive headers would break it
function isWidgetPath(path) {
  return path.startsWith('/api/widget') || path === '/widget.html' || path === '/embed.js';
}

app.use((req, res, next) => {
  if (isWidgetPath(req.path)) return next();
  securityHeaders(req, res, next);
});

// ── CORS — portal / API routes (non-widget) ───────────────────────────────────
app.use((req, res, next) => {
  if (isWidgetPath(req.path)) return next(); // widget has its own CORS
  portalCors(req, res, next);
});

// Stripe webhook needs raw body BEFORE json parsing
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), require('./routes/stripe-webhook'));

// Resend webhook (bounces / complaints) — Svix-signed, needs raw body too
app.use('/api/webhooks/resend', express.raw({ type: 'application/json' }), require('./routes/webhook-resend'));

app.use(express.json({ limit: '10mb' }));

// Serve embed.js and widget.html from /server/public (cross-origin OK — handled per-route)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Global safety net (applied before all routes)
app.use(globalLimiter);

// Routes — External Data API (authenticated via data_api_key)
// Rate limit: 60 requests/min per IP
const dataApiLimiter = makeRateLimiter({
  windowMs: 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Data API rate limit reached. Please slow down.' },
});
app.use('/api/v1', dataApiLimiter);
app.use('/api/v1', require('./routes/dataApi'));

// Routes — Widget (public, cross-origin, own CORS headers)
app.use('/api/widget/session', widgetSessionLimiter);
app.use('/api/widget/chat',    widgetChatLimiter);
app.use('/api/widget', require('./routes/widget'));

// Routes — Tenant Onboarding (public — registration + login)
app.use('/api/onboard/register', registerLimiter);
app.use('/api/onboard/login',    loginLimiter);
app.use('/api/onboard', require('./routes/onboard'));

// Routes — Tenant Portal (requires portal JWT)
app.use('/api/portal', require('./routes/portal'));

// Routes — Auth: the legacy /api/auth/* customer/advisor router (register/login/
// detect-tenant/me) was REMOVED as unused dead code. It accepted a client-supplied
// tenant_id (unauth cross-tenant row injection) and a self-assigned advisor `role`
// (incl. 'admin'). Nothing called it — live auth is /api/onboard/* (tenant portal)
// + /api/platform/auth/* (platform admin) + the widget JWT.

// Routes — Platform Admin (separate auth layer, no tenant scope)
// Disabled on self-hosted deployments — operators use the tenant dashboard, not platform admin.
if (!isSelfHosted()) {
  // Brute-force protection for the highest-privilege login in the system —
  // platform-admin manages every tenant. Previously only the 150/min global
  // net applied. Reuses loginLimiter (env-overridable for CI / shared NAT).
  app.use('/api/platform/auth/login', loginLimiter);
  app.use('/api/platform/auth',     require('./routes/platform/auth'));
  app.use('/api/platform/tenants',  require('./routes/platform/tenants'));
  app.use('/api/platform/licenses', require('./routes/platform/licenses'));
}

// Routes — First-run setup wizard (self-hosted only; inert once tenant exists)
app.use('/api/setup', require('./routes/setup'));

// Routes — License validation (called by self-hosted instances; only active when SHENMAY_LICENSE_MASTER=true)
app.use('/api/license/trial', licenseTrialLimiter);
app.use('/api/license', require('./routes/license'));

// Routes — Public license checkout (creates Stripe Checkout Session for self-hosted license purchases)
app.use('/api/public/license/checkout', require('./routes/license-checkout'));

// Routes — Public portal license lookup (called by pontensolutions.com license portal)
// Now serves the full magic-link auth flow: request-login, verify, GET licenses, logout.
// A realistic login exchange is 3-4 requests per user per minute; keep a headroom
// ceiling as HTTP-level defense-in-depth. The primary rate limits against enumeration
// + brute force live inside the request-login handler itself (5/hr/email + 20/hr/IP,
// Postgres-backed).
const portalLookupLimiter = makeRateLimiter({
  windowMs: 60 * 1000,
  max:      parseInt(process.env.PORTAL_RATE_LIMIT_MAX || '30', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});
app.use('/api/public/portal', portalLookupLimiter);
app.use('/api/public/portal', require('./routes/public-portal'));

// Health check — probes the DB so a disconnected-but-nginx-up outage
// actually fails the check (previously hardcoded 200 OK regardless). Kept
// extremely cheap (single SELECT 1, no pool warm-up work).
app.get('/api/health', async (req, res) => {
  const db = require('./db');
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', service: 'shenmay-ai', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      service: 'shenmay-ai',
      error: 'db_unreachable',
      timestamp: new Date().toISOString(),
    });
  }
});

// Deployment config — consumed by the frontend to toggle SaaS vs self-hosted UI
// and to select Stripe test vs live keys without rebuilding the bundle.
app.get('/api/config', (req, res) => {
  const selfHosted = isSelfHosted();
  res.json({
    deployment:   selfHosted ? DEPLOYMENT_MODES.SELFHOSTED : DEPLOYMENT_MODES.SAAS,
    features: {
      registration:      !selfHosted,  // hide sign-up page on self-hosted
      managedAI:         !selfHosted,  // BYOK only on self-hosted
      stripeBilling:     !selfHosted,  // use license key billing instead
      licenseManagement:  selfHosted,  // show license status + upgrade prompt
    },
    stripe: {
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY  || null,
      pricingTableId: process.env.STRIPE_PRICING_TABLE_ID || null,
    },
  });
});

// Error handler — never expose internal details in production
app.use((err, req, res, next) => {
  const status = err.status || 500;
  // For 5xx, log full context (method, url, stack) so we can diagnose intermittent
  // failures. 4xx errors are expected/intentional, so a single-line log is enough.
  if (status >= 500) {
    console.error(`[ERROR] ${status} ${req.method} ${req.originalUrl} — ${err.message}`);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(`[ERROR] ${status} ${req.method} ${req.originalUrl} — ${err.message}`);
  }
  // Only surface the original message for expected, intentional errors (4xx).
  // For unexpected server errors, send a generic message to avoid leaking internals.
  const safe = status < 500
    ? (err.message || 'Bad request')
    : 'An unexpected error occurred. Please try again.';
  res.status(status).json({ error: safe });
});

// ── Async startup ─────────────────────────────────────────────────────────────
// Order: seed tenant (self-hosted) → license check → listen
(async () => {
  // 1. Self-hosted: auto-provision tenant + admin on first boot
  if (isSelfHosted()) {
    try {
      const { seedSelfHostedTenant } = require('./jobs/seedSelfHostedTenant');
      await seedSelfHostedTenant();
    } catch (err) {
      console.error('[Startup] Tenant seed failed:', err.message);
      // Non-fatal if tenant already exists; fatal only if DB is unreachable
      if (err.code === 'ECONNREFUSED' || err.code === '57P03') {
        console.error('[Startup] Database unreachable — cannot start.');
        process.exit(1);
      }
    }
  }

  // 2. License check (self-hosted only; no-op for SaaS VPS)
  try {
    const { checkLicenseOnStartup } = require('./services/licenseService');
    await checkLicenseOnStartup();
  } catch (err) {
    console.error('[Startup] License check error:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`\n🧠 Shenmay AI server running on http://localhost:${PORT}`);
    console.log(`   LLM Provider: ${process.env.LLM_PROVIDER || 'mock'}\n`);

    // ── Start data retention cron job ────────────────────────────────────────
    // Gracefully degrades if the job module fails (won't crash server startup).
    try {
      require('./jobs/dataRetention').start();
    } catch (err) {
      console.error('[Startup] Data retention job failed to start:', err.message);
    }

    // ── Start brand-learning worker ──────────────────────────────────────────
    // Nightly distillation of anonymous-visitor conversations into per-tenant
    // brand_soul / brand_memory / audience_profile. Opt-in per tenant.
    // See docs/BRAND_LEARNING_SCOPE.md.
    try {
      require('./services/brandLearning').start();
    } catch (err) {
      console.error('[Startup] Brand-learning worker failed to start:', err.message);
    }
  });
})();
