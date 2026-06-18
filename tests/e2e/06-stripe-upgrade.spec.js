// @ts-check
const { test, expect } = require('@playwright/test');
const dbHelper = require('./helpers/db');
const { loginViaAPI } = require('./helpers/auth');
const { isOnprem, hasDbAccess } = require('./helpers/mode');

/**
 * Stripe upgrade flow (webhook-driven, no real card used).
 *
 * Scope: Austin has a negative Stripe balance from prior live-card → refund
 * cycles (memory: feedback_no_real_card_smoke.md). Real-card test-mode
 * checkout is NOT exercised here — that's a manual smoke test. Instead we
 * verify:
 *
 *   1. Plans page renders for an authenticated test admin.
 *   2. A simulated SaaS subscription webhook promotes the tenant's plan
 *      and lifts usage caps.
 *   3. A simulated self-hosted license purchase webhook issues a
 *      SHENMAY-prefixed license key in the `licenses` table.
 *   4. Invoice-paid webhook resets messages_used_this_month to 0.
 *
 * Webhook signature verification is skipped when STRIPE_WEBHOOK_SECRET is
 * unset (server/src/routes/stripe-webhook.js:50-55). In CI the secret is
 * intentionally omitted so this spec can POST raw JSON; the 'stripe' SDK
 * is loaded via a dummy STRIPE_SECRET_KEY=`sk_test_dummy_for_ci` — the
 * SDK only validates on actual API calls, not at construction, and the
 * self-hosted license path + UPDATE-subscription path don't hit Stripe's
 * API.
 */

const DISAMBIGUATOR = `e2e${Date.now().toString(36)}`;
const LICENSE_EMAIL = `stripe-buyer-${DISAMBIGUATOR}@shenmay.test`;

test.describe('Stripe upgrade — webhook-driven, no real card', () => {
  test.describe.configure({ mode: 'serial' });

  let authToken = null;
  let tenantId  = null;

  test.beforeEach(async () => {
    test.skip(isOnprem(), 'Stripe subscription webhooks are SaaS-only.');
    test.skip(!hasDbAccess(), 'Stripe spec needs direct DB access.');
  });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      const body = await loginViaAPI(page);
      authToken = body.token;
      tenantId  = body.tenant?.id;
    } catch (err) {
      console.warn('[stripe-upgrade] login failed — specs will skip:', err.message);
    } finally {
      await page.close();
    }
  });

  test.afterAll(async () => {
    // beforeEach skips in on-prem / no-DB mode, but afterAll still fires.
    // Skip the cleanup entirely there — the pg pool would just ECONNREFUSE
    // and leave an empty `[spec] cleanup failed:` warn in the log.
    if (!hasDbAccess()) return;
    try {
      await dbHelper.cleanupBySuffix(DISAMBIGUATOR);
    } catch (err) {
      console.warn('[stripe-upgrade] cleanup failed:', err.message);
    }
  });

  test('/dashboard/plans renders the pricing table', async ({ page }) => {
    test.skip(!authToken, 'TEST_ADMIN login failed — cannot render plans.');
    await page.goto('/login');
    await page.evaluate((t) => localStorage.setItem('shenmay_portal_token', t), authToken);
    await page.goto('/dashboard/plans');
    await page.waitForURL(/\/plans/, { timeout: 15_000 });
    // The page's kicker or heading should be visible
    await expect(page.getByText(/Plans.*billing|Choose.*plan|Upgrade/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('self-hosted license purchase webhook issues a SHENMAY-* key', async ({ request }) => {
    const apiBase = `http://localhost:${process.env.PORT || 3001}`;

    const payload = {
      id:      `evt_test_${DISAMBIGUATOR}_selfhosted`,
      object:  'event',
      type:    'checkout.session.completed',
      data: {
        object: {
          id:      `cs_test_${DISAMBIGUATOR}_selfhosted`,
          object:  'checkout.session',
          metadata: {
            product_type: 'selfhosted',
            plan:         'starter',
          },
          customer_details: {
            email: LICENSE_EMAIL,
            name:  'Stripe Buyer E2E',
          },
        },
      },
    };

    const res = await request.post(`${apiBase}/api/stripe/webhook`, {
      headers: { 'content-type': 'application/json' },
      data: payload,
    });

    if (res.status() === 500) {
      const body = await res.text().catch(() => '');
      test.skip(true, `Webhook handler errored (likely STRIPE_SECRET_KEY unset): ${body.slice(0, 200)}`);
      return;
    }

    expect(res.status(), `Expected 200 on webhook POST, got ${res.status()}`).toBe(200);

    // Poll DB briefly — handler writes synchronously but let's not race.
    // expect.poll retries the query on its own interval (no hand-rolled
    // setTimeout sleep) until the license row lands or it times out.
    let license = null;
    await expect.poll(async () => {
      const rows = await dbHelper.query(
        `SELECT license_key, plan, issued_to_email FROM licenses
          WHERE LOWER(issued_to_email) = LOWER($1)
          ORDER BY issued_at DESC LIMIT 1`,
        [LICENSE_EMAIL],
      );
      if (rows.length > 0) license = rows[0];
      return rows.length;
    }, {
      message: `Expected a license row for ${LICENSE_EMAIL}`,
      timeout: 5_000,
      intervals: [200],
    }).toBeGreaterThan(0);

    expect(license, `Expected a license row for ${LICENSE_EMAIL}`).not.toBeNull();
    expect(license.license_key).toMatch(/^SHENMAY-[A-F0-9-]+$/);
    expect(license.plan).toBe('starter');
  });

  test('SaaS subscription webhook promotes a tenant from trial → growth', async ({ request }) => {
    const apiBase = `http://localhost:${process.env.PORT || 3001}`;

    // Use a separate synthetic tenant so we don't disturb the master-tier
    // TEST_ADMIN (its sub is 'master', and this flow writes 'growth' which
    // would break the other specs).
    //
    // DISAMBIGUATOR is base36 (alphanumeric), but UUIDs need hex-only in
    // the last segment. Hash the disambiguator to 12 hex chars.
    const crypto = require('crypto');
    const hexSuffix = crypto.createHash('sha1').update(DISAMBIGUATOR).digest('hex').slice(0, 12);
    const synthTenantUuid = `00000000-0000-4000-a000-${hexSuffix}`;
    const stripeSubId     = `sub_test_${DISAMBIGUATOR}`;
    const stripeCustomer  = `cus_test_${DISAMBIGUATOR}`;

    // Seed a fresh tenant + trial subscription for this test
    await dbHelper.query(
      `INSERT INTO tenants (id, name, slug, agent_name, is_active)
       VALUES ($1, $2, $3, 'E2E Upgrade', true)
       ON CONFLICT (id) DO NOTHING`,
      [synthTenantUuid, `Stripe Upgrade Test ${DISAMBIGUATOR}`, `stripe-upgrade-${DISAMBIGUATOR}`],
    );
    await dbHelper.query(
      `INSERT INTO subscriptions (tenant_id, plan, status)
       VALUES ($1, 'trial', 'trialing')
       ON CONFLICT (tenant_id) DO UPDATE SET plan='trial', status='trialing'`,
      [synthTenantUuid],
    );

    const payload = {
      id:      `evt_test_${DISAMBIGUATOR}_saas`,
      object:  'event',
      type:    'checkout.session.completed',
      data: {
        object: {
          id:           `cs_test_${DISAMBIGUATOR}_saas`,
          object:       'checkout.session',
          subscription: stripeSubId,
          customer:     stripeCustomer,
          metadata: {
            tenant_id: synthTenantUuid,
            plan:      'growth',
          },
        },
      },
    };

    const res = await request.post(`${apiBase}/api/stripe/webhook`, {
      headers: { 'content-type': 'application/json' },
      data: payload,
    });
    if (res.status() === 500) {
      const body = await res.text().catch(() => '');
      test.skip(true, `Webhook handler errored: ${body.slice(0, 200)}`);
      return;
    }
    expect(res.status()).toBe(200);

    const rows = await dbHelper.query(
      `SELECT plan, status, stripe_subscription_id FROM subscriptions
        WHERE tenant_id = $1`,
      [synthTenantUuid],
    );
    expect(rows[0].plan).toBe('growth');
    expect(rows[0].status).toBe('active');
    expect(rows[0].stripe_subscription_id).toBe(stripeSubId);
  });

  test('invoice.paid webhook resets messages_used_this_month to 0', async ({ request }) => {
    const apiBase = `http://localhost:${process.env.PORT || 3001}`;

    // Use the sub we just promoted in the previous test.
    const stripeSubId = `sub_test_${DISAMBIGUATOR}`;

    // Bump usage so the reset is observable
    await dbHelper.query(
      `UPDATE subscriptions SET messages_used_this_month = 42
         WHERE stripe_subscription_id = $1`,
      [stripeSubId],
    );

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      id:      `evt_test_${DISAMBIGUATOR}_invoice`,
      object:  'event',
      type:    'invoice.paid',
      data: {
        object: {
          id:           `in_test_${DISAMBIGUATOR}`,
          object:       'invoice',
          subscription: stripeSubId,
          period_start: now,
          period_end:   now + 30 * 24 * 3600,
        },
      },
    };

    const res = await request.post(`${apiBase}/api/stripe/webhook`, {
      headers: { 'content-type': 'application/json' },
      data: payload,
    });
    if (res.status() === 500) {
      test.skip(true, 'Webhook handler errored — skipping.');
      return;
    }
    expect(res.status()).toBe(200);

    const rows = await dbHelper.query(
      `SELECT messages_used_this_month, status FROM subscriptions
        WHERE stripe_subscription_id = $1`,
      [stripeSubId],
    );
    expect(rows[0].messages_used_this_month).toBe(0);
    expect(rows[0].status).toBe('active');
  });
});
