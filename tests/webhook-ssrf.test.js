/**
 * SHENMAY AI — Webhook SSRF Guard Unit Tests
 *
 * Pure-JS unit tests — no DB, no server, no real network (global.fetch is
 * stubbed). Runs in ~50ms.
 *
 * Covers the SSRF guard on the custom-tool "connect" surface, which — unlike
 * the tenant-webhook / Slack / Teams surfaces — fires a tenant-controlled
 * fetch() AND returns the response body to the caller (a full-read SSRF if
 * left unvalidated). See server/src/utils/validateWebhookUrl.js and the
 * `case 'connect':` block in server/src/tools/custom_tool_handler.js.
 *
 * Coverage:
 *   - validateWebhookUrl: blocks http, localhost, RFC1918, 169.254 metadata,
 *     CGNAT, IPv6 loopback, embedded credentials, oversized + malformed URLs;
 *     allows ordinary public HTTPS (incl. the 172.32 boundary just outside
 *     the RFC1918 Class B range).
 *   - handleCustomTool connect: an internal webhook_url is rejected WITHOUT
 *     issuing the fetch (defence-in-depth for rows predating route validation).
 *   - handleCustomTool connect: a valid public webhook_url is fetched once
 *     with redirect:'manual', and the body is returned.
 *   - handleCustomTool connect: a redirect response is rejected before its
 *     body is read (blocks the public-URL -> 302 -> 169.254.169.254 bypass).
 *
 * Run:  node tests/webhook-ssrf.test.js
 */

'use strict';

const { validateWebhookUrl, validateWebhookUrlAsync, isBlockedAddress } = require('../server/src/utils/validateWebhookUrl');
const { handleCustomTool }   = require('../server/src/tools/custom_tool_handler');

// ── Async-aware test runner (matches tests/brand-learning.test.js style) ─────

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
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

// Run a body with global.fetch swapped for a stub, always restoring it.
async function withStubbedFetch(stub, body) {
  const original = global.fetch;
  global.fetch = stub;
  try {
    return await body();
  } finally {
    global.fetch = original;
  }
}

const connectTool = (webhook_url, extra = {}) => ({
  tool_type:    'connect',
  name:         'connect_crm',
  display_name: 'Connect CRM',
  config:       { webhook_url, method: 'POST', ...extra },
});
const ctx = { db: null, tenantId: 'tenant-1', customerId: 'customer-1' };

(async () => {
  console.log('\n== Webhook SSRF Guard Unit Tests ==\n');

  // ═════════════════════════════════════════════════════════════════════════
  // 1. validateWebhookUrl — the shared string-only guard
  // ═════════════════════════════════════════════════════════════════════════
  console.log('validateWebhookUrl');

  await test('allows an ordinary public HTTPS URL', () => {
    assertEqual(validateWebhookUrl('https://api.example.com/client-data'), null,
      'a normal public HTTPS URL should be valid');
  });

  await test('allows 172.32.x (just outside RFC1918 Class B)', () => {
    assertEqual(validateWebhookUrl('https://172.32.0.1/x'), null,
      '172.32.0.0 is public — must not be blocked');
  });

  await test('blocks non-HTTPS (http)', () => {
    assert(validateWebhookUrl('http://api.example.com/x'), 'http must be rejected');
  });

  await test('blocks localhost', () => {
    assert(validateWebhookUrl('https://localhost/x'), 'localhost must be rejected');
  });

  await test('blocks 127.0.0.1 loopback', () => {
    assert(validateWebhookUrl('https://127.0.0.1/x'), 'loopback must be rejected');
  });

  await test('blocks RFC1918 10.x', () => {
    assert(validateWebhookUrl('https://10.0.0.5/x'), '10.x must be rejected');
  });

  await test('blocks RFC1918 172.16.x', () => {
    assert(validateWebhookUrl('https://172.16.0.1/x'), '172.16.x must be rejected');
  });

  await test('blocks RFC1918 192.168.x', () => {
    assert(validateWebhookUrl('https://192.168.1.1/x'), '192.168.x must be rejected');
  });

  await test('blocks 169.254.169.254 cloud-metadata endpoint', () => {
    assert(validateWebhookUrl('https://169.254.169.254/latest/meta-data/'),
      'link-local / cloud metadata must be rejected');
  });

  await test('blocks 100.64.x CGNAT shared range', () => {
    assert(validateWebhookUrl('https://100.64.0.1/x'), 'CGNAT range must be rejected');
  });

  await test('blocks IPv6 loopback [::1]', () => {
    assert(validateWebhookUrl('https://[::1]/x'), 'IPv6 loopback must be rejected');
  });

  await test('blocks embedded credentials (user:pass@host)', () => {
    assert(validateWebhookUrl('https://user:pass@api.example.com/x'),
      'URLs with credentials must be rejected');
  });

  await test('blocks oversized URL (>512 chars)', () => {
    assert(validateWebhookUrl('https://api.example.com/' + 'a'.repeat(600)),
      'oversized URL must be rejected');
  });

  await test('blocks a malformed URL string', () => {
    assert(validateWebhookUrl('not a url'), 'malformed URL must be rejected');
  });

  await test('blocks empty / missing URL', () => {
    assert(validateWebhookUrl(''),        'empty string must be rejected');
    assert(validateWebhookUrl(undefined), 'undefined must be rejected');
    assert(validateWebhookUrl(null),      'null must be rejected');
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 2. handleCustomTool 'connect' — defensive guard + redirect blocking
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nhandleCustomTool (connect)');

  await test('internal webhook_url is rejected WITHOUT calling fetch', async () => {
    let called = false;
    const result = await withStubbedFetch(
      async () => { called = true; return { ok: true, status: 200, type: 'basic', text: async () => '{}' }; },
      () => handleCustomTool(connectTool('https://169.254.169.254/latest/meta-data/'), {}, ctx)
    );
    assert(called === false, 'fetch must NOT be called for an internal/invalid URL');
    assertEqual(result.success, false, 'result.success must be false');
    assert(/invalid webhook URL/i.test(result.error), `expected an "invalid webhook URL" error, got: ${result.error}`);
  });

  await test('non-HTTPS webhook_url is rejected WITHOUT calling fetch', async () => {
    let called = false;
    const result = await withStubbedFetch(
      async () => { called = true; return { ok: true, status: 200, type: 'basic', text: async () => '{}' }; },
      () => handleCustomTool(connectTool('http://api.example.com/x'), {}, ctx)
    );
    assert(called === false, 'fetch must NOT be called for a non-HTTPS URL');
    assertEqual(result.success, false, 'result.success must be false');
  });

  await test('valid public webhook_url is fetched once with redirect:manual and returns the body', async () => {
    const calls = [];
    const result = await withStubbedFetch(
      async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, status: 200, type: 'basic', text: async () => JSON.stringify({ hello: 'world' }) };
      },
      () => handleCustomTool(connectTool('https://api.example.com/client-data'), { q: 1 }, ctx)
    );
    assertEqual(calls.length, 1, 'fetch must be called exactly once for a valid URL');
    assertEqual(calls[0].url, 'https://api.example.com/client-data', 'fetch must target the configured URL');
    assertEqual(calls[0].opts.redirect, 'manual', 'fetch must be issued with redirect:manual');
    assertEqual(result.success, true, 'result.success must be true');
    assertEqual(result.status, 200, 'result.status must be 200');
    assertEqual(JSON.stringify(result.data), JSON.stringify({ hello: 'world' }), 'response body must be returned');
  });

  await test('opaqueredirect response is blocked before the body is read', async () => {
    let bodyRead = false;
    const result = await withStubbedFetch(
      async () => ({
        type:   'opaqueredirect',
        status: 0,
        ok:     false,
        text:   async () => { bodyRead = true; return 'LEAKED_INTERNAL_BODY'; },
      }),
      () => handleCustomTool(connectTool('https://evil.example.com/redir'), {}, ctx)
    );
    assert(bodyRead === false, 'the redirect body must NOT be read');
    assertEqual(result.success, false, 'result.success must be false');
    assert(/redirect/i.test(result.error), `expected a redirect error, got: ${result.error}`);
    assert(!/LEAKED_INTERNAL_BODY/.test(JSON.stringify(result)), 'no body may leak in the result');
  });

  await test('3xx redirect response is blocked before the body is read', async () => {
    let bodyRead = false;
    const result = await withStubbedFetch(
      async () => ({
        type:   'basic',
        status: 302,
        ok:     false,
        text:   async () => { bodyRead = true; return 'LEAKED_INTERNAL_BODY'; },
      }),
      () => handleCustomTool(connectTool('https://evil.example.com/redir'), {}, ctx)
    );
    assert(bodyRead === false, 'the redirect body must NOT be read');
    assertEqual(result.success, false, 'result.success must be false');
    assert(/redirect/i.test(result.error), `expected a redirect error, got: ${result.error}`);
  });

  await test('missing webhook_url is reported as misconfiguration WITHOUT calling fetch', async () => {
    let called = false;
    const result = await withStubbedFetch(
      async () => { called = true; return { ok: true, status: 200, type: 'basic', text: async () => '{}' }; },
      () => handleCustomTool(connectTool(undefined), {}, ctx)
    );
    assert(called === false, 'fetch must NOT be called when webhook_url is missing');
    assertEqual(result.success, false, 'result.success must be false');
    assert(/misconfigured/i.test(result.error), `expected a misconfiguration error, got: ${result.error}`);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 3. isBlockedAddress — resolved-IP classification (the internal-A-record /
  //    DNS defense, plus IPv4-mapped-IPv6 normalization). Pure + deterministic.
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nisBlockedAddress (resolved IPs)');

  await test('blocks loopback / RFC1918 / link-local / CGNAT / IPv6 internal / mapped', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1',
                      '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1',
                      '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
      assert(isBlockedAddress(ip), `${ip} must be blocked`);
    }
  });

  await test('allows ordinary public IPs (incl. mapped public + 172.32 boundary)', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '1.1.1.1', '::ffff:93.184.216.34']) {
      assert(!isBlockedAddress(ip), `${ip} must be allowed`);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 4. validateWebhookUrlAsync — sync string checks + DNS resolution (the
  //    public-hostname-with-internal-A-record bypass). lookup is injected so
  //    these stay hermetic (no real DNS).
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nvalidateWebhookUrlAsync (DNS-resolving)');

  const lookupTo   = (...ips) => async () => ips.map(address => ({ address }));
  const lookupFail = async () => { throw new Error('ENOTFOUND'); };

  await test('rejects a public host that resolves to an internal IP (A-record bypass)', async () => {
    const err = await validateWebhookUrlAsync('https://sneaky.example.com/x', { lookup: lookupTo('10.0.0.5') });
    assert(err && /private|internal/i.test(err), `expected internal-address rejection, got: ${err}`);
  });

  await test('rejects when ANY resolved address is internal (mixed public+internal)', async () => {
    const err = await validateWebhookUrlAsync('https://mixed.example.com/x', { lookup: lookupTo('93.184.216.34', '169.254.169.254') });
    assert(err && /private|internal/i.test(err), `mixed result must be rejected, got: ${err}`);
  });

  await test('allows a public host that resolves to a public IP', async () => {
    const err = await validateWebhookUrlAsync('https://api.example.com/x', { lookup: lookupTo('93.184.216.34') });
    assertEqual(err, null, `a public-resolving host should pass, got: ${err}`);
  });

  await test('applies the sync checks first (http rejected without any DNS lookup)', async () => {
    let looked = false;
    const err = await validateWebhookUrlAsync('http://api.example.com/x', { lookup: async () => { looked = true; return [{ address: '93.184.216.34' }]; } });
    assert(err && /https/i.test(err), `http must be rejected by the sync stage, got: ${err}`);
    assert(looked === false, 'DNS lookup must not run when the sync check already fails');
  });

  await test('rejects an unresolvable host', async () => {
    const err = await validateWebhookUrlAsync('https://does-not-resolve.example.com/x', { lookup: lookupFail });
    assert(err && /resolve/i.test(err), `unresolvable host must be rejected, got: ${err}`);
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.message}`);
    process.exit(1);
  }
})();
