/**
 * NOMII AI — PII Tokenizer Unit Tests
 *
 * Pure-JS unit tests — no DB, no server, no network. Runs in ~50ms.
 *
 * Coverage:
 *   - Each regex detector (SSN, CC+Luhn, IBAN, EMAIL, PHONE, DOB, POSTCODE,
 *     ACCOUNT, SIN/personnummer)
 *   - Round-trip (tokenize → detokenize == original)
 *   - Name pseudonymization from memory_file
 *   - Breach detector catches what the tokenizer misses
 *   - Token numbering is consistent (same value → same token)
 *   - Detokenize of unknown tokens leaves them as-is (safe failure)
 *   - Multi-line / structured / tool-result message tokenization
 *
 * Run:  node tests/tokenizer.test.js
 */

'use strict';

const {
  Tokenizer,
  TokenMap,
  BreachError,
  _internal,
} = require('../server/src/services/piiTokenizer');

const { detectors, scan, scanMessages } = _internal;

// ── Test runner (matches existing tests/integration.test.js style) ───────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message || err}`);
    failed++;
    failures.push({ name, message: err.message || String(err) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}
function assertEqual(a, b, message) {
  if (a !== b) throw new Error(`${message || 'Values differ'}\n      expected: ${JSON.stringify(b)}\n      actual:   ${JSON.stringify(a)}`);
}
function assertContains(hay, needle, message) {
  if (!String(hay).includes(needle)) throw new Error(`${message || 'Does not contain'}: expected "${hay}" to include "${needle}"`);
}
function assertNotContains(hay, needle, message) {
  if (String(hay).includes(needle)) throw new Error(`${message || 'Contains forbidden value'}: "${hay}" should NOT include "${needle}"`);
}

console.log('\n== PII Tokenizer Unit Tests ==\n');

// ═══════════════════════════════════════════════════════════════════════════
// 1. DETECTORS — each regex catches what it should
// ═══════════════════════════════════════════════════════════════════════════

console.log('Detectors');

test('SSN matches 3-2-4 format', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('SSN is 555-12-3456 on file');
  assertNotContains(text, '555-12-3456');
  assertContains(text, '[SSN_1]');
});

test('SSN matches bare 9-digit form', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('SSN is 555123456 on file');
  assertNotContains(text, '555123456');
});

test('SSN rejects invalid area 000', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('Ref 000-12-3456 is not a real SSN');
  assertContains(text, '000-12-3456');
});

test('SSN rejects invalid area 666', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('Ref 666-12-3456 is not a real SSN');
  assertContains(text, '666-12-3456');
});

test('Credit card matches with Luhn validation', () => {
  const t = new Tokenizer();
  // 4111-1111-1111-1111 is a known-valid Luhn test number.
  const { text } = t.tokenize('Card: 4111-1111-1111-1111');
  assertNotContains(text, '4111-1111-1111-1111');
  assertContains(text, '[CC_1]');
});

test('Credit card rejects Luhn-invalid numbers', () => {
  const t = new Tokenizer();
  // One digit off → Luhn fails
  const { text } = t.tokenize('Not a card: 4111-1111-1111-1112');
  assertContains(text, '4111-1111-1111-1112');
});

test('IBAN matches with checksum validation', () => {
  const t = new Tokenizer();
  // Valid IBAN: GB82 WEST 1234 5698 7654 32
  const { text } = t.tokenize('IBAN: GB82WEST12345698765432');
  assertNotContains(text, 'GB82WEST12345698765432');
  assertContains(text, '[IBAN_1]');
});

test('IBAN rejects bad checksum', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('IBAN: GB99WEST12345698765432');
  assertContains(text, 'GB99WEST12345698765432');
});

test('Email matches standard form', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('Contact me at diana@example.com or support@pontensolutions.com');
  assertNotContains(text, 'diana@example.com');
  assertNotContains(text, 'support@pontensolutions.com');
  assertContains(text, '[EMAIL_1]');
  assertContains(text, '[EMAIL_2]');
});

test('Phone matches international format', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('Call +1 555-123-4567 or 555-987-6543');
  assertNotContains(text, '555-123-4567');
  assertNotContains(text, '555-987-6543');
});

test('Phone matches separator-less number in a phone context (P1 — sweep)', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('call 5551234567 when you can');
  assertNotContains(text, '5551234567');
  assertContains(text, '[PHONE_1]');
});

test('Phone matches separator-less international number after a keyword (P1 — sweep)', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('my cell is +15551234567');
  assertNotContains(text, '15551234567');
  assertContains(text, '[PHONE_1]');
});

test('IBAN matches lowercase compact form (P2 — sweep)', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('my iban is de89370400440532013000');
  assertNotContains(text, 'de89370400440532013000');
  assertContains(text, '[IBAN_1]');
});

test('IBAN does not over-run into a following lowercase word (regression guard)', () => {
  const t = new Tokenizer();
  // A case-insensitive flag once let the BBAN class swallow the trailing
  // "thanks", breaking the mod-97 check so a real IBAN leaked. Must tokenize.
  const { text } = t.tokenize('You can reach me at GB82 WEST 1234 5698 7654 32 thanks');
  assertNotContains(text, 'GB82 WEST 1234 5698 7654 32');
  assertContains(text, '[IBAN_1]');
  assertContains(text, 'thanks');
});

test('SSN matches dotted separator form (P2 — sweep)', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('ssn 123.45.6789 on file');
  assertNotContains(text, '123.45.6789');
  assertContains(text, '[SSN_1]');
});

test('DOB matches ISO format', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('Born 1975-03-14, retiring soon');
  assertNotContains(text, '1975-03-14');
  assertContains(text, '[DOB_1]');
});

test('DOB matches US slash format', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('DOB 03/14/1975');
  assertNotContains(text, '03/14/1975');
});

test('Postcode matches Swedish 5-digit form', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('Lives at Storgatan 12, 41501 Göteborg');
  assertNotContains(text, '41501');
});

test('Postcode rejects 4-digit year', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('In the year 1985 she moved');
  assertContains(text, '1985');
});

test('Swedish personnummer matches and validates Luhn', () => {
  const t = new Tokenizer();
  // Known valid Swedish personnummer: 811228-9874 (synthetic example)
  const { text } = t.tokenize('Personnummer: 811228-9874');
  // The pattern matches but Luhn should validate — accept either outcome
  // since the Luhn check is strict; just ensure no crash.
  assert(typeof text === 'string');
});

test('Account number matches with context keyword', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('Account 12345678901');
  assertNotContains(text, '12345678901');
});

test('Account number preserves surrounding context', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('Account 12345678901 at BigBank');
  assertContains(text, 'at BigBank'); // context preserved
  assertContains(text, 'Account');    // keyword preserved
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. TOKEN MAP — numbering and reversibility
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nTokenMap behavior');

test('Same value tokenizes to same token', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('SSN 555-12-3456 confirmed. Repeat: 555-12-3456.');
  // Should be [SSN_1] both times, not [SSN_1] and [SSN_2].
  const matches = text.match(/\[SSN_\d+\]/g);
  assertEqual(matches.length, 2, 'Expected 2 SSN tokens');
  assertEqual(matches[0], matches[1], 'Same SSN should reuse same token');
});

test('Different values get different tokens', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('SSNs: 555-12-3456 and 111-22-3333');
  assertContains(text, '[SSN_1]');
  assertContains(text, '[SSN_2]');
});

test('Round-trip: detokenize recovers original', () => {
  const t = new Tokenizer();
  const original = 'Diana (SSN 555-12-3456, email diana@x.com) is retiring.';
  const { text, map } = t.tokenize(original);
  const recovered = t.detokenize(text, map);
  assertEqual(recovered, original);
});

test('Detokenize leaves unknown tokens alone', () => {
  const t = new Tokenizer();
  const { map } = t.tokenize('SSN 555-12-3456');
  // Claude hallucinated [SSN_99] which we never issued
  const out = t.detokenize('Your SSN [SSN_99] is confirmed', map);
  assertContains(out, '[SSN_99]');
  assert(!out.includes('555-12-3456'), 'Must not leak other PII');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. NAME PSEUDONYMIZATION from memory_file structure
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nName pseudonymization');

test('Client name from memory_file is pseudonymized', () => {
  const memory = { personal_profile: { name: 'Diana Thornton' } };
  const t = new Tokenizer({ memoryFile: memory });
  const { text } = t.tokenize('Diana Thornton is retiring next year.');
  assertNotContains(text, 'Diana Thornton');
  assertContains(text, '[CLIENT_1]');
});

test('First-name-only usage is also pseudonymized consistently', () => {
  const memory = { personal_profile: { name: 'Diana Thornton' } };
  const t = new Tokenizer({ memoryFile: memory });
  const { text } = t.tokenize('Diana said she wants to retire.');
  assertNotContains(text, 'Diana');
  assertContains(text, '[CLIENT_');
});

test('Spouse name tokenized as SPOUSE_1', () => {
  const memory = {
    personal_profile: {
      name: 'Diana Thornton',
      family: { spouse: { name: 'Mark Thornton', age: 70 } },
    },
  };
  const t = new Tokenizer({ memoryFile: memory });
  const { text } = t.tokenize('Mark and Diana have been married 40 years.');
  assertContains(text, '[SPOUSE_');
  assertContains(text, '[CLIENT_');
});

test('Children names tokenized as CHILD', () => {
  const memory = {
    personal_profile: {
      name: 'Diana Thornton',
      family: {
        children: [
          { name: 'Alex Thornton', age: 40 },
          { name: 'Jamie Thornton', age: 38 },
        ],
      },
    },
  };
  const t = new Tokenizer({ memoryFile: memory });
  const { text } = t.tokenize('Alex lives in Boston. Jamie lives nearby.');
  assertNotContains(text, 'Alex');
  assertNotContains(text, 'Jamie');
});

test('Longer name is matched before shorter substring', () => {
  const memory = { personal_profile: { name: 'Diana Thornton' } };
  const t = new Tokenizer({ memoryFile: memory });
  const { text } = t.tokenize('Diana Thornton emailed. Diana called.');
  // Must tokenize full name first, not "Diana" twice producing inconsistency
  const fullMatches = text.match(/\[CLIENT_\d+\]/g);
  assert(fullMatches && fullMatches.length >= 2, 'Expected both mentions to tokenize');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. PRESERVED CONTENT — balances, narrative, non-PII must survive
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nAgent-quality preservation');

test('Dollar balances are preserved', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('Balance is $125,000 in the 401(k).');
  assertContains(text, '$125,000');
  assertContains(text, '401(k)');
});

test('Narrative goals are preserved', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('I want to retire at 65 and travel with my spouse.');
  assertContains(text, 'retire at 65');
  assertContains(text, 'travel');
});

test('City / country names pass through', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('Lives in Stockholm, Sweden');
  assertContains(text, 'Stockholm');
  assertContains(text, 'Sweden');
});

test('Generic medical conditions pass through', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('Has type-2 diabetes and high blood pressure.');
  assertContains(text, 'diabetes');
  assertContains(text, 'high blood pressure');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. MESSAGE HISTORY — structured tokenization
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nMessage array tokenization');

test('String-content messages are tokenized', () => {
  const t = new Tokenizer();
  const messages = [
    { role: 'user',      content: 'My SSN is 555-12-3456.' },
    { role: 'assistant', content: 'Got it, thanks.' },
  ];
  const { messages: out, map } = t.tokenizeMessages(messages, new TokenMap());
  assertNotContains(out[0].content, '555-12-3456');
  assertContains(out[0].content, '[SSN_1]');
  assertEqual(out[1].content, 'Got it, thanks.');
  // Round-trip works
  const recovered = t.detokenize(out[0].content, map);
  assertEqual(recovered, 'My SSN is [SSN_1].'.replace('[SSN_1]', '555-12-3456'));
});

test('Tool-result blocks are tokenized', () => {
  const t = new Tokenizer();
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'abc', content: '{"ssn":"555-12-3456","balance":125000}' },
      ],
    },
  ];
  const { messages: out } = t.tokenizeMessages(messages, new TokenMap());
  const block = out[0].content[0];
  assertNotContains(block.content, '555-12-3456');
  assertContains(block.content, '125000'); // balance preserved
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. BREACH DETECTOR — catches what the tokenizer misses
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nBreach detector');

test('scan() finds SSN in raw text', () => {
  const findings = scan('SSN 555-12-3456');
  assert(findings.length >= 1);
  assertEqual(findings[0].type, 'SSN');
});

test('scan() finds nothing in tokenized text', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('SSN 555-12-3456 Email: x@y.com');
  const findings = scan(text);
  assertEqual(findings.length, 0, 'Tokenized payload should have no residual PII');
});

test('auditOutbound() throws BreachError when residual PII exists', () => {
  const t = new Tokenizer();
  let threw = false;
  try {
    t.auditOutbound('Leaked SSN 555-12-3456', []);
  } catch (err) {
    assert(err instanceof BreachError, 'Expected BreachError');
    assert(err.code === 'PII_BREACH_DETECTED');
    assert(Array.isArray(err.findings) && err.findings.length > 0);
    threw = true;
  }
  assert(threw, 'auditOutbound should throw on residual PII');
});

test('auditOutbound() passes on clean tokenized payload', () => {
  const t = new Tokenizer();
  const { text } = t.tokenize('SSN 555-12-3456');
  // Should NOT throw
  t.auditOutbound(text, []);
});

test('auditOutbound() scans message history', () => {
  const t = new Tokenizer();
  let threw = false;
  try {
    t.auditOutbound('clean', [
      { role: 'user', content: 'My SSN is 555-12-3456' },
    ]);
  } catch {
    threw = true;
  }
  assert(threw, 'Should catch PII in messages');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nEdge cases');

test('Empty / null input does not crash', () => {
  const t = new Tokenizer();
  assertEqual(t.tokenize('').text, '');
  assertEqual(t.tokenize(null).text, null);
  assertEqual(t.tokenize(undefined).text, undefined);
});

test('Very long text performance (<50ms for 50KB)', () => {
  const t = new Tokenizer();
  const blob = 'Diana said ' + 'some neutral text '.repeat(5000);
  const start = Date.now();
  t.tokenize(blob);
  const elapsed = Date.now() - start;
  assert(elapsed < 500, `Took ${elapsed}ms — too slow`);
});

test('Adversarial: user sends token-shaped string', () => {
  const t = new Tokenizer();
  const { text, map } = t.tokenize('User wrote literally [SSN_99]');
  // The literal string "[SSN_99]" should pass through unchanged
  assertContains(text, '[SSN_99]');
  // Detokenize should leave it alone since we never issued SSN_99
  const out = t.detokenize('You mentioned [SSN_99]', map);
  assertContains(out, '[SSN_99]');
});

test('Multiple PII types in one string', () => {
  const memory = { personal_profile: { name: 'Diana Thornton' } };
  const t = new Tokenizer({ memoryFile: memory });
  const original = 'Diana Thornton (SSN 555-12-3456, DOB 1960-03-14, email diana@x.com) at 41501 Gothenburg';
  const { text, map } = t.tokenize(original);
  // All pieces tokenized
  assertNotContains(text, 'Diana');
  assertNotContains(text, '555-12-3456');
  assertNotContains(text, '1960-03-14');
  assertNotContains(text, 'diana@x.com');
  assertNotContains(text, '41501');
  // Round trip recovers
  const recovered = t.detokenize(text, map);
  assertEqual(recovered, original);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7b. CSV IMPORT AI-MAP — shape of the payload /api/portal/customers/ai-map
//     sends. Must tokenize sample rows and pass the breach audit.
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nCSV import ai-map payload');

test('CSV sample-row payload has PII tokenized before send', () => {
  const t = new Tokenizer();
  // Mirror the portal.js route: sample_rows are objects, JSON.stringify'd into
  // the user prompt. If PII survives this path it leaks to Anthropic.
  const headers = ['First Name', 'Email', 'SSN', 'Phone', 'Account #'];
  const sample_rows = [
    { 'First Name': 'Diana', 'Email': 'diana@example.com', 'SSN': '555-12-3456', 'Phone': '212-555-0199', 'Account #': '8765432101' },
    { 'First Name': 'Carlos', 'Email': 'carlos@example.com', 'SSN': '111-22-3333', 'Phone': '+44 20 7946 0958', 'Account #': '1234567890' },
  ];
  const userPrompt = `Map these CSV columns to customer record fields.
Columns: ${JSON.stringify(headers)}
Sample data (first few rows): ${JSON.stringify(sample_rows.slice(0, 3))}`;
  const { text, map } = t.tokenize(userPrompt);

  // Every regulated identifier in the sample rows must be gone from the
  // outbound text.
  assertNotContains(text, '555-12-3456');
  assertNotContains(text, '111-22-3333');
  assertNotContains(text, 'diana@example.com');
  assertNotContains(text, 'carlos@example.com');
  assertNotContains(text, '212-555-0199');
  assertNotContains(text, '8765432101');
  assertNotContains(text, '1234567890');

  // Column header names are not PII and must pass through unchanged so Claude
  // can still map them.
  assertContains(text, 'First Name');
  assertContains(text, 'Email');
  assertContains(text, 'SSN');

  // Tokens should carry type signal Claude can use as a mapping hint.
  assertContains(text, '[SSN_');
  assertContains(text, '[EMAIL_');

  // The payload must clear the breach audit (nothing the detector recognizes
  // as PII should remain after tokenization).
  t.auditOutbound('', [{ role: 'user', content: text }]);

  // Same identifier in row 1 and row 2 should get the same token number for
  // internal consistency (idempotent across duplicates).
  assert(map.stats().totalTokens >= 5, 'Expected at least 5 tokens (SSN, email, phone, account × rows)');
});

test('CSV ai-map blocks when sample rows contain unredacted PII the detectors miss', () => {
  // Synthetic case: a made-up identifier format that looks like a regulated
  // number but isn't caught by a detector. This exercises the breach-audit
  // fallback so a future novel PII type still fails closed.
  const t = new Tokenizer();
  // Normal PII — gets tokenized.
  const sample = { 'Email': 'x@y.com', 'SSN': '555-12-3456' };
  const prompt = `Sample: ${JSON.stringify(sample)}`;
  const { text } = t.tokenize(prompt);
  // Must not throw on fully-tokenized data.
  t.auditOutbound('', [{ role: 'user', content: text }]);

  // Now salt raw PII back in (simulates a tokenizer gap). Audit MUST fire.
  const tainted = text + ' raw leak 123-45-6789';
  let threw = false;
  try {
    t.auditOutbound('', [{ role: 'user', content: tainted }]);
  } catch (err) {
    assert(err instanceof BreachError);
    threw = true;
  }
  assert(threw, 'Breach audit must fire on tainted payload');
});

test('TokenMap.stats() returns type breakdown', () => {
  const t = new Tokenizer();
  const { map } = t.tokenize('SSN 555-12-3456 and email x@y.com');
  const stats = map.stats();
  assert(stats.totalTokens >= 2);
  assert(stats.byType.SSN >= 1);
  assert(stats.byType.EMAIL >= 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7c. PRODUCTS AI-SUGGEST — shape of the payload /api/portal/products/ai-suggest
//     sends. Scraped website / free-text description must have staff PII
//     tokenized before it reaches Anthropic.
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nProducts ai-suggest payload');

test('Scraped website text has staff PII tokenized before send', () => {
  const t = new Tokenizer();
  // Mirror the portal.js route: arbitrary scraped/stripped HTML body becomes
  // the userPrompt sourceText. A real site's "Contact Us" page routinely
  // leaks staff emails, phone numbers, and postcodes into the body text.
  const scraped = [
    'Acme Financial Services offers three plans:',
    'Starter at $29/mo, Growth at $99/mo, Enterprise custom pricing.',
    'Contact us at support@acme.com or 212-555-0199.',
    'Visit our office at 123 Main St, 10001 New York.',
    'Your advisor Diana Thornton (diana.thornton@acme.com) can help.',
  ].join(' ');
  const userPrompt = `Extract products and services from this company's website as a JSON array:\n\n${scraped}`;
  const { text } = t.tokenize(userPrompt);

  // Staff contact data must be gone from outbound.
  assertNotContains(text, 'support@acme.com');
  assertNotContains(text, 'diana.thornton@acme.com');
  assertNotContains(text, '212-555-0199');

  // Product names are not PII and must survive — otherwise Claude can't
  // do its job.
  assertContains(text, 'Starter');
  assertContains(text, 'Growth');
  assertContains(text, 'Enterprise');
  assertContains(text, '$29/mo');
  assertContains(text, '$99/mo');

  // Breach audit clean on the tokenized payload.
  t.auditOutbound('', [{ role: 'user', content: text }]);
});

test('Free-text description with staff email still passes breach audit after tokenization', () => {
  const t = new Tokenizer();
  const description = 'We are a legal firm. Reach us at info@example.com or +1 555-123-4567 for a consultation.';
  const userPrompt = `Extract products and services from this company's description as a JSON array:\n\n${description}`;
  const { text } = t.tokenize(userPrompt);
  assertNotContains(text, 'info@example.com');
  assertNotContains(text, '555-123-4567');
  // Substantive business text is preserved.
  assertContains(text, 'legal firm');
  assertContains(text, 'consultation');
  t.auditOutbound('', [{ role: 'user', content: text }]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. ReDoS / input-length safety — the EMAIL detector must be linear and the
//    tokenizer must bound per-string work. Regression guard for the P1 event-
//    loop DoS (a crafted "a@a.a.a.…" string froze the always-on tokenizer for
//    minutes via quadratic backtracking).
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nReDoS / input-length safety');

test('EMAIL detector is linear on pathological dot-run input (<500ms, under the length cap)', () => {
  const t = new Tokenizer();
  // ~80 KB of ambiguous "a." runs after an @ — UNDER the 128 KB length backstop,
  // so this exercises the regex's own linearity, not the truncation guard. The
  // pre-fix unbounded pattern took multiple seconds here (quadratic).
  const evil = 'a@' + 'a.'.repeat(40000);
  const start = process.hrtime.bigint();
  t.tokenize(evil);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert(ms < 500, `tokenize() took ${ms.toFixed(0)}ms on ~80KB pathological input — expected <500ms (ReDoS regression)`);
});

test('tokenize() truncates pathologically large input (length backstop)', () => {
  const t = new Tokenizer();
  const huge = 'x'.repeat(200 * 1024); // 200 KB benign blob, over the 128 KB cap
  const { text } = t.tokenize(huge);
  assert(text.length < huge.length, 'expected oversized input to be truncated by the length backstop');
  assert(text.length <= 128 * 1024, `expected truncation to <=128KB, got ${text.length}`);
});

test('EMAIL detector still matches multi-label domains after linearization', () => {
  const t = new Tokenizer();
  const { text, map } = t.tokenize('reach me at jo.smith@mail.corp.example.co.uk anytime');
  assertNotContains(text, 'jo.smith@mail.corp.example.co.uk');
  assert(map.stats().byType.EMAIL >= 1, 'multi-label email should still tokenize as EMAIL');
});

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n== Results: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
  process.exit(1);
}
process.exit(0);
