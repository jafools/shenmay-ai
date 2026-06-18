// @ts-check
const { test, expect } = require('@playwright/test');
const { SEL_DASHBOARD } = require('./helpers/constants');
const { loginViaAPI } = require('./helpers/auth');

test.describe('Dashboard Navigation', () => {
  let authToken = null;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const body = await loginViaAPI(page);
    authToken = body.token;
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    // Inject the shared token rather than re-logging in for every test
    await page.goto('/login');
    await page.evaluate((token) => {
      localStorage.setItem('shenmay_portal_token', token);
    }, authToken);
    await page.goto('/dashboard');
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  });

  test('dashboard overview loads with welcome heading', async ({ page }) => {
    const heading = page.locator(SEL_DASHBOARD.welcomeHeading).first();
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test('navigate to conversations page', async ({ page }) => {
    const link = page.locator(SEL_DASHBOARD.navConversations).first();
    await link.click();
    await page.waitForURL(/\/conversations/, { timeout: 10_000 });
    expect(page.url()).toContain('/conversations');
  });

  test('navigate to customers page', async ({ page }) => {
    const link = page.locator(SEL_DASHBOARD.navCustomers).first();
    await link.click();
    await page.waitForURL(/\/customers/, { timeout: 10_000 });
    expect(page.url()).toContain('/customers');
  });

  test('navigate to tools page', async ({ page }) => {
    const link = page.locator(SEL_DASHBOARD.navTools).first();
    await link.click();
    await page.waitForURL(/\/tools/, { timeout: 10_000 });
    expect(page.url()).toContain('/tools');
  });

  test('navigate to settings page', async ({ page }) => {
    const link = page.locator(SEL_DASHBOARD.navSettings).first();
    await link.click();
    await page.waitForURL(/\/settings/, { timeout: 10_000 });
    expect(page.url()).toContain('/settings');
  });

  test('navigate to team page', async ({ page }) => {
    const link = page.locator(SEL_DASHBOARD.navTeam).first();
    await link.click();
    await page.waitForURL(/\/team/, { timeout: 10_000 });
    expect(page.url()).toContain('/team');
  });

  test('profile page loads', async ({ page }) => {
    // Navigate via URL since profile may not always be in sidebar nav
    await page.goto('/dashboard/profile');
    await page.waitForURL(/\/profile/, { timeout: 10_000 });
    expect(page.url()).toContain('/profile');
  });

  test('plans page loads', async ({ page }) => {
    await page.goto('/dashboard/plans');
    await page.waitForURL(/\/plans/, { timeout: 10_000 });
    expect(page.url()).toContain('/plans');
  });

  test('invalid dashboard route stays within dashboard shell', async ({ page }) => {
    // Use client-side navigation (no full page reload) so ShenmayAuthProvider
    // stays mounted and doesn't re-fire getMe() — which can fail transiently
    // when the cold request hits the prod API mid-test.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/dashboard/nonexistent-page');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    });
    // React Router inner catch-all redirects back to /dashboard. Wait for the
    // URL to settle on a real /dashboard route (no longer the nonexistent one)
    // rather than sleeping a fixed beat.
    await page.waitForURL((url) => {
      const path = url.pathname;
      return path.startsWith('/dashboard') && !path.includes('nonexistent-page');
    }, { timeout: 10_000 });
    expect(page.url()).not.toContain('/login');
  });
});
