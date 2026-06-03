/**
 * PII Detectors — pure-regex pattern detection for high-value identifiers.
 *
 * Each detector exports:
 *   - NAME    : short identifier used in the token prefix (e.g. 'SSN', 'CC')
 *   - pattern : RegExp (with /g flag so findAll works)
 *   - validate: (match) => boolean   — final-pass filter (e.g. Luhn for CC)
 *
 * Detectors are deliberately conservative — better to miss a weird edge case
 * and flag it in the breach detector than to tokenize false positives that
 * break the agent's reasoning.
 */

'use strict';

// ── Luhn algorithm for credit-card validation ─────────────────────────────
function luhnValid(num) {
  const digits = String(num).replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ── IBAN checksum (mod 97) ────────────────────────────────────────────────
function ibanValid(iban) {
  const cleaned = iban.replace(/\s/g, '').toUpperCase();
  if (cleaned.length < 15 || cleaned.length > 34) return false;
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (let i = 0; i < numeric.length; i++) {
    remainder = (remainder * 10 + parseInt(numeric[i], 10)) % 97;
  }
  return remainder === 1;
}

// ── Detectors ─────────────────────────────────────────────────────────────

const detectors = [
  {
    NAME: 'SSN',
    // US SSN: 3-2-4 with separator, excludes 000/666/900-999 area numbers
    // and 00 group / 0000 serial (per SSA rules).
    pattern: /\b(?!000|666|9\d{2})\d{3}[-\s.]?(?!00)\d{2}[-\s.]?(?!0000)\d{4}\b/g,
    validate: () => true,
  },
  {
    NAME: 'SIN',
    // Swedish personnummer: YYMMDD-XXXX or YYYYMMDD-XXXX (12-digit)
    pattern: /\b(?:19|20)?\d{6}[-+.]\d{4}\b/g,
    validate: (m) => {
      // Luhn-check the last 10 digits (Swedish personnummer uses Luhn on YYMMDDXXXX)
      const digits = m.replace(/\D/g, '').slice(-10);
      return digits.length === 10 && luhnValid(digits);
    },
  },
  {
    NAME: 'CC',
    // Credit card: 13-19 digits with optional separators, then Luhn-validated.
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (m) => luhnValid(m),
  },
  {
    NAME: 'IBAN',
    // IBAN: 2 letters (country) + 2 digits (check) + up to 30 alphanumeric chars
    // (BBAN). Characters may be space-grouped in 4s. 15-34 chars total.
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g,
    validate: (m) => ibanValid(m),
  },
  {
    NAME: 'IBAN',
    // Lowercase / compact IBANs (e.g. "de89370400440532013000"). Kept separate
    // from the uppercase space-grouped detector above on purpose: putting a
    // case-insensitive flag THERE lets the BBAN class greedily swallow a
    // following lowercase word ("...7654 32 thanks"), which breaks the mod-97
    // check so a real IBAN fails validation and leaks. A compact, no-internal-
    // space lowercase form can't run past a space into prose, so it's safe.
    // ibanValid() uppercases before checksumming, so the value still validates.
    pattern: /\b[a-z]{2}\d{2}[a-z0-9]{11,30}\b/g,
    validate: (m) => ibanValid(m),
  },
  {
    NAME: 'EMAIL',
    // RFC-5322 pragmatic subset. Every quantifier is BOUNDED so the pattern is
    // provably linear: the local part (<=64 per RFC 5321) and each domain label
    // (<=63 per DNS) exclude '.', so a dot-run partitions uniquely with no
    // ambiguous backtracking. The previous unbounded form
    //   /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/
    // was quadratic on crafted input like "a@a.a.a.…" — an event-loop DoS via
    // the always-on tokenizer (the local '+' also backtracks O(n) per start
    // position when there is no '@', so both sides are bounded here).
    pattern: /\b[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9\-]{1,63}(?:\.[a-zA-Z0-9\-]{1,63}){0,16}\.[a-zA-Z]{2,24}\b/g,
    validate: () => true,
  },
  {
    NAME: 'PHONE',
    // International + national formats. Requires non-digit context on both
    // sides so we don't eat the tail of a longer digit run (e.g. a CC
    // number that failed Luhn). 10-15 digits total.
    pattern: /(?<![\d\-.])(?:\+?\d{1,3}[-.\s])?\(?\d{2,4}\)?[-.\s]\d{3,4}[-.\s]\d{3,4}(?![-.\s]?\d)/g,
    validate: (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 15;
    },
  },
  {
    NAME: 'PHONE',
    // Separator-LESS phone numbers in an explicit phone context — the shape
    // anonymous visitors actually type ("call 5551234567", "cell +15551234567").
    // The separator-based detector above misses these. Keyword-anchored (like
    // ACCOUNT) and pure-digit, so a bare digit run elsewhere isn't eaten and a
    // separator-formatted number already caught above isn't double-matched.
    pattern: /(?:phone|call|cell|mobile|tel|telephone|whatsapp|reach|text)[^\d]{0,15}(\+?\d{10,15})\b/gi,
    validate: (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 15;
    },
    group: 1,
  },
  {
    NAME: 'DOB',
    // Full date of birth in common formats. Requires 4-digit year to reduce
    // false positives on random numeric triples. Three alternatives:
    //   ISO   YYYY-MM-DD   (e.g. 1975-03-14)
    //   US    MM/DD/YYYY   (e.g. 03/14/1975)
    //   EU    DD.MM.YYYY or DD/MM/YYYY  (e.g. 14.03.1975)
    pattern: /\b(?:(?:19|20)\d{2}[-/.](?:0?[1-9]|1[012])[-/.](?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|1[012])[-/.](?:0?[1-9]|[12]\d|3[01])[-/.](?:19|20)\d{2}|(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[012])[-/.](?:19|20)\d{2})\b/g,
    validate: () => true,
  },
  {
    NAME: 'POSTCODE',
    // US ZIP (5 or 5+4), UK postcode, Canadian postal (A1A 1A1 / A1A1A1),
    // Swedish postnummer (5 digits with space).
    // Bounded with word/context to avoid matching anywhere.
    // Canadian alternation added 2026-05-09 alongside the brand-learning fuzz
    // test that surfaced the M5V 2H1 gap — strictly additive, no existing
    // matches lose coverage.
    pattern: /\b(?:\d{5}(?:-\d{4})?|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}|[A-Z]\d[A-Z]\s?\d[A-Z]\d|\d{3}\s?\d{2})\b/g,
    validate: (m) => {
      // Exclude likely false positives: bare 5-digit that could be a year or
      // an account number. Only tokenize if clearly postcode-shaped.
      if (/^\d{5}$/.test(m)) {
        const n = parseInt(m, 10);
        // Heuristic: Swedish postcodes are 10000-99999 (but NOT 19xx/20xx which are years).
        return !(n >= 1900 && n <= 2100);
      }
      return true;
    },
  },
  {
    NAME: 'ACCOUNT',
    // Bank account numbers: 8-17 consecutive digits, not Luhn-valid (would be CC),
    // not date-shaped. Deliberately narrow — this is the most likely false-positive
    // source, so we only catch contexts that are clearly account-number-ish.
    pattern: /\b(?:account|acct|acc|konto)[^\d]{0,10}(\d{8,17})\b/gi,
    validate: () => true,
    // When this matches, the captured group (1) is the actual account number —
    // not the whole phrase. The tokenizer handles this via the `group` key.
    group: 1,
  },
];

module.exports = { detectors, luhnValid, ibanValid };
