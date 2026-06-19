/**
 * SHENMAY AI — API Key Encryption Service
 *
 * Encrypts/decrypts tenant API keys (BYOK — "bring your own key" — flow)
 * using AES-256-GCM. The ciphertext and IV are stored as base64 TEXT
 * columns on the `tenants` row (`llm_api_key_encrypted`, `llm_api_key_iv`).
 *
 * Encryption key is derived from API_KEY_ENCRYPTION_SECRET env var.
 * If not set, falls back to JWT_SECRET (not ideal for production).
 *
 * @typedef {Object} EncryptedKey
 * @property {string} encrypted  base64(ciphertext) + ":" + base64(authTag)
 * @property {string} iv         base64-encoded 16-byte IV (one per encrypt call)
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // AES-256

function getEncryptionKey() {
  const secret = process.env.API_KEY_ENCRYPTION_SECRET || process.env.JWT_SECRET || 'shenmay-dev-encryption-key';
  // Derive a 32-byte key from the secret using SHA-256
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt an API key (or any secret string) using AES-256-GCM.
 *
 * @param   {string} plaintext  The secret to encrypt (non-empty).
 * @returns {EncryptedKey}      Envelope safe to store in the DB.
 * @throws  {TypeError} When plaintext is missing or not a string.
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('encrypt(plaintext): non-empty string required');
  }
  const iv = crypto.randomBytes(16);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');

  return {
    encrypted: encrypted + ':' + authTag,
    iv: iv.toString('base64'),
  };
}

/**
 * Decrypt an API key previously produced by {@link encrypt}.
 *
 * @param   {string} encryptedWithTag  base64 ciphertext + ":" + base64 authTag.
 * @param   {string} ivBase64          base64-encoded IV.
 * @returns {string} Plaintext API key.
 * @throws  {Error|TypeError} On malformed envelope or auth-tag mismatch (indicates
 *          tampering or that API_KEY_ENCRYPTION_SECRET has changed since encrypt).
 */
function decrypt(encryptedWithTag, ivBase64) {
  if (typeof encryptedWithTag !== 'string' || !encryptedWithTag.includes(':')) {
    throw new TypeError('decrypt: encryptedWithTag must be "<base64-ct>:<base64-tag>"');
  }
  if (typeof ivBase64 !== 'string' || ivBase64.length === 0) {
    throw new TypeError('decrypt: ivBase64 must be a non-empty string');
  }
  const [encryptedData, authTag] = encryptedWithTag.split(':');
  const iv = Buffer.from(ivBase64, 'base64');
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Last-4 of a key for UI display (e.g. "sk-ant-…abcd").
 * @param   {string} apiKey
 * @returns {string} Empty string when `apiKey` is falsy.
 */
function getLast4(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return '';
  return apiKey.slice(-4);
}

module.exports = {
  encrypt,
  decrypt,
  getLast4,
  // Shared AES-256-GCM primitives — cryptoService.js reuses these so the
  // algorithm + key-derivation (env-var fallback chain) have a single source
  // of truth. Both services MUST derive the same key from the same secret,
  // otherwise values encrypted by one can't be decrypted by the other.
  ALGORITHM,
  getEncryptionKey,
};
