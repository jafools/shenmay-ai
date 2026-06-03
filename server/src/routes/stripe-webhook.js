/**
 * SHENMAY AI — Stripe Webhook Handler
 *
 * Receives Stripe events and updates subscription records accordingly.
 * Mounted at POST /api/stripe/webhook with raw body parsing.
 *
 * Key events handled:
 *   - checkout.session.completed  → activate subscription
 *   - invoice.paid               → renew period
 *   - invoice.payment_failed     → mark past_due
 *   - customer.subscription.updated → sync plan/status changes
 *   - customer.subscription.deleted → mark canceled
 */

const router = require('express').Router();
const crypto = require('crypto');
const db     = require('../db');
const { PLAN_LIMITS } = require('../config/plans');
const { sendLicenseKeyEmail } = require('../services/emailService');

function generateLicenseKey() {
  const hex = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `SHENMAY-${hex.slice(0,4)}-${hex.slice(4,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}`;
}

const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET;

// Reverse price ID → plan name lookup (for Stripe pricing table which doesn't pass metadata.plan)
function getPlanFromPriceId(priceId) {
  const map = {
    [process.env.STRIPE_PRICE_STARTER]:      'starter',
    [process.env.STRIPE_PRICE_GROWTH]:       'growth',
    [process.env.STRIPE_PRICE_PROFESSIONAL]: 'professional',
  };
  return map[priceId] || null;
}

function getStripe() {
  if (!STRIPE_SECRET_KEY) throw new Error('Stripe not configured');
  return require('stripe')(STRIPE_SECRET_KEY);
}


router.post('/', async (req, res) => {
  let event;

  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const stripe = getStripe();
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
      // Refuse the dev-mode bypass in production. An unsigned endpoint lets
      // anyone POST a forged event — e.g. a fake checkout.session.completed
      // that issues a free self-hosted license key, or flips a tenant onto a
      // paid plan. Mirror the Resend webhook sibling: in prod, no signing
      // secret means every webhook is rejected until one is wired.
      console.error('[Stripe Webhook] STRIPE_WEBHOOK_SECRET is unset in production — rejecting unsigned webhook.');
      return res.status(400).send('Webhook signing secret not configured');
    } else {
      // Dev mode (non-production, no secret): parse the body directly so local
      // testing with the Stripe CLI or curl works without a signing secret.
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).send('Webhook signature verification failed');
  }

  const { type, data: { object } } = event;
  console.log(`[Stripe Webhook] ${type}`);

  // ── Idempotency guard ──────────────────────────────────────────────────────
  // Stripe delivers at-least-once: a timeout, a slow 200, a 5xx, or a manual
  // resend all cause the SAME event to arrive again. Record event.id the first
  // time and skip repeats — otherwise a retried checkout.session.completed
  // issues (and emails) a SECOND self-hosted license key. The INSERT … ON
  // CONFLICT DO NOTHING is atomic, so even concurrent redeliveries can't both
  // win the race. (The marker is rolled back below if processing then fails.)
  if (event.id) {
    try {
      const { rowCount } = await db.query(
        `INSERT INTO processed_stripe_events (event_id, type)
         VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`,
        [event.id, type]
      );
      if (rowCount === 0) {
        console.log(`[Stripe Webhook] Duplicate ${type} (${event.id}) — already processed, skipping.`);
        return res.json({ received: true, duplicate: true });
      }
    } catch (err) {
      // Couldn't record the event → don't risk double-processing. A 500 makes
      // Stripe retry, and the absent row means the retry is processed cleanly.
      console.error('[Stripe Webhook] Idempotency check failed:', err.message);
      return res.status(500).json({ error: 'Webhook idempotency check failed' });
    }
  }

  try {
    switch (type) {

      // ── Checkout completed → activate subscription OR issue license key ───────
      case 'checkout.session.completed': {

        // ── Self-hosted purchase: issue a license key and email it ─────────────
        // On your Stripe payment link / product, set:
        //   metadata.product_type = 'selfhosted'
        //   metadata.plan         = 'starter' | 'growth' | 'professional'  (optional, defaults starter)
        if (object.metadata?.product_type === 'selfhosted') {
          const plan          = object.metadata?.plan || 'starter';
          const email         = object.customer_details?.email || object.metadata?.email;
          const name          = object.customer_details?.name  || null;
          const license_key   = generateLicenseKey();

          if (email) {
            await db.query(
              `INSERT INTO licenses
                 (license_key, plan, issued_to_email, issued_to_name, notes)
               VALUES ($1, $2, $3, $4, $5)`,
              [license_key, plan, email.toLowerCase().trim(), name,
               `Auto-issued via Stripe checkout ${object.id}`]
            );

            sendLicenseKeyEmail({
              to:         email,
              firstName:  name || email.split('@')[0],
              licenseKey: license_key,
              plan,
              expiresAt:  null,
            }).catch(err => console.warn('[Stripe] License email failed:', err.message));

            console.log(`[Stripe] Self-hosted license issued: ${email} → ${license_key} (${plan})`);
          } else {
            console.warn('[Stripe] Self-hosted checkout missing customer email:', object.id);
          }
          break;
        }

        // ── SaaS subscription: activate the tenant's subscription ─────────────
        // Support both custom checkout (metadata.tenant_id) and pricing table (client_reference_id)
        const tenantId = object.metadata?.tenant_id || object.client_reference_id;

        // Detect plan: prefer metadata.plan, then look up from price ID (pricing table flow)
        let plan = object.metadata?.plan || null;
        if (!plan && object.subscription) {
          try {
            const stripe = getStripe();
            const sub = await stripe.subscriptions.retrieve(object.subscription);
            const priceId = sub.items?.data?.[0]?.price?.id;
            if (priceId) plan = getPlanFromPriceId(priceId);
          } catch (e) {
            console.error('[Stripe] Could not retrieve subscription for plan lookup:', e.message);
          }
        }
        plan = plan || 'starter';
        const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.starter;

        if (tenantId && object.subscription) {
          // Pure BYOK as of v3.3.27 — never auto-flip managed_ai_enabled on
          // a paid Stripe upgrade. The customer's BYOK paste in Settings is
          // the only path to a working chat. Internal master/enterprise
          // accounts that need the platform key are flagged in the DB
          // directly, not via this webhook.
          await db.query(
            `UPDATE subscriptions SET
               plan                    = $1,
               status                  = 'active',
               stripe_subscription_id  = $2,
               stripe_customer_id      = COALESCE(stripe_customer_id, $3),
               max_customers           = $4,
               max_messages_month      = $5,
               managed_ai_enabled      = false,
               max_agents              = $7,
               current_period_start    = NOW(),
               current_period_end      = NOW() + INTERVAL '1 month',
               updated_at              = NOW()
             WHERE tenant_id = $6`,
            [plan, object.subscription, object.customer, limits.max_customers,
             limits.max_messages_month, tenantId, limits.max_agents]
          );
          console.log(`[Stripe] Tenant ${tenantId} activated on ${plan} plan`);
        } else {
          console.warn('[Stripe] checkout.session.completed missing tenant_id or subscription:', object.id);
        }
        break;
      }

      // ── Invoice paid → renew period, reset usage ───────────────────────────
      case 'invoice.paid': {
        if (object.subscription) {
          await db.query(
            `UPDATE subscriptions SET
               status                    = 'active',
               current_period_start      = to_timestamp($1),
               current_period_end        = to_timestamp($2),
               messages_used_this_month  = 0,
               usage_reset_at            = NOW(),
               updated_at                = NOW()
             WHERE stripe_subscription_id = $3`,
            [object.period_start, object.period_end, object.subscription]
          );
        }
        break;
      }

      // ── Invoice failed → mark past due ─────────────────────────────────────
      case 'invoice.payment_failed': {
        if (object.subscription) {
          await db.query(
            `UPDATE subscriptions SET status = 'past_due', updated_at = NOW()
             WHERE stripe_subscription_id = $1`,
            [object.subscription]
          );
        }
        break;
      }

      // ── Subscription updated (plan change, cancel at period end, etc.) ─────
      case 'customer.subscription.updated': {
        const stripeStatus = object.status;
        let dbStatus = 'active';
        if (stripeStatus === 'past_due') dbStatus = 'past_due';
        if (stripeStatus === 'canceled') dbStatus = 'canceled';
        if (stripeStatus === 'unpaid')   dbStatus = 'expired';
        if (object.cancel_at_period_end) dbStatus = 'active'; // still active until period end

        await db.query(
          `UPDATE subscriptions SET
             status                = $1,
             current_period_start  = to_timestamp($2),
             current_period_end    = to_timestamp($3),
             canceled_at           = $4,
             updated_at            = NOW()
           WHERE stripe_subscription_id = $5`,
          [dbStatus, object.current_period_start, object.current_period_end,
           object.canceled_at ? new Date(object.canceled_at * 1000) : null,
           object.id]
        );
        break;
      }

      // ── Subscription deleted → mark canceled ───────────────────────────────
      case 'customer.subscription.deleted': {
        await db.query(
          `UPDATE subscriptions SET
             status      = 'canceled',
             canceled_at = NOW(),
             updated_at  = NOW()
           WHERE stripe_subscription_id = $1`,
          [object.id]
        );
        break;
      }

      default:
        // Unhandled event — that's fine, just log it
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook] Error processing event:', err.message);
    // Processing failed after we recorded the event id — remove the marker so
    // Stripe's retry reprocesses it instead of being skipped as a duplicate.
    if (event.id) {
      await db.query('DELETE FROM processed_stripe_events WHERE event_id = $1', [event.id])
        .catch(delErr => console.error('[Stripe Webhook] Failed to roll back idempotency marker:', delErr.message));
    }
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});


module.exports = router;
