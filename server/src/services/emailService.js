/**
 * SHENMAY AI — Email Service
 *
 * Sends transactional emails via One.com SMTP (nodemailer).
 *
 * Required env vars:
 *   SMTP_HOST     — e.g. send.one.com
 *   SMTP_PORT     — 587 (STARTTLS, required on Hetzner — 465 is firewalled)
 *   SMTP_SECURE   — "false" for STARTTLS on 587, "true" for implicit SSL on 465
 *   SMTP_USER     — sending mailbox username
 *   SMTP_PASS     — sending mailbox password
 *   SMTP_FROM     — From address, e.g. "Shenmay AI <hello@pontensolutions.com>"
 *   APP_URL       — Base URL for links, e.g. https://shenmay.ai
 *
 * All templates use a shared Direction B brand shell — see BRAND tokens
 * + renderEmail() below. Source of truth for colors / typography lives in
 * client/src/styles/shenmay-tokens.css; values are mirrored here for the
 * email pipeline (which can't load CSS variables).
 */

const nodemailer = require('nodemailer');
const { PLAN_LIMITS } = require('../config/plans');

// Singleton transporter — reuses SMTP connections instead of opening a
// new TCP/TLS handshake per email. Lazily created on first use.
let _transporter = null;

// Check the Resend-webhook-populated deny-list before every send. Lazy
// db require to keep the module importable in contexts (CLI seed scripts,
// tests) where the DB pool may not be initialised.
async function isSuppressed(email) {
  if (!email || typeof email !== 'string') return false;
  try {
    const db = require('../db');
    const { rows } = await db.query(
      'SELECT 1 FROM email_suppressions WHERE email = LOWER($1) LIMIT 1',
      [email],
    );
    return rows.length > 0;
  } catch (err) {
    // If the suppression table doesn't exist yet (pre-migration-037 env)
    // or the DB is down, fail open — a missed suppression is better than
    // blocking all outbound mail.
    return false;
  }
}

// Wrap `transporter.sendMail` so every send checks the suppression list
// first. Applied once on creation so call sites don't need to change.
function wrapSendMail(transporter) {
  const orig = transporter.sendMail.bind(transporter);
  transporter.sendMail = async function (opts) {
    if (opts && typeof opts.to === 'string' && await isSuppressed(opts.to)) {
      console.log(`[Email] skipping send — ${opts.to} is on the suppression list`);
      return { skipped: true, reason: 'suppressed', envelope: { to: [opts.to] } };
    }
    return orig(opts);
  };
  return transporter;
}

function getTransporter() {
  if (!_transporter) {
    // No SMTP creds → jsonTransport no-op. Keeps CI + local dev from
    // hitting a real provider for code paths that fire-and-forget mail
    // (stripe webhook, password reset, etc.) and avoids noisy 550 auth
    // warnings when the key simply isn't provisioned in the environment.
    // Real sends in prod still require SMTP_USER + SMTP_PASS.
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.log('[Email] SMTP_USER/SMTP_PASS not set — using jsonTransport (no real sends)');
      _transporter = wrapSendMail(nodemailer.createTransport({ jsonTransport: true }));
      return _transporter;
    }
    _transporter = wrapSendMail(nodemailer.createTransport({
      host:   process.env.SMTP_HOST   || 'send.one.com',
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true', // false by default (STARTTLS on 587)
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      pool: true,           // enable connection pooling
      maxConnections: 3,    // max simultaneous connections
      maxMessages: 50,      // messages per connection before reconnecting
    }));
  }
  return _transporter;
}

function createTransporter() {
  return getTransporter();
}

const FROM = process.env.SMTP_FROM || 'Shenmay AI <hello@pontensolutions.com>';
const APP_URL = (process.env.APP_URL || 'https://shenmay.ai').replace(/\/$/, '');
const SMTP_USER = process.env.SMTP_USER;
// Derive the public domain from APP_URL for use in email footers
const APP_DOMAIN = APP_URL.replace(/^https?:\/\//, '').split('/')[0];
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || `support@${APP_DOMAIN}`;
const CONTACT_URL = process.env.CONTACT_URL || `${APP_URL}/contact`;

// Build tenant-customized From / Reply-To / footer for outgoing emails
function tenantFrom(tenantEmail) {
  if (!tenantEmail || !tenantEmail.email_from_name) return FROM;
  // Keep the actual sending address the same (SMTP requirement) but change display name
  const smtpAddr = SMTP_USER || FROM.match(/<(.+)>/)?.[1] || `noreply@${APP_DOMAIN}`;
  return `${tenantEmail.email_from_name} <${smtpAddr}>`;
}
function tenantReplyTo(tenantEmail) {
  return (tenantEmail && tenantEmail.email_reply_to) || undefined;
}
function tenantFooterHtml(tenantEmail) {
  if (!tenantEmail || !tenantEmail.email_footer) return `Shenmay AI · ${APP_DOMAIN}`;
  // Escape HTML entities for safety
  const safe = tenantEmail.email_footer.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return safe;
}
function tenantFooterText(tenantEmail) {
  if (!tenantEmail || !tenantEmail.email_footer) return `Shenmay AI · ${APP_DOMAIN}`;
  return tenantEmail.email_footer;
}


// ╔══════════════════════════════════════════════════════════════════════╗
// ║  Direction B brand chrome — shared across all email templates        ║
// ║  Mirrors client/src/styles/shenmay-tokens.css                        ║
// ╚══════════════════════════════════════════════════════════════════════╝

const BRAND = {
  ink:       '#1A1D1A',   // primary text
  inkSoft:   '#3A3D39',   // body text
  paper:     '#F5F1E8',   // warm off-white background
  paperDeep: '#EDE7D7',   // card / footer / inset bg
  paperEdge: '#D8D0BD',   // hairline borders
  mute:      '#6B6B64',   // labels, muted text
  teal:      '#0F5F5C',   // accent, CTA, kickers
  tealDark:  '#083A38',   // emphasis
  success:   '#2D6A4F',   // confirmation states
  danger:    '#7A1F1A',   // error states (warm, not loud)

  // Email clients can't load Inter via @font-face reliably (Gmail, Outlook
  // strip web fonts). System fallbacks render Inter on macOS/Win where it's
  // already installed; otherwise gracefully degrade to the platform sans.
  fontSans: "'Inter','Helvetica Neue',Helvetica,Arial,sans-serif",
  fontMono: "ui-monospace,'SF Mono',Menlo,Consolas,monospace",
};

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function wordmarkInline() {
  return `<span style="font-family:${BRAND.fontSans};font-size:20px;font-weight:600;letter-spacing:-0.025em;color:${BRAND.ink};">Shenmay<span style="color:${BRAND.teal};margin-left:3px;font-weight:700;">·</span></span>`;
}

function ctaButton({ label, href, variant = 'primary' }) {
  const bg = variant === 'primary' ? BRAND.teal : 'transparent';
  const fg = variant === 'primary' ? BRAND.paper : BRAND.ink;
  const border = variant === 'primary' ? BRAND.teal : BRAND.paperEdge;
  return `
    <table cellspacing="0" cellpadding="0" border="0" role="presentation" style="margin:0 6px 8px;display:inline-table;">
      <tr><td style="background:${bg};border:1px solid ${border};border-radius:6px;">
        <a href="${esc(href)}" style="display:inline-block;padding:13px 28px;font-family:${BRAND.fontSans};font-weight:500;font-size:14px;color:${fg};text-decoration:none;letter-spacing:-0.005em;">
          ${esc(label)}
        </a>
      </td></tr>
    </table>`;
}

function kickerLabel(text) {
  return `<div style="font-family:${BRAND.fontMono};font-size:11px;font-weight:400;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.teal};margin:0 0 14px;">${esc(text)}</div>`;
}

function paragraph(html, opts = {}) {
  const color = opts.color || BRAND.inkSoft;
  return `<p style="font-family:${BRAND.fontSans};font-size:15px;line-height:1.65;color:${color};margin:0 0 14px;">${html}</p>`;
}

function smallPrintHtml(html) {
  return `<p style="font-family:${BRAND.fontSans};font-size:13px;line-height:1.6;color:${BRAND.mute};margin:0;">${html}</p>`;
}

function preheaderHidden(text) {
  // Hidden preview text (shows in inbox preview row; invisible in body)
  return `<div style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;font-size:1px;line-height:1px;mso-hide:all;overflow:hidden;">${esc(text)}</div>`;
}

function licenseKeyBlock(key) {
  return `<div style="background:${BRAND.paperDeep};border:1px solid ${BRAND.paperEdge};border-radius:8px;padding:18px 20px;margin:0 0 18px;text-align:center;">
    <div style="font-family:${BRAND.fontMono};font-size:11px;font-weight:400;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.mute};margin:0 0 10px;">License key</div>
    <code style="font-family:${BRAND.fontMono};font-size:16px;letter-spacing:0.04em;color:${BRAND.ink};font-weight:600;word-break:break-all;">${esc(key)}</code>
  </div>`;
}

function metaTable(rows) {
  // rows: [{ label, value (HTML allowed) }]
  const trs = rows.map((r, i) => {
    const isLast = i === rows.length - 1;
    const border = isLast ? '' : `border-bottom:1px solid ${BRAND.paperEdge};`;
    return `<tr style="${border}">
      <td style="padding:10px 0;color:${BRAND.mute};font-size:13px;width:110px;font-family:${BRAND.fontSans};vertical-align:top;">${esc(r.label)}</td>
      <td style="padding:10px 0;color:${BRAND.ink};font-size:14px;line-height:1.6;font-family:${BRAND.fontSans};">${r.value}</td>
    </tr>`;
  }).join('');
  return `<table cellspacing="0" cellpadding="0" border="0" role="presentation" style="width:100%;margin:0 0 22px;">${trs}</table>`;
}

function noticeBanner({ title, items = [], body, tone = 'warning' }) {
  const palette = {
    warning: { bg: '#FBF4DD', border: '#E8D689', text: '#6B5500' },
    danger:  { bg: '#F7E1DD', border: '#D9B0AB', text: BRAND.danger },
    success: { bg: '#E1EEE6', border: '#A6CBB3', text: BRAND.success },
  };
  const c = palette[tone] || palette.warning;
  const itemsHtml = items.length
    ? `<ul style="margin:6px 0 0;padding-left:18px;color:${c.text};font-size:13px;line-height:1.7;font-family:${BRAND.fontSans};">${items.map(i => `<li style="margin-bottom:3px;">${esc(i)}</li>`).join('')}</ul>`
    : '';
  const bodyHtml = body ? `<div style="font-family:${BRAND.fontSans};font-size:13px;color:${c.text};line-height:1.55;margin-top:4px;">${body}</div>` : '';
  return `<div style="background:${c.bg};border:1px solid ${c.border};border-radius:6px;padding:14px 18px;margin:0 0 24px;">
    ${title ? `<div style="font-family:${BRAND.fontSans};font-size:13px;font-weight:600;color:${c.text};margin:0;">${esc(title)}</div>` : ''}
    ${itemsHtml}
    ${bodyHtml}
  </div>`;
}

function quoteBlock(text) {
  return `<div style="background:${BRAND.paperDeep};border-left:3px solid ${BRAND.teal};padding:12px 16px;margin:0 0 18px;border-radius:0 6px 6px 0;">
    <p style="margin:0;font-family:${BRAND.fontSans};font-size:14px;color:${BRAND.inkSoft};font-style:italic;line-height:1.55;">${esc(text)}</p>
  </div>`;
}

/**
 * Render a complete branded email.
 *
 * @param {Object} opts
 * @param {string} [opts.preheader]      — preview-line text shown by mail clients (~80 chars)
 * @param {string} [opts.kicker]         — uppercase mono label above headline (e.g. "Sign in")
 * @param {string}  opts.headline        — h1 (may contain HTML, no escape applied)
 * @param {string}  opts.bodyHtml        — main body HTML
 * @param {Object} [opts.cta]            — primary CTA: { label, href }
 * @param {Object} [opts.ctaSecondary]   — secondary CTA: { label, href }
 * @param {string} [opts.smallPrintHtml] — muted small text placed after CTAs
 * @param {string} [opts.footerHtml]     — defaults to "Shenmay AI · {APP_DOMAIN}" wordmark
 *                                         (pass tenantFooterHtml() output for tenant-themed mail)
 */
function renderEmail({
  preheader,
  kicker,
  headline,
  bodyHtml,
  cta,
  ctaSecondary,
  smallPrintHtml: smallText,
  footerHtml,
}) {
  const ctaBlock = cta ? ctaButton(cta) : '';
  const ctaSecondaryBlock = ctaSecondary ? ctaButton({ ...ctaSecondary, variant: 'secondary' }) : '';
  const smallBlock = smallText
    ? `<div style="margin-top:18px;text-align:center;">${smallPrintHtml(smallText)}</div>`
    : '';
  const footer = footerHtml ?? `Shenmay AI · ${APP_DOMAIN}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>Shenmay AI</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.paper};font-family:${BRAND.fontSans};color:${BRAND.ink};-webkit-font-smoothing:antialiased;">
  ${preheader ? preheaderHidden(preheader) : ''}
  <table cellspacing="0" cellpadding="0" border="0" role="presentation" width="100%" style="background:${BRAND.paper};padding:48px 16px;">
    <tr><td align="center">
      <table cellspacing="0" cellpadding="0" border="0" role="presentation" width="560" style="max-width:560px;background:#FFFFFF;border:1px solid ${BRAND.paperEdge};border-radius:12px;overflow:hidden;">
        <!-- Header -->
        <tr><td style="padding:26px 40px;border-bottom:1px solid ${BRAND.paperEdge};background:#FFFFFF;">
          ${wordmarkInline()}
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:36px 40px 32px;background:#FFFFFF;">
          ${kicker ? kickerLabel(kicker) : ''}
          <h1 style="font-family:${BRAND.fontSans};font-weight:500;font-size:24px;line-height:1.2;letter-spacing:-0.025em;color:${BRAND.ink};margin:0 0 18px;">${headline}</h1>
          ${bodyHtml}
          ${cta || ctaSecondary ? `<div style="margin:28px 0 6px;text-align:center;">
            ${ctaBlock}${ctaSecondaryBlock}
          </div>` : ''}
          ${smallBlock}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:18px 40px;background:${BRAND.paperDeep};border-top:1px solid ${BRAND.paperEdge};text-align:center;">
          <div style="font-family:${BRAND.fontMono};font-size:11px;font-weight:400;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.mute};">${footer}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}


// ╔══════════════════════════════════════════════════════════════════════╗
// ║  Templates                                                           ║
// ╚══════════════════════════════════════════════════════════════════════╝


// ── Send verification email ────────────────────────────────────────────────

async function sendVerificationEmail({ to, token, firstName }) {
  const verifyUrl = `${APP_URL}/verify-email?token=${token}`;
  const name = firstName || 'there';

  const html = renderEmail({
    preheader: `Confirm your email address to finish setting up Shenmay AI.`,
    kicker: 'Confirm email',
    headline: 'Confirm your email address',
    bodyHtml:
      paragraph(`Hi ${esc(name)}, thanks for signing up for Shenmay AI. Click the button below to verify your email and get started.`),
    cta: { label: 'Verify email address', href: verifyUrl },
    smallPrintHtml: `This link expires in 24 hours. If you didn't sign up for Shenmay AI, you can safely ignore this email.`,
  });

  const text = `Hi ${name},\n\nThanks for signing up for Shenmay AI.\n\nVerify your email address by visiting:\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nShenmay AI`;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[Email] SMTP not configured — verification link for ${to}:`);
    console.log(`[Email] ${verifyUrl}`);
    return;
  }

  const transporter = createTransporter();
  await transporter.sendMail({
    from:    FROM,
    to,
    subject: 'Verify your Shenmay AI account',
    text,
    html,
  });

  console.log(`[Email] Verification email sent to ${to}`);
}


// ── Send welcome email (after verification) ────────────────────────────────

async function sendWelcomeEmail({ to, firstName, companyName }) {
  const dashboardUrl = `${APP_URL}/onboarding`;
  const name = firstName || 'there';

  const html = renderEmail({
    preheader: `Your Shenmay AI workspace for ${companyName} is ready.`,
    kicker: 'Welcome',
    headline: `Welcome to Shenmay AI, ${esc(name)}.`,
    bodyHtml:
      paragraph(`Your account for <strong style="color:${BRAND.ink};font-weight:600;">${esc(companyName)}</strong> is ready. Let's get your AI agent set up — it only takes a few minutes.`),
    cta: { label: 'Set up my agent', href: dashboardUrl },
  });

  const text = `Hi ${name},\n\nWelcome to Shenmay AI! Your account for ${companyName} is ready.\n\nSet up your agent: ${dashboardUrl}\n\nShenmay AI`;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[Email] Welcome email would be sent to ${to} (SMTP not configured)`);
    return;
  }

  const transporter = createTransporter();
  await transporter.sendMail({
    from:    FROM,
    to,
    subject: `Welcome to Shenmay AI — let's set up ${companyName}`,
    text,
    html,
  });

  console.log(`[Email] Welcome email sent to ${to}`);
}


// ── Send password-reset email ───────────────────────────────────────────────

async function sendPasswordResetEmail({ to, token, firstName }) {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;
  const name = firstName || 'there';

  const html = renderEmail({
    preheader: `Reset your Shenmay AI password. Link expires in 1 hour.`,
    kicker: 'Reset password',
    headline: 'Reset your password',
    bodyHtml:
      paragraph(`Hi ${esc(name)}, we received a request to reset your password. Click the button below to choose a new one.`),
    cta: { label: 'Reset password', href: resetUrl },
    smallPrintHtml: `This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email — your password will remain unchanged.`,
  });

  const text = `Hi ${name},\n\nWe received a request to reset your Shenmay AI password.\n\nReset your password:\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.\n\nShenmay AI`;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[Email] SMTP not configured — password reset link for ${to}:`);
    console.log(`[Email] ${resetUrl}`);
    return;
  }

  const transporter = createTransporter();
  await transporter.sendMail({
    from:    FROM,
    to,
    subject: 'Reset your Shenmay AI password',
    text,
    html,
  });

  console.log(`[Email] Password reset email sent to ${to}`);
}


// ── Send trial limit reached email ─────────────────────────────────────────

async function sendTrialLimitEmail({ to, firstName, tenantName, plan }) {
  const pricingUrl = `${APP_URL}/dashboard/plans`;
  const contactUrl = CONTACT_URL;
  const name = firstName || 'there';
  const company = tenantName || 'your account';

  // Reflect the tenant's ACTUAL plan limits instead of a hardcoded "1/20"
  // (that only matched the legacy pre-v3.4.2 free tier — a 'trial' plan is
  // 3 customers / 50 messages). Fall back to the free limits if plan is unknown.
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  const customerLabel = `${limits.max_customers} customer${limits.max_customers === 1 ? '' : 's'}`;

  const bodyHtml =
    paragraph(`Hi ${esc(name)}, your Shenmay AI trial for <strong style="color:${BRAND.ink};font-weight:600;">${esc(company)}</strong> has used up all of its included messages or customers. Your AI agents are currently paused until you upgrade to a paid plan.`) +
    noticeBanner({
      title: 'Trial plan limits',
      items: [customerLabel, `${limits.max_messages_month} AI messages per month`],
      tone: 'warning',
    }) +
    paragraph(`Upgrade now to restore your agents instantly and unlock more customers, more messages, and full AI capabilities for your business.`);

  const html = renderEmail({
    preheader: `Your Shenmay AI trial for ${company} has reached its limit.`,
    kicker: 'Trial limit',
    headline: 'Your trial has reached its limit',
    bodyHtml,
    cta: { label: 'View pricing plans', href: pricingUrl },
    ctaSecondary: { label: 'Talk to sales', href: contactUrl },
  });

  const text = `Hi ${name},\n\nYour Shenmay AI trial for ${company} has reached its limit (${customerLabel}, ${limits.max_messages_month} messages).\n\nYour AI agents are paused until you upgrade.\n\nView pricing: ${pricingUrl}\nTalk to sales: ${contactUrl}\n\nShenmay AI`;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[Email] SMTP not configured — trial limit email would be sent to ${to}`);
    return;
  }

  const transporter = createTransporter();
  await transporter.sendMail({
    from:    FROM,
    to,
    subject: 'Your Shenmay AI trial has reached its limit — upgrade to continue',
    text,
    html,
  });

  console.log(`[Email] Trial limit email sent to ${to}`);
}


// ── Send concern raised notification email ─────────────────────────────────

async function sendConcernEmail({ to, firstName, customerName, customerEmail, description, conversationId, tenantEmail }) {
  const concernUrl = `${APP_URL}/dashboard/concerns`;
  const name = firstName || 'there';

  const bodyHtml =
    noticeBanner({
      title: `New concern raised by ${customerName || 'a customer'}`,
      body: `Hi ${esc(name)} — a customer has flagged that they need human support. Details below.`,
      tone: 'warning',
    }) +
    metaTable([
      { label: 'Customer', value: `<strong style="color:${BRAND.ink};font-weight:600;">${esc(customerName || 'Unknown')}</strong>` },
      { label: 'Email',    value: esc(customerEmail || '—') },
      { label: 'Message',  value: esc(description || 'Customer requested human support via chat widget.') },
    ]);

  const html = renderEmail({
    preheader: `${customerName || 'A customer'} needs human support.`,
    kicker: 'Action needed',
    headline: 'A customer needs human support',
    bodyHtml,
    cta: { label: 'View in dashboard', href: concernUrl },
    footerHtml: tenantFooterHtml(tenantEmail),
  });

  const text = `Hi ${name},\n\nA customer has raised a concern and needs human support.\n\nCustomer: ${customerName}\nEmail: ${customerEmail}\nMessage: ${description}\n\nView it in your dashboard: ${concernUrl}\n\n${tenantFooterText(tenantEmail)}`;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[Email] SMTP not configured — concern email would be sent to ${to}`);
    return;
  }

  const transporter = createTransporter();
  await transporter.sendMail({
    from:    tenantFrom(tenantEmail),
    replyTo: tenantReplyTo(tenantEmail),
    to,
    subject: `Concern raised by ${customerName || 'a customer'} — action needed`,
    text,
    html,
  });

  console.log(`[Email] Concern email sent to ${to}`);
}


// ── Send agent invite email ─────────────────────────────────────────────────

async function sendAgentInviteEmail({ to, firstName, inviterName, tenantName, inviteUrl }) {
  const name    = firstName || null;
  const invited = inviterName || 'Your team';

  const bodyHtml =
    paragraph(`${esc(invited)} has invited ${name ? `<strong style="color:${BRAND.ink};font-weight:600;">${esc(name)}</strong>` : 'you'} to join <strong style="color:${BRAND.ink};font-weight:600;">${esc(tenantName)}</strong> as a support agent on Shenmay AI — the personalized AI assistant platform.`) +
    noticeBanner({
      title: `What you'll be able to do`,
      items: [
        'Monitor and reply to customer conversations',
        'Take over chats from the AI when a human touch is needed',
        'View customer profiles and history',
      ],
      tone: 'success',
    });

  const html = renderEmail({
    preheader: `Join ${tenantName} as a support agent on Shenmay AI.`,
    kicker: 'Invitation',
    headline: `You're invited to join ${esc(tenantName)}`,
    bodyHtml,
    cta: { label: 'Accept invitation', href: inviteUrl },
    smallPrintHtml: `This invitation expires in 7&nbsp;days. If you weren't expecting this, you can safely ignore it.`,
  });

  const text = `Hi${name ? ` ${name}` : ''},\n\n${invited} has invited you to join ${tenantName} as a support agent on Shenmay AI.\n\nAccept your invitation:\n${inviteUrl}\n\nThis invitation expires in 7 days.\n\nShenmay AI`;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[Email] SMTP not configured — invite link for ${to}:`);
    console.log(`[Email] ${inviteUrl}`);
    return;
  }

  const transporter = createTransporter();
  await transporter.sendMail({
    from:    FROM,
    to,
    subject: `You've been invited to join ${tenantName} on Shenmay AI`,
    text,
    html,
  });

  console.log(`[Email] Agent invite email sent to ${to}`);
}


// ── Send document / report email ───────────────────────────────────────────
// Called by the send_document universal tool.
// Formats the agent-assembled report as a clean branded HTML email.

async function sendDocumentEmail({
  to,
  customerName,
  agentName,
  tenantName,
  subject,
  summary,
  sections,    // [{ heading, content }]
  nextSteps,   // string[] | null
  disclaimer,
}) {
  const name       = customerName || 'there';
  const sender     = agentName    || tenantName || 'Shenmay AI';
  const org        = tenantName   || 'Shenmay AI';
  const today      = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const sectionsHtml = (sections || []).map(s => `
    <div style="margin-bottom:22px;">
      <div style="font-family:${BRAND.fontMono};font-size:11px;font-weight:400;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.teal};margin:0 0 6px;">${esc(s.heading)}</div>
      <p style="margin:0;font-family:${BRAND.fontSans};font-size:14px;color:${BRAND.inkSoft};line-height:1.7;">${esc(s.content).replace(/\n/g, '<br>')}</p>
    </div>`).join('');

  const nextStepsHtml = nextSteps && nextSteps.length > 0 ? `
    <div style="background:${BRAND.paperDeep};border-left:3px solid ${BRAND.teal};border-radius:0 6px 6px 0;padding:14px 18px;margin:0 0 22px;">
      <div style="font-family:${BRAND.fontMono};font-size:11px;font-weight:400;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.teal};margin:0 0 8px;">Next steps</div>
      <ul style="margin:0;padding-left:18px;">
        ${nextSteps.map(s => `<li style="font-family:${BRAND.fontSans};font-size:14px;color:${BRAND.inkSoft};line-height:1.7;margin-bottom:4px;">${esc(s)}</li>`).join('')}
      </ul>
    </div>` : '';

  const disclaimerText = disclaimer
    || 'This document is for informational and educational purposes only. It does not constitute professional, legal, or financial advice. Please consult a qualified professional before making decisions based on this information.';

  const bodyHtml =
    `<div style="font-family:${BRAND.fontSans};font-size:13px;color:${BRAND.mute};margin:0 0 4px;">Prepared for <strong style="color:${BRAND.ink};font-weight:600;">${esc(name)}</strong></div>
     <div style="font-family:${BRAND.fontMono};font-size:11px;font-weight:400;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.mute};margin:0 0 22px;">${esc(today)} · Prepared by ${esc(sender)}</div>` +
    `<div style="background:${BRAND.paperDeep};border-radius:8px;padding:16px 20px;margin:0 0 26px;">
       <p style="margin:0;font-family:${BRAND.fontSans};font-size:15px;color:${BRAND.ink};line-height:1.7;">${esc(summary)}</p>
     </div>` +
    sectionsHtml +
    nextStepsHtml +
    `<div style="border-top:1px solid ${BRAND.paperEdge};margin:18px 0 0;padding-top:14px;">
       <p style="font-family:${BRAND.fontSans};font-size:11px;color:${BRAND.mute};line-height:1.6;margin:0;">${esc(disclaimerText)}</p>
     </div>`;

  const html = renderEmail({
    preheader: esc(summary).slice(0, 90),
    kicker: esc(org),
    headline: esc(subject),
    bodyHtml,
    footerHtml: `Sent by ${esc(sender)} via Shenmay AI · ${APP_DOMAIN}`,
  });

  const text = `${subject}\n\nPrepared for: ${name}\nDate: ${today}\n\n${summary}\n\n${
    (sections || []).map(s => `${s.heading}\n${s.content}`).join('\n\n')
  }\n\n${nextSteps?.length ? 'Next Steps:\n' + nextSteps.map(s => `• ${s}`).join('\n') : ''}\n\n${disclaimerText}`;

  const transporter = createTransporter();
  await transporter.sendMail({ from: FROM, to, subject, text, html });

  console.log(`[Email] Document sent to ${to}: "${subject}"`);
}


// ── Send human-mode reply notification (customer replied while agent has taken over) ──

async function sendHumanModeReplyEmail({ to, agentName, customerName, customerEmail, messageSnippet, conversationId, tenantEmail }) {
  const name    = agentName   || 'Agent';
  const cust    = customerName || 'A customer';
  const dashUrl = `${APP_URL}/dashboard/conversations/${conversationId}`;

  const snippetText = messageSnippet ? messageSnippet.slice(0, 200) + (messageSnippet.length > 200 ? '…' : '') : null;

  const bodyHtml =
    paragraph(`Hi ${esc(name)}, <strong style="color:${BRAND.ink};font-weight:600;">${esc(cust)}</strong>${customerEmail ? ` (${esc(customerEmail)})` : ''} sent a message in the conversation you've taken over.`) +
    (snippetText ? quoteBlock(snippetText) : '');

  const html = renderEmail({
    preheader: `${cust} replied — they're waiting for you.`,
    kicker: 'Human mode',
    headline: `${esc(cust)} replied — they're waiting for you`,
    bodyHtml,
    cta: { label: 'Reply now', href: dashUrl },
    footerHtml: tenantFooterHtml(tenantEmail),
  });

  const text = `Hi ${name},\n\n${cust} replied in the conversation you've taken over.\n\n${snippetText ? `"${snippetText}"\n\n` : ''}Reply now: ${dashUrl}\n\n${tenantFooterText(tenantEmail)}`;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[Email] Human mode reply (SMTP not configured) — ${cust} replied → would notify ${to}`);
    return;
  }

  const transporter = createTransporter();
  await transporter.sendMail({
    from:    tenantFrom(tenantEmail),
    replyTo: tenantReplyTo(tenantEmail),
    to,
    subject: `${cust} is waiting for your reply — Shenmay AI`,
    text,
    html,
  });

  console.log(`[Email] Human mode reply notification sent to ${to} (customer: ${cust})`);
}


// ── Send license-key delivery email ────────────────────────────────────────

async function sendLicenseKeyEmail({ to, firstName, licenseKey, plan, expiresAt }) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn('[Email] SMTP not configured — skipping license key email');
    return;
  }

  const expiryLine = expiresAt
    ? `Your license is valid until <strong style="color:${BRAND.ink};font-weight:600;">${esc(new Date(expiresAt).toDateString())}</strong>. Renew before it expires to avoid interruption.`
    : `Your license has <strong style="color:${BRAND.ink};font-weight:600;">no expiry date</strong> — it will remain active until cancelled.`;

  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);

  const bodyHtml =
    paragraph(`Hi ${esc(firstName)}, thanks for your Shenmay AI self-hosted license. Here is your key:`) +
    licenseKeyBlock(licenseKey) +
    metaTable([
      { label: 'Plan',   value: `<strong style="color:${BRAND.ink};font-weight:600;">${esc(planLabel)}</strong>` },
      { label: 'Status', value: expiryLine },
    ]) +
    `<div style="margin:6px 0 18px;">
       <div style="font-family:${BRAND.fontMono};font-size:11px;font-weight:400;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.teal};margin:0 0 10px;">How to activate (recommended)</div>
       <ol style="margin:0;padding-left:20px;font-family:${BRAND.fontSans};font-size:14px;color:${BRAND.inkSoft};line-height:1.75;">
         <li style="margin-bottom:4px;">Log in to your Shenmay dashboard.</li>
         <li style="margin-bottom:4px;">Go to <strong style="color:${BRAND.ink};font-weight:600;">Plans &amp; Billing</strong> in the sidebar.</li>
         <li>Paste your license key above into the activation field and click <strong style="color:${BRAND.ink};font-weight:600;">Activate</strong>.</li>
       </ol>
     </div>` +
    paragraph(`Your plan limits lift instantly — no restart, no SSH, no file editing.`) +
    `<details style="margin:16px 0 6px;font-family:${BRAND.fontSans};font-size:13px;color:${BRAND.mute};">
       <summary style="cursor:pointer;color:${BRAND.inkSoft};font-weight:500;">Advanced: activate via <code style="font-family:${BRAND.fontMono};">.env</code> instead</summary>
       <ol style="margin:8px 0 0;padding-left:20px;line-height:1.7;">
         <li style="margin-bottom:3px;">Open the <code style="font-family:${BRAND.fontMono};">.env</code> file in your Shenmay installation directory.</li>
         <li style="margin-bottom:3px;">Add: <code style="font-family:${BRAND.fontMono};">SHENMAY_LICENSE_KEY=${esc(licenseKey)}</code></li>
         <li style="margin-bottom:3px;">Recreate the backend: <code style="font-family:${BRAND.fontMono};">docker compose up -d --force-recreate backend</code></li>
         <li>This path pins the license via environment variable and locks out the dashboard activation UI.</li>
       </ol>
     </details>`;

  const html = renderEmail({
    preheader: `Your Shenmay AI ${planLabel} license key.`,
    kicker: 'License key',
    headline: 'Your Shenmay AI license key',
    bodyHtml,
    smallPrintHtml: `Keep this key private. Do not share it or commit it to version control. If you lose it, contact <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND.teal};text-decoration:none;">${SUPPORT_EMAIL}</a>.`,
  });

  const text = `Your Shenmay AI License Key\n\nHi ${firstName},\n\nYour license key is:\n\n  ${licenseKey}\n\nPlan: ${plan}\n${expiresAt ? `Expires: ${new Date(expiresAt).toDateString()}\n` : 'No expiry date.\n'}\nHow to activate (recommended):\n  1. Log in to your Shenmay dashboard.\n  2. Go to Plans & Billing in the sidebar.\n  3. Paste the key above into the activation field and click Activate.\n\nYour plan limits lift instantly — no restart, no SSH, no file editing.\n\nAdvanced (env-var path): add SHENMAY_LICENSE_KEY=${licenseKey} to your .env file and run \`docker compose up -d --force-recreate backend\`. This pins the license and disables dashboard activation.\n\nKeep this key private.\n`;

  await transporter.sendMail({
    from:    FROM,
    to,
    subject: 'Your Shenmay AI License Key',
    html,
    text,
  });
}


// ── Send customer-portal magic-link email ──────────────────────────────────
// Used by the Shenmay-native license portal (POST /api/public/portal/request-login).
// The link lands on pontensolutions.com/license/verify?token=... where the
// Lovable page exchanges the token for a session via POST /portal/verify.

async function sendPortalMagicLinkEmail({ to, verifyUrl }) {
  const html = renderEmail({
    preheader: `Sign in to your Shenmay AI license portal. Link expires in 15 minutes.`,
    kicker: 'License portal',
    headline: 'Sign in to your license portal',
    bodyHtml:
      paragraph(`Click the button below to access your Shenmay AI license dashboard. This link expires in 15 minutes.`),
    cta: { label: 'Sign in', href: verifyUrl },
    smallPrintHtml: `If you didn't request this, you can safely ignore this email — no one can sign in without clicking the link above.`,
  });

  const text = `Sign in to your Shenmay AI license portal:\n\n${verifyUrl}\n\nThis link expires in 15 minutes. If you didn't request this, ignore this email.\n\nShenmay AI`;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[Email] SMTP not configured — portal magic link for ${to}:`);
    console.log(`[Email] ${verifyUrl}`);
    return;
  }

  const transporter = createTransporter();
  await transporter.sendMail({
    from:    FROM,
    to,
    subject: 'Sign in to your Shenmay AI license portal',
    text,
    html,
  });

  console.log(`[Email] Portal magic link sent to ${to}`);
}


module.exports = {
  sendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendTrialLimitEmail,
  sendConcernEmail,
  sendAgentInviteEmail,
  sendDocumentEmail,
  sendHumanModeReplyEmail,
  sendLicenseKeyEmail,
  sendPortalMagicLinkEmail,
};
