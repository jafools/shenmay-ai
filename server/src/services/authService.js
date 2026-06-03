/**
 * SHENMAY AI — Authentication Service
 *
 * Handles password hashing, JWT generation, and token validation.
 * Used by auth routes and middleware.
 */

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'shenmay-dev-secret-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';

/**
 * Hash a plaintext password with bcrypt
 */
async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare plaintext password against stored hash
 */
async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Generate a JWT token with user context
 *
 * Payload shape:
 *   { user_id, tenant_id, user_type ('customer'|'advisor'), role, email }
 */
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

/**
 * Validate and decode a JWT token
 * Returns decoded payload or throws on invalid/expired
 */
function validateToken(token) {
  // Pin the algorithm — never accept whatever the token header declares
  // (defends against alg-confusion / alg:none should a future key change).
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

/**
 * Validate password strength.
 * Returns { valid: boolean, message: string }
 *
 * Rules:
 *  - At least 8 characters
 *  - At least one uppercase letter
 *  - At least one lowercase letter
 *  - At least one digit
 */
function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, message: 'Password is required' };
  }
  if (password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one uppercase letter' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one lowercase letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number' };
  }
  return { valid: true, message: 'OK' };
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  validateToken,
  validatePasswordStrength,
  JWT_SECRET,
};
