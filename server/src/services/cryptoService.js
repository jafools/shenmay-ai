/**
 * SHENMAY AI — Crypto Service
 *
 * Extends the existing AES-256-GCM pattern from apiKeyService.js to support
 * encrypting arbitrary JSON objects (memory_file, soul_file, etc.).
 *
 * IMPORTANT — Column encryption rollout plan:
 * --------------------------------------------------
 * Current state:  memory_file and soul_file stored as plain JSONB.
 * Target state:   Encrypted blobs stored as TEXT; decrypted at read time.
 *
 * The migration requires:
 *   1. Converting all SQL jsonb_set() calls on these columns to
 *      read-decrypt-modify-encrypt-write patterns in application code.
 *   2. Running a one-time backfill script to encrypt existing rows.
 *   3. Changing column types from JSONB → TEXT in a schema migration.
 *
 * This service provides the encryption primitives ready for that rollout.
 * --------------------------------------------------
 *
 * Sentinel format:
 *   Encrypted values are stored as objects: { __enc: "<base64>", __iv: "<base64>" }
 *   Unencrypted values are plain objects.
 *   encryptJson / decryptJson are transparent — if already encrypted, don't re-encrypt;
 *   if already plain, don't try to decrypt. Enables zero-downtime migration.
 */

const crypto = require('crypto');

// AES-256-GCM primitives are shared with apiKeyService.js so the algorithm and
// key-derivation (env-var fallback chain) have a single source of truth — both
// services must derive the same key from the same secret.
const { ALGORITHM, getEncryptionKey } = require('./apiKeyService');

/**
 * Encrypt a plain JS object to a sentinel envelope.
 *
 * @param  {Object} obj — any JSON-serialisable object
 * @returns {{ __enc: string, __iv: string }}
 */
function encryptJson(obj) {
  if (obj === null || obj === undefined) return obj;
  if (isEncrypted(obj)) return obj; // already encrypted — idempotent

  const plaintext = JSON.stringify(obj);
  const iv        = crypto.randomBytes(16);
  const key       = getEncryptionKey();
  const cipher    = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');

  return {
    __enc: encrypted + ':' + authTag,
    __iv:  iv.toString('base64'),
  };
}

/**
 * Decrypt a sentinel envelope back to a plain JS object.
 * Transparent: if the value is already a plain object (not encrypted), returns it as-is.
 *
 * @param  {Object} val — either a sentinel envelope or a plain object
 * @returns {Object}
 */
function decryptJson(val) {
  if (val === null || val === undefined) return val;
  if (!isEncrypted(val)) return val; // plain object — passthrough

  const [encryptedData, authTag] = val.__enc.split(':');
  const iv      = Buffer.from(val.__iv, 'base64');
  const key     = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

/**
 * Test whether a value is a cryptoService encrypted envelope.
 */
function isEncrypted(val) {
  return (
    val !== null &&
    typeof val === 'object' &&
    typeof val.__enc === 'string' &&
    typeof val.__iv  === 'string'
  );
}

/**
 * Safe decrypt — returns empty object on decryption failure instead of throwing.
 * Use in read paths where a missing/corrupt encryption should not crash the app.
 */
function safeDecryptJson(val) {
  if (val === null || val === undefined) return {};
  try {
    return decryptJson(val);
  } catch (err) {
    console.error('[CryptoService] Decryption failed — returning empty object:', err.message);
    return {};
  }
}

module.exports = { encryptJson, decryptJson, safeDecryptJson, isEncrypted };
