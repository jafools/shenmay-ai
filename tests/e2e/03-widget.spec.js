// @ts-check
const { test, expect } = require('@playwright/test');
const { API_BASE, SEL_WIDGET } = require('./helpers/constants');
const { loginViaAPI, getWidgetKey } = require('./helpers/auth');
const { hasDbAccess } = require('./helpers/mode');
const db = require('./helpers/db');

/**
 * Widget E2E tests
 *
 * These tests create a standalone HTML page that embeds the Shenmay widget
 * via embed.js, simulating a real customer-facing site. They verify:
 *   - Widget launcher renders
 *   - Click to open/close the chat panel
 *   - iframe loads and creates a session
 *   - Sending a message and receiving a response
 *   - Anonymous vs. authenticated widget modes
 *   - SPA auth handoff via postMessage
 */

let widgetKey = '';

test.beforeAll(async ({ browser }) => {
  // Get widget key from env or via API
  widgetKey = process.env.TEST_WIDGET_KEY || '';
  if (!widgetKey) {
    const page = await browser.newPage();
    await loginViaAPI(page);
    widgetKey = await getWidgetKey(page);
    await page.close();
  }
  if (!widgetKey) throw new Error('No widget key — set TEST_WIDGET_KEY or ensure TEST_ADMIN credentials return a tenant with widget_key');
});

/**
 * Create a minimal host page with the widget embed script injected.
 */
function hostPageHTML(opts = {}) {
  const email = opts.email || '';
  const name = opts.name || '';
  return `<!DOCTYPE html>
<html><head><title>Test Host Page</title></head>
<body>
  <h1>Host Page</h1>
  <p>This simulates a customer's website with the Shenmay widget embedded.</p>
  <script
    src="${API_BASE}/embed.js"
    data-widget-key="${widgetKey}"
    ${email ? `data-user-email="${email}"` : ''}
    ${name ? `data-user-name="${name}"` : ''}
  ></script>
</body></html>`;
}

test.describe('Widget — Embed & Launcher', () => {
  test('launcher bubble renders on host page', async ({ page }) => {
    await page.setContent(hostPageHTML());
    // Wait for embed.js to inject the launcher
    const launcher = page.locator(SEL_WIDGET.launcher);
    await expect(launcher).toBeVisible({ timeout: 10_000 });
    await expect(launcher).toContainText('Chat');
  });

  test('clicking launcher opens the chat panel', async ({ page }) => {
    await page.setContent(hostPageHTML());
    await page.locator(SEL_WIDGET.launcher).click();
    const wrap = page.locator(SEL_WIDGET.iframeWrap);
    await expect(wrap).toHaveClass(/open/, { timeout: 5_000 });
  });

  test('clicking launcher again closes the chat panel', async ({ page }) => {
    await page.setContent(hostPageHTML());
    const launcher = page.locator(SEL_WIDGET.launcher);
    // Open
    await launcher.click();
    await expect(page.locator(SEL_WIDGET.iframeWrap)).toHaveClass(/open/);
    // Close
    await launcher.click();
    await expect(page.locator(SEL_WIDGET.iframeWrap)).not.toHaveClass(/open/);
  });

  test('iframe loads widget.html with correct params', async ({ page }) => {
    await page.setContent(hostPageHTML());
    const iframe = page.locator(SEL_WIDGET.iframe);
    await expect(iframe).toBeAttached({ timeout: 10_000 });
    const src = await iframe.getAttribute('src');
    expect(src).toContain('/widget.html');
    expect(src).toContain(`key=${widgetKey}`);
  });

  test('embed script is idempotent — no duplicate launcher', async ({ page }) => {
    // Inject embed.js twice
    const html = `<!DOCTYPE html><html><head></head><body>
      <script src="${API_BASE}/embed.js" data-widget-key="${widgetKey}"></script>
      <script src="${API_BASE}/embed.js" data-widget-key="${widgetKey}"></script>
    </body></html>`;
    await page.setContent(html);
    // Wait for the launcher to be injected (deterministic signal that both
    // embed.js executions have run) instead of a fixed sleep, then assert
    // the guard collapsed the two injections into exactly one launcher.
    await expect(page.locator(SEL_WIDGET.launcher).first()).toBeVisible({ timeout: 10_000 });
    const launchers = await page.locator(SEL_WIDGET.launcher).count();
    expect(launchers).toBe(1);
  });
});

test.describe('Widget — Anonymous Session', () => {
  test('anonymous widget creates session and shows agent greeting', async ({ page }) => {
    await page.setContent(hostPageHTML());
    await page.locator(SEL_WIDGET.launcher).click();
    await expect(page.locator(SEL_WIDGET.iframeWrap)).toHaveClass(/open/);

    // Switch into the iframe context to check session creation
    const iframe = page.frameLocator(SEL_WIDGET.iframe);
    // The widget should show a loading screen then transition to chat
    // Wait for the chat wrapper or messages container to appear
    await expect(iframe.locator('#chat-wrapper')).toBeVisible({ timeout: 15_000 });
    // Agent name should be visible in the header
    await expect(iframe.locator(SEL_WIDGET.agentName)).toBeVisible();
  });

  test('can send a message in anonymous mode', async ({ page }) => {
    await page.setContent(hostPageHTML());
    await page.locator(SEL_WIDGET.launcher).click();

    const iframe = page.frameLocator(SEL_WIDGET.iframe);
    await expect(iframe.locator('#chat-wrapper')).toBeVisible({ timeout: 15_000 });

    // Type a message
    await iframe.locator(SEL_WIDGET.chatInput).fill('Hello, this is a test message');
    await iframe.locator(SEL_WIDGET.sendBtn).click();

    // User message should appear in the messages area
    await expect(iframe.locator('.msg.user').first()).toBeVisible({ timeout: 5_000 });

    // Typing indicator should show while waiting for response
    // (may be brief, so we just check the response arrives)
    await expect(iframe.locator('.msg.agent').first()).toBeVisible({ timeout: 30_000 });
  });
});

/**
 * Helper: new authenticated users see an agent-name or customer-name intro screen
 * before the chat wrapper. Fill and submit whichever screen appears, then wait
 * for #chat-wrapper to become visible.
 */
async function completeIntroScreens(iframe) {
  // Agent name screen (first-ever login for this customer)
  const agentNameScreen = iframe.locator('#agent-name-screen.visible');
  const chatWrapper = iframe.locator('#chat-wrapper');

  // Wait briefly for either the intro screen or the chat wrapper to appear
  await Promise.race([
    agentNameScreen.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {}),
    chatWrapper.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {}),
  ]);

  if (await agentNameScreen.isVisible().catch(() => false)) {
    await iframe.locator('#agent-name-input').fill('Aria');
    await expect(iframe.locator('#agent-name-submit-btn')).toBeEnabled({ timeout: 3_000 });
    await iframe.locator('#agent-name-submit-btn').click();
  }

  // Customer name screen (agent already named but no customer name on file)
  const nameScreen = iframe.locator('#name-screen.visible');
  if (await nameScreen.isVisible().catch(() => false)) {
    await iframe.locator('#name-input').fill('E2E Tester');
    await expect(iframe.locator('#name-submit-btn')).toBeEnabled({ timeout: 3_000 });
    await iframe.locator('#name-submit-btn').click();
  }
}

test.describe('Widget — Authenticated Session', () => {
  test('authenticated widget shows personalized greeting', async ({ page }) => {
    await page.setContent(hostPageHTML({
      email: 'e2e-test@example.com',
      name: 'E2E Tester',
    }));
    await page.locator(SEL_WIDGET.launcher).click();

    const iframe = page.frameLocator(SEL_WIDGET.iframe);
    // New customers may see agent-name / customer-name intro screens first
    await completeIntroScreens(iframe);
    await expect(iframe.locator('#chat-wrapper')).toBeVisible({ timeout: 15_000 });
    // Agent name in header should be visible
    await expect(iframe.locator(SEL_WIDGET.agentName)).toBeVisible();
  });

  test('SPA auth handoff via postMessage updates widget session', async ({ page }) => {
    // Per-run email so concurrent/repeat runs don't collide on DB assertions
    // and so the cleanup in afterAll can target only this run's rows.
    const testEmail = `spa-test-${Date.now()}@example.com`;

    // Start as anonymous
    await page.setContent(hostPageHTML());
    await page.locator(SEL_WIDGET.launcher).click();

    const iframe = page.frameLocator(SEL_WIDGET.iframe);
    await expect(iframe.locator('#chat-wrapper')).toBeVisible({ timeout: 15_000 });

    // Simulate SPA login — postMessage to identify user. The embed forwards a
    // shenmay:identify into the iframe, which fires POST /session/claim. Wait
    // on that actual request (the real signal the handoff happened) instead of
    // a fixed sleep — arm the wait BEFORE posting so we don't miss it.
    const claimResponse = page.waitForResponse(
      (resp) => resp.url().includes('/api/widget/session/claim'),
      { timeout: 15_000 }
    );
    await page.evaluate((email) => {
      window.postMessage(
        { type: 'shenmay:setUser', email, name: 'SPA User' },
        '*'
      );
    }, testEmail);
    await claimResponse;

    // Widget should still be functional
    await expect(iframe.locator('#chat-wrapper')).toBeVisible();

    // ── DB-backed verification ─────────────────────────────────
    // UI-only assertions above can't catch a silent backend failure
    // (widget.js POST /session/claim threw once on `conversations.updated_at`
    // not existing; the UI kept rendering the anon session). Prove the
    // claim actually ran: there must be at least one conversation owned
    // by the customer row with this test email — meaning the UPDATE
    // conversations SET customer_id succeeded.
    if (hasDbAccess()) {
      const rows = await db.query(
        `SELECT c.id
           FROM conversations c
           JOIN customers cu ON cu.id = c.customer_id
          WHERE cu.email = $1
          ORDER BY c.created_at DESC
          LIMIT 1`,
        [testEmail]
      );
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  test('SPA logout reloads widget to anonymous mode', async ({ page }) => {
    // Start authenticated
    await page.setContent(hostPageHTML({
      email: 'e2e-logout@example.com',
      name: 'Logout Tester',
    }));
    await page.locator(SEL_WIDGET.launcher).click();
    const iframe = page.frameLocator(SEL_WIDGET.iframe);
    // New customers may see intro screens before reaching chat
    await completeIntroScreens(iframe);
    // The real assertion of this test is the post-logout launcher presence
    // (below). The pre-check here is just "widget loaded SOMETHING".
    //
    // Customer-limit-reached flips `#capacity-screen` to display:flex. The
    // element is always in the DOM, so a naive text-regex count() match was
    // returning true on every run and skipping the test unconditionally.
    // isVisible() on the id is visibility-aware and matches the actual
    // trigger condition.
    const inCapacity = await iframe.locator('#capacity-screen').isVisible().catch(() => false);
    test.skip(inCapacity, 'Customer seat limit reached — post-logout flow not testable in capacity mode.');

    const chatReady    = iframe.locator('#chat-wrapper');
    const agentScreen  = iframe.locator('#agent-name-screen.visible');
    const nameScreen   = iframe.locator('#name-screen.visible');
    const widgetReady  = chatReady.or(agentScreen).or(nameScreen);
    await expect(widgetReady.first()).toBeVisible({ timeout: 15_000 });

    // Simulate logout. On logout the embed does a full iframe reload
    // (iframe.src = buildWidgetUrl()), which re-navigates the widget frame.
    // Wait on that navigation (the real "reload" signal) instead of a fixed
    // sleep — arm the wait BEFORE posting so we don't miss the event.
    const frameReloaded = page.waitForEvent('framenavigated', {
      predicate: (frame) => frame.url().includes('/widget.html'),
      timeout: 15_000,
    });
    await page.evaluate(() => {
      window.postMessage({ type: 'shenmay:setUser', email: '', name: '' }, '*');
    });
    await frameReloaded;
    // After reload, launcher should still be present
    await expect(page.locator(SEL_WIDGET.launcher)).toBeVisible();
  });
});

test.describe('Widget — Close Button', () => {
  test('close button inside iframe closes the panel', async ({ page }) => {
    await page.setContent(hostPageHTML());
    await page.locator(SEL_WIDGET.launcher).click();
    await expect(page.locator(SEL_WIDGET.iframeWrap)).toHaveClass(/open/);

    const iframe = page.frameLocator(SEL_WIDGET.iframe);

    // If the tenant hits its customer seat limit the iframe shows the
    // "at capacity" UI which has no close button — the close-flow we're
    // exercising here simply isn't reachable. That's correct product
    // behaviour, not a regression; skip rather than fail. Checking the
    // id's visibility (not a text regex) avoids the always-in-DOM trap.
    //
    // Wait for the widget to settle on one of its two terminal screens
    // (chat-ready or at-capacity) instead of a fixed sleep, then branch.
    await Promise.race([
      iframe.locator('#chat-wrapper').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {}),
      iframe.locator('#capacity-screen').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {}),
    ]);
    const atCapacity = await iframe.locator('#capacity-screen').isVisible().catch(() => false);
    test.skip(atCapacity, 'Customer seat limit reached — close-button flow unavailable in capacity mode.');

    await expect(iframe.locator('#chat-wrapper')).toBeVisible({ timeout: 15_000 });

    // Click close button inside the iframe
    await iframe.locator(SEL_WIDGET.closeBtn).click();

    // Panel should close — the iframe posts shenmay:close back to parent
    await expect(page.locator(SEL_WIDGET.iframeWrap)).not.toHaveClass(/open/, { timeout: 5_000 });
  });
});

test.describe('Widget — Concern/Flag', () => {
  test('concern button is present in widget', async ({ page }) => {
    await page.setContent(hostPageHTML());
    await page.locator(SEL_WIDGET.launcher).click();

    const iframe = page.frameLocator(SEL_WIDGET.iframe);
    await expect(iframe.locator('#chat-wrapper')).toBeVisible({ timeout: 15_000 });

    // The concern/flag button should exist in the input bar area
    await expect(iframe.locator('#concern-btn')).toBeAttached();
  });
});

test.describe('Widget — Session refresh', () => {
  // Verifies the JWT auto-renew endpoint that backstops sendMessage and
  // pollForMessages when a tab sits idle past the 24h JWT TTL. We can't
  // realistically wait 24h in a test, so we exercise the endpoint directly:
  // a still-valid token should refresh successfully; a missing token or a
  // mismatched widget_key should both 401.

  async function createSession(page) {
    const resp = await page.request.post(`${API_BASE}/api/widget/session`, {
      data: { widget_key: widgetKey },
    });
    expect(resp.ok(), `session create failed (${resp.status()})`).toBeTruthy();
    return (await resp.json()).token;
  }

  test('refresh endpoint returns a fresh token for a valid session', async ({ page }) => {
    const original = await createSession(page);
    const resp = await page.request.post(`${API_BASE}/api/widget/session/refresh`, {
      headers: { Authorization: `Bearer ${original}` },
      data: { widget_key: widgetKey },
    });
    expect(resp.status(), `refresh expected 200, got ${resp.status()}`).toBe(200);
    const body = await resp.json();
    expect(body.token, 'refresh response should include a token').toBeTruthy();
    // Same secret, same payload, same iat second → could be the same string;
    // assert it's at least a valid-looking JWT.
    expect(body.token.split('.').length).toBe(3);
  });

  test('refresh rejects a request with no Authorization header', async ({ page }) => {
    const resp = await page.request.post(`${API_BASE}/api/widget/session/refresh`, {
      data: { widget_key: widgetKey },
    });
    expect(resp.status()).toBe(401);
  });

  test('refresh rejects a mismatched widget_key', async ({ page }) => {
    const original = await createSession(page);
    const resp = await page.request.post(`${API_BASE}/api/widget/session/refresh`, {
      headers: { Authorization: `Bearer ${original}` },
      data: { widget_key: 'definitely-not-a-real-widget-key' },
    });
    expect(resp.status()).toBe(401);
  });
});
