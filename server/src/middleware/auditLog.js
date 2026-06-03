/**
 * SHENMAY AI — Audit Logging Middleware
 *
 * Provides writeAuditLog() — a fire-and-forget helper that inserts a row into
 * audit_logs. Used by routes that touch sensitive data:
 *
 *   Portal  : customer profile reads, memory reads, exports, deletions
 *   Auth    : login success/failure, register events
 *   Widget  : session creation (consent capture)
 *   Platform: tenant admin actions
 *
 * The log is NEVER truncated by the data retention cron — legally required
 * to keep audit trails for 7 years minimum under GDPR + GLBA.
 *
 * Usage:
 *   const { writeAuditLog } = require('../middleware/auditLog');
 *
 *   writeAuditLog(db, {
 *     actorType : 'advisor',
 *     actorId   : req.portal.advisor_id,
 *     actorEmail: req.portal.email,
 *     tenantId  : req.portal.tenant_id,
 *     customerId: customer.id,            // optional
 *     eventType : 'customer.read',
 *     resourceType: 'customer',
 *     resourceId  : customer.id,
 *     description : `Advisor viewed customer profile`,
 *     req,                                // extracts ip, user-agent, path
 *     success: true,
 *   });
 *
 * All calls are fire-and-forget. A failed audit write is logged to stderr but
 * NEVER throws — it must not block the main response.
 */

const db = require('../db');

// Observability for the fire-and-forget audit path (P3-4). A failed audit write
// must never crash the app, but silent loss of a 7-year-retention compliance
// log shouldn't be invisible either. Keep a process-level failure counter
// (surfaced at /api/health) + a structured stderr line so dropped events are
// detectable by ops even without a full metrics backend.
let auditWriteFailures = 0;
let lastAuditWriteError = null;

/** Snapshot of audit-write failures for health/monitoring (P3-4). */
function getAuditWriteFailures() {
  return { failures: auditWriteFailures, lastError: lastAuditWriteError };
}

/**
 * Write a single audit event. Fire-and-forget — never throws.
 *
 * @param {Object} opts
 * @param {string}  opts.actorType    — 'advisor'|'admin'|'platform_admin'|'customer'|'system'|'widget'
 * @param {string}  [opts.actorId]    — UUID of the actor (null for system/widget)
 * @param {string}  [opts.actorEmail] — Email of the actor (denormalised)
 * @param {string}  [opts.tenantId]   — UUID of the tenant scope
 * @param {string}  [opts.customerId] — UUID of the affected customer
 * @param {string}  opts.eventType    — dot-notation event name, e.g. 'customer.read'
 * @param {string}  [opts.resourceType]
 * @param {string}  [opts.resourceId]
 * @param {string}  [opts.description]
 * @param {Object}  [opts.req]        — Express request (for ip / user-agent / path)
 * @param {boolean} [opts.success]    — default true
 * @param {string}  [opts.errorMessage]
 */
function writeAuditLog(opts) {
  // Normalise: accept (db, opts) signature or just (opts) with db from require
  // This lets callers pass the db pool explicitly (useful in tests / multi-db setups)
  const pool = db;
  const params = opts;

  // setImmediate ensures this never blocks the calling request
  setImmediate(async () => {
    try {
      const {
        actorType,
        actorId        = null,
        actorEmail     = null,
        tenantId       = null,
        customerId     = null,
        eventType,
        resourceType   = null,
        resourceId     = null,
        description    = null,
        req            = null,
        success        = true,
        errorMessage   = null,
      } = params;

      const ipAddress  = req ? (req.ip || req.headers['x-forwarded-for'] || null) : null;
      const userAgent  = req ? (req.headers['user-agent'] || null)                 : null;
      const httpMethod = req ? req.method                                            : null;
      const reqPath    = req ? req.path                                              : null;

      await pool.query(
        `INSERT INTO audit_logs
           (actor_type, actor_id, actor_email,
            tenant_id, customer_id,
            event_type, resource_type, resource_id, description,
            ip_address, user_agent, http_method, request_path,
            success, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          actorType, actorId, actorEmail,
          tenantId, customerId,
          eventType, resourceType, resourceId, description,
          ipAddress, userAgent, httpMethod, reqPath,
          success, errorMessage,
        ]
      );
    } catch (err) {
      // Audit failure must NEVER crash the app — but it MUST be detectable.
      // Bump the monitored counter (exposed at /api/health) and emit a
      // structured, greppable line so dropped compliance events surface (P3-4).
      auditWriteFailures += 1;
      lastAuditWriteError = {
        at: new Date().toISOString(),
        eventType: params?.eventType || null,
        message: err.message,
      };
      console.error(
        `[AuditLog] WRITE FAILED (total=${auditWriteFailures}) ` +
        `event=${params?.eventType || 'unknown'}: ${err.message}`
      );
    }
  });
}

/**
 * Express middleware factory — automatically logs every request to a route.
 * Useful for blanket-logging entire routers (e.g. platform admin).
 *
 * Usage:
 *   router.use(auditMiddleware({ actorType: 'platform_admin', eventType: 'platform.access' }));
 */
function auditMiddleware({ actorType = 'advisor', eventType = 'route.access', getActorId, getTenantId } = {}) {
  return (req, res, next) => {
    const actorId  = getActorId  ? getActorId(req)  : (req.portal?.advisor_id || req.user?.user_id || null);
    const tenantId = getTenantId ? getTenantId(req)  : (req.portal?.tenant_id  || req.user?.tenant_id || null);

    writeAuditLog({
      actorType,
      actorId,
      actorEmail : req.portal?.email || req.user?.email || null,
      tenantId,
      eventType,
      description: `${req.method} ${req.path}`,
      req,
      success: true,
    });
    next();
  };
}

module.exports = { writeAuditLog, auditMiddleware, getAuditWriteFailures };
