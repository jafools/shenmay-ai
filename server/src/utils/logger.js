/**
 * SHENMAY AI — Structured logger (pino) + request-scoped context.
 *
 * Audit M11 / task T10: the old request log was timestamp+method+path only, and
 * 227 raw console.* calls carried no request id — a `[ERROR] 500 POST /chat`
 * couldn't be tied to its request line, tenant, or session except by timestamp
 * guesswork.
 *
 * This adds a single pino base logger plus an AsyncLocalStorage request context.
 * Any `log().info(...)` call made *during a request* automatically carries that
 * request's id (and tenant id, once an auth layer sets it via setContext). The
 * legacy console.* calls are migrated incrementally — new code uses log().
 *
 * `base: undefined` drops pino's default pid+hostname fields: pid is meaningless
 * inside a single-process container and hostname is the container id.
 */

'use strict';

const pino = require('pino');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  base: undefined,
});

/**
 * Run `fn` inside a request-scoped store. Subsequent log() calls (and any async
 * continuations) see this store via async_hooks propagation.
 * @param {Object} store  e.g. { requestId }
 * @param {Function} fn
 */
function runWithContext(store, fn) {
  return als.run(store, fn);
}

/** Merge fields into the active request context (e.g. tenantId once resolved). */
function setContext(patch) {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
}

/** Snapshot of the active request context ({} outside a request). */
function getContext() {
  return als.getStore() || {};
}

/**
 * The logger to use for request-scoped lines. Returns a child bound to the
 * current request context when inside one, else the base logger.
 * @returns {import('pino').Logger}
 */
function log() {
  const store = als.getStore();
  return store ? logger.child(store) : logger;
}

module.exports = { logger, log, runWithContext, setContext, getContext };
