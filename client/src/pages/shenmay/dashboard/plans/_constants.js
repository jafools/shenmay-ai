// Stripe live-prod pricing-table defaults. The /api/config endpoint can
// override these per-deployment (e.g. test mode) by returning a stripe block.
export const STRIPE_PRICING_TABLE_ID_LIVE = "prctbl_1TBzcVBlxts7IvMoJ2bWRd47";
export const STRIPE_PUBLISHABLE_KEY_LIVE  = "pk_live_U89VEYjy02VivrGxi5QF2IIw00cPn8Ts2n";
export const STRIPE_PORTAL_LINK           = "https://billing.stripe.com/p/login/28EbJ0cqz4y5gZEgS68N200";

// Upgrade-nudge copy: which tier is the natural next step from each entry-level
// plan, and a one-line value-prop comparing the deltas.
export const UPGRADE_MAP = {
  free:    { next: "starter", delta: "50 customers (vs 1) · 1,000 messages/mo (vs 20) · Keep your own API key" },
  trial:   { next: "starter", delta: "50 customers (vs 3) · 1,000 messages/mo (vs 50) · Keep your own API key" },
  starter: { next: "growth",  delta: "250 customers (vs 50) · 5,000 messages/mo (vs 1,000) · 25 agent seats · Priority support" },
  growth:  { next: "professional", delta: "1,000 customers (vs 250) · 25,000 messages/mo (vs 5,000) · 100 agent seats · Dedicated support" },
};
