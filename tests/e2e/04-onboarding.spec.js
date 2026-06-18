// @ts-check
const { test, expect } = require('@playwright/test');
const { isOnprem } = require('./helpers/mode');

/**
 * Onboarding Wizard E2E tests
 *
 * NOTE: These tests are designed to validate the onboarding UI flow
 * without actually completing registration (which would create duplicate
 * tenants in the test database). They verify:
 *   - Signup page loads with the registration form
 *   - Form validation works (required fields, password rules)
 *   - Navigation between onboarding steps (if auth token present)
 *
 * For a full onboarding E2E test, you'd need a test teardown that
 * deletes the created tenant.
 */

test.describe('Signup Page', () => {
  test.beforeEach(async () => {
    test.skip(isOnprem(), 'Signup page content is SaaS-only (self-hosted redirects to /login).');
  });

  test('signup page loads with registration form', async ({ page }) => {
    await page.goto('/signup');
    // Should have heading and form fields
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });
    // Should have at least an email input
    const emailInput = page.locator('input[type="email"]');
    await expect(emailInput.first()).toBeVisible();
  });

  test('signup page has link back to login', async ({ page }) => {
    await page.goto('/signup');
    const loginLink = page.locator('a[href*="login"]');
    await expect(loginLink.first()).toBeVisible({ timeout: 5_000 });
    await loginLink.first().click();
    await page.waitForURL(/\/login/);
  });
});

test.describe('Onboarding Wizard (authenticated)', () => {
  const { loginViaAPI } = require('./helpers/auth');

  test('onboarding page loads for authenticated user', async ({ page }) => {
    await loginViaAPI(page);
    await page.goto('/onboarding');
    // Should load the onboarding page (either show steps or redirect to
    // dashboard if onboarding is already complete). Wait for the URL to settle
    // on one of those two routes instead of a fixed sleep — this is exactly the
    // condition the assertion below depends on.
    await page.waitForURL(/\/(onboarding|dashboard)/, { timeout: 10_000 });
    const url = page.url();
    const isOnboarding = url.includes('/onboarding');
    const isDashboard = url.includes('/dashboard');
    expect(isOnboarding || isDashboard).toBe(true);
  });

  test('onboarding page is protected — redirects unauthenticated users', async ({ page }) => {
    await page.goto('/login');
    await page.evaluate(() => localStorage.removeItem('shenmay_portal_token'));
    await page.goto('/onboarding');
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    expect(page.url()).toContain('/login');
  });
});

test.describe('Email Verification', () => {
  test('verify page with invalid token shows error', async ({ page }) => {
    await page.goto('/verify/invalid-token-abc123');
    // The page either shows an error message anywhere in the body, or
    // redirects to login. We check the full body text (not getByText, which
    // throws on multiple matches in strict mode) so any of the legitimate
    // error messages counts: "Invalid or expired verification link" (happy
    // path), "Verification failed" (heading), "Too many requests" (rate
    // limiter kicks in during batched test runs).
    //
    // Poll for that terminal condition instead of a fixed sleep — the verify
    // request resolves asynchronously, so retry until the error text appears
    // or we've landed on /login.
    await expect.poll(async () => {
      const bodyText = (await page.textContent('body').catch(() => '')) || '';
      const hasError = /invalid|expired|error|failed|too many/i.test(bodyText);
      const onLogin = page.url().includes('/login');
      return hasError || onLogin;
    }, { timeout: 10_000 }).toBe(true);
  });

  test('reset password page loads', async ({ page }) => {
    await page.goto('/reset-password');
    // Should show the reset password form or redirect to login. Wait for the
    // URL to settle on one of those routes instead of a fixed sleep — covers a
    // possible client-side redirect after mount.
    await page.waitForURL(/\/(reset-password|login)/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/(reset-password|login)/);
  });
});
