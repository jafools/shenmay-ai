// @ts-check
const { test, expect, request } = require('@playwright/test');

/**
 * Marketing-CTA regression guard
 *
 * WHY THIS EXISTS
 * ===============
 * 2026-04-24 we shipped a rebrand that dropped the `/shenmay/*` route prefix,
 * canonical login is now `shenmay.ai/login`, signup is `shenmay.ai/signup`.
 * The sibling marketing repo (ponten-solutions) kept CTAs pointing at
 * `/nomii/signup` for 4 days. Every "Start free trial" button fell through
 * React Router to /login → users couldn't sign up. Zero test caught it.
 *
 * This spec crawls the LIVE marketing page at
 *   https://pontensolutions.com/products/shenmay-ai
 * and asserts:
 *   1. No CTA points at a `/nomii/*` URL (hard regression guard).
 *   2. At least one CTA points at `shenmay.ai/signup` (the must-exist path).
 *   3. Every absolute link to `shenmay.ai` resolves (HEAD → 200 or 30x).
 *
 * OPT-IN (since 2026-11)
 * ======================
 * The marketing guard only runs when MARKETING_URL is set explicitly, e.g.
 *   MARKETING_URL=https://pontensolutions.com/products/shenmay-ai npx playwright test 07-marketing-ctas
 * The marketing site is a separate, Lovable-managed repo; its content changes
 * on its own schedule and must not turn this repo's CI red (the nightly e2e
 * failed on this spec from 2026-08-24 until GitHub disabled the schedule).
 * Shenmay is now sold "on request" and the signup CTA was removed on purpose,
 * so the "at least one CTA points at shenmay.ai/signup" check fails until
 * self-serve signup returns.
 *
 * THE SKIP CLAUSE
 * ===============
 * If the marketing site is unreachable (Cloudflare blip, Lovable build
 * down), the whole describe is skipped. This spec is a REGRESSION GUARD,
 * not an uptime monitor — we don't want a flake on pontensolutions.com to
 * block merges on the app repo.
 */

const MARKETING_URL = process.env.MARKETING_URL || '';
const PRODUCTION_APP = 'https://shenmay.ai';

test.describe('Marketing CTAs — regression guard', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!MARKETING_URL, 'Marketing-site guard is opt-in: set MARKETING_URL to run it.');

  let reachable = false;
  let links = [];
  let renderedText = '';

  test.beforeAll(async ({ browser }) => {
    // Lovable SPAs ship a near-empty index.html and rehydrate in JS —
    // raw fetches return a document with just `<div id="root"></div>`.
    // Use a real Chromium to render the page, so assertions see the
    // actual content customers see.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(MARKETING_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      // SPA mount + Direction B page is long — wait for visible headings.
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      renderedText = (await page.textContent('body').catch(() => '')) || '';
      links = await page.$$eval('a[href]', (anchors) =>
        anchors.map((a) => a.getAttribute('href') || ''),
      );
      reachable = renderedText.length > 200; // sanity: non-trivial content
    } catch (err) {
      console.warn(`[marketing-ctas] ${MARKETING_URL} unreachable (${err.message}) — skipping`);
    } finally {
      await page.close();
      await ctx.close();
    }
  });

  test.beforeEach(async () => {
    test.skip(!reachable, 'Marketing site unreachable or empty — regression guard skipped.');
  });

  test('marketing page contains the Shenmay wordmark', async () => {
    // Sanity check: we're on a Shenmay-branded page after JS rehydration.
    expect(renderedText.toLowerCase()).toContain('shenmay');
  });

  test('no CTA points at a /nomii/* path (hard regression guard)', async () => {
    const nomiiLeaks = links.filter((h) => /\/nomii(\/|$)/i.test(h));
    if (nomiiLeaks.length > 0) {
      console.error('[marketing-ctas] /nomii/* leaks found:', nomiiLeaks);
    }
    expect(nomiiLeaks).toEqual([]);
  });

  test('at least one CTA points at shenmay.ai/signup', async () => {
    const signupLinks = links.filter((h) =>
      /shenmay\.ai\/signup(\b|\/|$)/i.test(h) || h === '/signup',
    );
    expect(signupLinks.length, 'Expected at least one "Start free trial" style CTA').toBeGreaterThan(0);
  });

  test('absolute shenmay.ai links resolve (no 404)', async () => {
    const absoluteShenmayLinks = [...new Set(
      links.filter((h) => /^https?:\/\/(www\.)?shenmay\.ai\//i.test(h))
    )];

    // If the previous test populated `links`, we should have at least one.
    if (absoluteShenmayLinks.length === 0) {
      test.skip(true, 'No absolute shenmay.ai links to verify on this page.');
      return;
    }

    const ctx = await request.newContext({ timeout: 15_000 });
    try {
      for (const url of absoluteShenmayLinks) {
        const res = await ctx.get(url, { maxRedirects: 5 }).catch((err) => {
          throw new Error(`Failed to fetch ${url}: ${err.message}`);
        });
        const s = res.status();
        // 200/30x OK, 401/403 OK (gated routes), 404 NOT OK.
        expect(s, `Expected ${url} to not 404, got ${s}`).not.toBe(404);
        expect(s, `Expected ${url} < 500, got ${s}`).toBeLessThan(500);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test('no CTA links to the legacy nomii.pontensolutions.com domain', async () => {
    // Legacy domain still exists with selective 301s but should NOT be the
    // canonical CTA destination — new CTAs must point at shenmay.ai.
    const legacyLinks = links.filter((h) =>
      /nomii\.pontensolutions\.com(?!\/embed|\/widget|\/downloads|\/api)/i.test(h),
    );
    expect(legacyLinks).toEqual([]);
  });
});

test.describe('App-side route existence (no marketing needed)', () => {
  // These run regardless of marketing reachability. They protect against
  // the *app* side of the regression: if someone drops the /signup route
  // from React Router, this fails fast.

  test('GET /signup resolves on the configured base URL', async ({ baseURL, request }) => {
    // Only run against production-style base URLs (skip localhost dev where
    // the marketing-CTA destination is nominal).
    test.skip(!baseURL, 'No baseURL configured.');

    const url = `${baseURL.replace(/\/$/, '')}/signup`;
    const res = await request.get(url, { maxRedirects: 0 }).catch(() => null);
    if (!res) {
      test.skip(true, `Base URL ${baseURL} unreachable — infra test, not a regression.`);
      return;
    }
    // SPAs serve index.html (HTTP 200) for every in-app path. 404 here would
    // mean the asset pipeline itself is broken.
    expect(res.status(), `Expected /signup to resolve, got ${res.status()}`).toBeLessThan(400);
  });

  test('GET /login resolves on the configured base URL', async ({ baseURL, request }) => {
    test.skip(!baseURL, 'No baseURL configured.');
    const url = `${baseURL.replace(/\/$/, '')}/login`;
    const res = await request.get(url, { maxRedirects: 0 }).catch(() => null);
    if (!res) {
      test.skip(true, `Base URL ${baseURL} unreachable.`);
      return;
    }
    expect(res.status()).toBeLessThan(400);
  });

  test('GET /license resolves on the configured base URL', async ({ baseURL, request }) => {
    test.skip(!baseURL, 'No baseURL configured.');
    const url = `${baseURL.replace(/\/$/, '')}/license`;
    const res = await request.get(url, { maxRedirects: 0 }).catch(() => null);
    if (!res) {
      test.skip(true, `Base URL ${baseURL} unreachable.`);
      return;
    }
    expect(res.status()).toBeLessThan(400);
  });
});
