// Unit tests for SubscriptionGate's gating decision (useSubscriptionStatus).
//
// The Playwright e2e suite always seeds a master/active subscription so a
// canary tenant can reach the dashboard — it never walks the locked/expired
// branches. These tests pin the decision logic directly: which plans bypass
// the gate, when a trial still counts as valid, and when it locks out.
//
// useSubscriptionStatus is a hook by name only — it computes from its argument
// and calls no React hooks internally — so it's safe to invoke as a plain fn.

import { describe, expect, it } from "vitest";
import { useSubscriptionStatus } from "@/components/shenmay/SubscriptionGate";

const future = () => new Date(Date.now() + 5 * 86400_000).toISOString();
const past = () => new Date(Date.now() - 86400_000).toISOString();

describe("useSubscriptionStatus gating", () => {
  it("treats unrestricted plans (master/enterprise) as valid regardless of status", () => {
    expect(useSubscriptionStatus({ plan: "master", status: "canceled" }).valid).toBe(true);
    expect(useSubscriptionStatus({ plan: "enterprise", status: "expired" }).valid).toBe(true);
  });

  it("treats an active paid plan as valid", () => {
    expect(useSubscriptionStatus({ plan: "starter", status: "active" }).valid).toBe(true);
  });

  it("allows a trial that has not yet ended and blocks one that has", () => {
    const live = useSubscriptionStatus({ plan: "trial", status: "trialing", trial_ends_at: future() });
    expect(live.valid).toBe(true);
    expect(live.trialing).toBe(true);
    expect(live.trialDays).toBeGreaterThan(0);

    const ended = useSubscriptionStatus({ plan: "trial", status: "trialing", trial_ends_at: past() });
    expect(ended.valid).toBe(false);
    expect(ended.trialDays).toBe(0);
  });

  it("blocks when there is no subscription, or a non-active/non-trial status", () => {
    expect(useSubscriptionStatus(null).valid).toBe(false);
    expect(useSubscriptionStatus(undefined).valid).toBe(false);
    expect(useSubscriptionStatus({ plan: "starter", status: "past_due" }).valid).toBe(false);
    expect(useSubscriptionStatus({ plan: "starter", status: "canceled" }).valid).toBe(false);
  });
});
