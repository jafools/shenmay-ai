// @ts-check
/**
 * Dashboard Route Smoke
 *
 * Walks every dashboard nav route and asserts:
 *   - HTTP navigation succeeds (not 4xx/5xx)
 *   - Zero console.error events fire during render
 *   - Zero uncaught page errors fire
 *
 * Why this exists: in v3.3.7 the /dashboard/settings route shipped to prod
 * with a render-time `ReferenceError: PRESET_COLORS is not defined`. The
 * page was a pure dark-blue blank page. Type-check + build + every existing
 * e2e spec was green — none of them navigated to /dashboard/settings after
 * onboarding. This spec catches that whole class of regression by proving
 * each dashboard route mounts without crashing.
 *
 * Filters: some console output is benign (info logs, intentional warnings,
 * 401s during auth handoff). We allow-list known noise patterns and fail
 * only on unfiltered errors.
 */
const { test, expect } = require('@playwright/test');
const { loginViaAPI } = require('./helpers/auth');

// Routes to walk. Index ('') = /dashboard. Detail routes (e.g. /conversations/:id)
// require live data and are out of scope here — top-level nav surface only.
const DASHBOARD_ROUTES = [
  { path: '', name: 'overview' },
  { path: '/conversations', name: 'conversations' },
  { path: '/customers', name: 'customers' },
  { path: '/concerns', name: 'concerns' },
  { path: '/tools', name: 'tools' },
  { path: '/team', name: 'team' },
  { path: '/plans', name: 'plans' },
  { path: '/settings', name: 'settings' },
  { path: '/profile', name: 'profile' },
];

// Console messages we deliberately ignore. Keep this list TIGHT — every
// pattern here is a hole in the smoke check.
const IGNORED_ERROR_PATTERNS = [
  // React DevTools nag — fires in CI without the extension installed.
  /Download the React DevTools/i,
  // Vite HMR connection chatter when running against dev server.
  /\[vite\] (connected|connecting|server connection lost)/i,
  // Browser extension noise (rare but seen in dev).
  /chrome-extension:\/\//i,
  // Aborted fetches when navigating away mid-request — not a real error.
  /AbortError/i,
];

function isIgnored(text) {
  return IGNORED_ERROR_PATTERNS.some((re) => re.test(text));
}

test.describe('Dashboard Route Smoke', () => {
  let authToken = null;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const body = await loginViaAPI(page);
    authToken = body.token;
    await page.close();
  });

  for (const { path, name } of DASHBOARD_ROUTES) {
    test(`${name} route renders without console errors`, async ({ page }) => {
      const consoleErrors = [];
      const pageErrors = [];

      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (isIgnored(text)) return;
        consoleErrors.push(text);
      });
      page.on('pageerror', (err) => {
        const text = err?.message || String(err);
        if (isIgnored(text)) return;
        pageErrors.push(text);
      });

      // Inject token without provoking a re-login flow.
      await page.goto('/login');
      await page.evaluate((token) => {
        localStorage.setItem('shenmay_portal_token', token);
      }, authToken);

      const url = `/dashboard${path}`;
      const response = await page.goto(url, { waitUntil: 'networkidle' });

      // The SPA returns 200 for every client-side route; we still assert
      // the document load itself isn't a server error.
      expect(response, `no response for ${url}`).not.toBeNull();
      const status = response.status();
      expect(
        status,
        `${url} document responded with HTTP ${status}`,
      ).toBeLessThan(400);

      // INTENTIONAL settle window — NOT replaceable with a deterministic wait.
      // This spec asserts the *absence* of console/page errors fired by lazy
      // effects after networkidle. There is no positive DOM/response signal to
      // await for "no error will fire" — we have to give React a fixed beat to
      // mount the tree and run late effects, then check nothing threw.
      // Settings is the heaviest page (11 child sections, each with its own
      // API call) so it benefits from a longer settle window.
      await page.waitForTimeout(1500);

      // When this assertion fails, the actual render-time error is the most
      // useful clue. Surface console/page errors first so the failure message
      // includes the actual cause, not just "empty body".
      const bodyTextLength = await page.evaluate(() => document.body.innerText.length);
      const bodyEmpty      = bodyTextLength <= 20;

      if (consoleErrors.length || pageErrors.length || bodyEmpty) {
        const detail = [
          bodyEmpty ? `body innerText length: ${bodyTextLength} (expected > 20)` : '',
          consoleErrors.length ? `console.error (${consoleErrors.length}):\n  - ${consoleErrors.join('\n  - ')}` : '',
          pageErrors.length ? `pageerror (${pageErrors.length}):\n  - ${pageErrors.join('\n  - ')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        throw new Error(`${url} failed render-smoke check:\n${detail}`);
      }
    });
  }
});
