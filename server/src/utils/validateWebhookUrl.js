/**
 * SHENMAY AI — Webhook URL Validator (SSRF Guard)
 *
 * Rejects webhook URLs that point to private/internal infrastructure to prevent
 * Server-Side Request Forgery (SSRF) attacks.
 *
 * Blocks:
 *  - Non-HTTPS URLs
 *  - Localhost and loopback addresses
 *  - Private IP ranges (RFC 1918 + RFC 4193)
 *  - Link-local / cloud metadata endpoints (169.254.x.x)
 *  - Zero addresses
 *
 * Usage:
 *   const { validateWebhookUrl } = require('../utils/validateWebhookUrl');
 *   const err = validateWebhookUrl(url);
 *   if (err) return res.status(400).json({ error: err });
 */

const { URL } = require('url');
const dns = require('dns');

// Hostname blocklist patterns (checked before DNS resolution)
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0',
]);

// Regex patterns for private/internal hostnames
const BLOCKED_HOSTNAME_PATTERNS = [
  /^127\./,                         // IPv4 loopback
  /^10\./,                          // RFC 1918 Class A
  /^172\.(1[6-9]|2\d|3[01])\./,    // RFC 1918 Class B
  /^192\.168\./,                    // RFC 1918 Class C
  /^169\.254\./,                    // Link-local / AWS metadata
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // Shared address (CGNAT)
  /^::1$/,                          // IPv6 loopback
  /^fc00:/i,                        // IPv6 ULA
  /^fd[0-9a-f]{2}:/i,               // IPv6 ULA
  /^fe80:/i,                        // IPv6 link-local
  /^0\.0\.0\.0$/,                   // Zero address
  /^\[::1\]$/,                      // IPv6 loopback in brackets
];

/**
 * True if a hostname OR a resolved IP literal is private/internal/loopback/
 * link-local/CGNAT. Normalizes IPv4-mapped IPv6 (::ffff:1.2.3.4) to its IPv4
 * so a mapped internal address can't slip past the dotted-IPv4 patterns.
 *
 * @param {string} addr  hostname or IP literal
 * @returns {boolean}
 */
function isBlockedAddress(addr) {
  let a = String(addr || '').toLowerCase().trim();
  if (!a) return true;
  const mapped = a.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) a = mapped[1];
  if (BLOCKED_HOSTNAMES.has(a)) return true;
  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(a)) return true;
  }
  return false;
}

/**
 * Synchronous validation of the URL string (no DNS resolution).
 * Returns an error string if invalid, or null if OK.
 *
 * @param {string} rawUrl
 * @returns {string|null}
 */
function validateWebhookUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return 'Webhook URL is required';
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return 'Webhook URL is not a valid URL';
  }

  // Must be HTTPS
  if (parsed.protocol !== 'https:') {
    return 'Webhook URL must use HTTPS';
  }

  // Max URL length
  if (rawUrl.length > 512) {
    return 'Webhook URL is too long (max 512 characters)';
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known internal hostnames / private IP literals / link-local
  if (isBlockedAddress(hostname)) {
    return 'Webhook URL must point to a public server';
  }

  // Block URLs with credentials (user:pass@host)
  if (parsed.username || parsed.password) {
    return 'Webhook URL must not contain credentials';
  }

  return null; // valid
}

/**
 * Async SSRF validation: runs the synchronous string checks, then RESOLVES DNS
 * and rejects if the hostname maps to any private/internal address. Closes the
 * gap where a public hostname carries an internal A/AAAA record — which the
 * string-only validateWebhookUrl cannot see. `lookup` is injectable for tests.
 *
 * NOTE: this resolves-then-rejects; it does NOT pin the connection to the
 * resolved IP, so a DNS-rebind that flips the record between this check and the
 * caller's fetch() remains theoretically possible. The sinks that use this also
 * send with redirect:'manual', and are authenticated + mostly blind, so the
 * residual is low. Pinning the validated IP is a tracked follow-up.
 *
 * @param {string} rawUrl
 * @param {{ lookup?: (host: string) => Promise<Array<{address:string}>|string> }} [opts]
 * @returns {Promise<string|null>}  error string, or null if OK
 */
async function validateWebhookUrlAsync(rawUrl, opts = {}) {
  const syncErr = validateWebhookUrl(rawUrl);
  if (syncErr) return syncErr;

  let hostname;
  try {
    hostname = new URL(rawUrl.trim()).hostname.toLowerCase();
  } catch {
    return 'Webhook URL is not a valid URL';
  }

  const lookup = opts.lookup || ((host) => dns.promises.lookup(host, { all: true }));
  let addresses;
  try {
    addresses = await lookup(hostname);
  } catch {
    return 'Webhook URL host could not be resolved';
  }

  const list = Array.isArray(addresses) ? addresses : [addresses];
  for (const entry of list) {
    const addr = (entry && typeof entry === 'object') ? entry.address : entry;
    if (isBlockedAddress(addr)) {
      return 'Webhook URL resolves to a private/internal address';
    }
  }
  return null;
}

module.exports = { validateWebhookUrl, validateWebhookUrlAsync, isBlockedAddress };
