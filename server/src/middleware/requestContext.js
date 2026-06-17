/**
 * SHENMAY AI — Request correlation + HTTP 5xx counter (audit M11 + M12, task T10).
 *
 * One early middleware that:
 *   1. Assigns a request id (honours a sane inbound X-Request-Id, else mints a
 *      UUID), echoes it back as the X-Request-Id response header, and runs the
 *      rest of the request inside an AsyncLocalStorage context so every log()
 *      line is correlated.
 *   2. On response finish, counts 5xx responses and emits a structured request
 *      summary. The count happens at finish — NOT in the central error handler —
 *      because 12 route-level `res.status(500)` calls bypass the error handler;
 *      finish catches them all. Surfaced as `http_5xx_total` on /api/health
 *      (mirrors the audit_write_failures counter), so an external monitor can
 *      alert on a 500-spike that leaves the DB healthy and every monitor green.
 */

'use strict';

const crypto = require('crypto');
const { runWithContext, log } = require('../utils/logger');

let http5xxTotal = 0;

/** Snapshot of the 5xx counter for /api/health. */
function getHttp5xx() {
  return http5xxTotal;
}

// Request-summary log is suppressed for these (health probes + cross-origin
// static widget assets) to avoid drowning real traffic. They are still counted
// for 5xx — only the success line is quiet.
const QUIET_PATHS = new Set(['/api/health', '/embed.js', '/widget.html']);

// A caller-supplied id is only trusted if it's a short, safe token — prevents
// log injection and unbounded values from an untrusted header.
const SAFE_ID = /^[\w.-]{1,128}$/;

function requestContext(req, res, next) {
  const inbound = req.headers['x-request-id'];
  const id = (typeof inbound === 'string' && SAFE_ID.test(inbound))
    ? inbound
    : crypto.randomUUID();

  req.id = id;
  res.setHeader('X-Request-Id', id);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (res.statusCode >= 500) http5xxTotal += 1;
    if (QUIET_PATHS.has(req.path)) return;
    const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    log().info(
      { requestId: id, method: req.method, path: req.path, status: res.statusCode, durationMs },
      'request'
    );
  });

  runWithContext({ requestId: id }, next);
}

module.exports = { requestContext, getHttp5xx };
