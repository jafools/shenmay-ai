/**
 * SHENMAY AI — Error tracking (Sentry), DSN-gated and silent by default.
 *
 * Audit task T10 / open question Q4. Privacy posture: self-hosted customers'
 * data must NOT flow to Shenmay's error tracker. So Sentry only initialises when
 * SENTRY_DSN is set — self-hosted installs leave it unset and the SDK is never
 * even required at runtime. SaaS sets its own DSN.
 *
 * Errors-only: no performance tracing (tracesSampleRate 0) and sendDefaultPii
 * false, so IPs / headers / bodies aren't captured. We attach only an explicit,
 * minimal context (request id, method, route).
 */

'use strict';

let _sentry = null;
let _initTried = false;

/**
 * Initialise Sentry if SENTRY_DSN is set. Idempotent and never throws.
 * @returns {Object|null} the Sentry module when active, else null.
 */
function initSentry() {
  if (_initTried) return _sentry;
  _initTried = true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null; // silent by default (self-hosted)

  try {
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: 0,     // errors only — no perf tracing
      sendDefaultPii: false,   // never auto-capture IPs / headers / bodies
    });
    _sentry = Sentry;
    console.log('[Sentry] Error tracking enabled.');
    return _sentry;
  } catch (err) {
    console.warn(`[Sentry] init skipped: ${err.message}`);
    return null;
  }
}

/** Whether Sentry is active (a DSN was set and init succeeded). */
function isEnabled() {
  return _sentry !== null;
}

/**
 * Capture an exception with a minimal, explicit context. No-op when Sentry is
 * inactive. Never throws — telemetry must not crash the app.
 * @param {Error} err
 * @param {Object} [context]  small, non-PII fields (requestId, method, url)
 */
function captureError(err, context = {}) {
  if (!_sentry) return;
  try {
    _sentry.captureException(err, { extra: context });
  } catch { /* swallow — telemetry must never break the request path */ }
}

/**
 * Capture a fatal error, flush (bounded), then invoke `done`. Used by the
 * process-level rejection/exception handlers so the event isn't lost on exit.
 * Calls `done` immediately when Sentry is inactive.
 * @param {Error} err
 * @param {Function} done
 */
function captureFatal(err, done) {
  if (!_sentry) return done();
  try {
    _sentry.captureException(err);
    _sentry.close(2000).then(() => done(), () => done());
  } catch {
    done();
  }
}

module.exports = { initSentry, isEnabled, captureError, captureFatal };
