import { useState } from "react";
import { activateLicense, deactivateLicense } from "@/lib/shenmayApi";
import {
  ExternalLink, Users, MessageSquare, Zap, AlertTriangle,
  Key, CheckCircle2, XCircle, Loader2,
} from "lucide-react";
import { PLAN_LABELS } from "@/lib/constants";
import { TOKENS as T, Kicker, Display, Lede, Notice, Button } from "@/components/shenmay/ui/ShenmayUI";
import PlanChip from "./PlanChip";
import UsageMeter from "./UsageMeter";

export default function SelfHostedView({ currentPlan, isTrialPlan, usage, licenseInfo, onRefresh }) {
  const [licenseInput, setLicenseInput]     = useState("");
  const [licenseBusy, setLicenseBusy]       = useState(false);
  const [licenseError, setLicenseError]     = useState(null);
  const [licenseSuccess, setLicenseSuccess] = useState(null);

  // Show the limits stored on the subscription row (the same source as the
  // usage meters and limit checks) rather than hardcoded numbers: 'free' is
  // 1 / 20 and an admin can set custom limits.
  const trialMessages  = usage?.messages_limit  ?? 50;
  const trialCustomers = usage?.customers_limit ?? 3;
  // The auth-context subscription behind isTrialPlan is fetched once, so it
  // goes stale after an activation here; licenseInfo is re-fetched by onRefresh.
  const onTrial = ["free", "trial"].includes(licenseInfo?.plan ?? currentPlan);

  const handleActivateLicense = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (!licenseInput.trim()) return;
    setLicenseBusy(true); setLicenseError(null); setLicenseSuccess(null);
    try {
      const res = await activateLicense(licenseInput.trim());
      setLicenseSuccess(`License activated — ${res.plan} plan${res.expires_at ? ` (expires ${new Date(res.expires_at).toLocaleDateString()})` : ""}.`);
      setLicenseInput("");
      await onRefresh?.();
    } catch (err) { setLicenseError(err.message || "Activation failed"); }
    finally { setLicenseBusy(false); }
  };

  const handleDeactivateLicense = async () => {
    if (!window.confirm("Deactivate this license? You'll revert to trial limits (50 messages/mo, 3 customers).")) return;
    setLicenseBusy(true); setLicenseError(null); setLicenseSuccess(null);
    try {
      await deactivateLicense();
      setLicenseSuccess("License deactivated. Trial limits restored.");
      await onRefresh?.();
    } catch (err) { setLicenseError(err.message || "Deactivation failed"); }
    finally { setLicenseBusy(false); }
  };

  return (
    <div>
      <div style={{ marginBottom: 32 }}>
        <Kicker>Self-hosted · License</Kicker>
        <Display size={38} italic style={{ marginTop: 12 }}>License & usage.</Display>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
          <PlanChip plan={currentPlan} />
          <span style={{ fontSize: 14, color: T.mute }}>Running on your own server.</span>
        </div>
      </div>

      {onTrial && (
        <div style={{ marginBottom: 20 }}>
          <Notice tone="teal" icon={Zap}>
            <strong style={{ color: T.ink }}>Free trial active.</strong>{" "}
            Limited to {trialMessages} messages/mo and {trialCustomers} customer{trialCustomers === 1 ? "" : "s"}. Purchase a license to unlock your full plan.
          </Notice>
        </div>
      )}

      {usage && (usage.customer_limit_reached || usage.message_limit_reached) && (
        <div style={{ marginBottom: 20 }}>
          <Notice tone="danger" icon={AlertTriangle}>
            <strong style={{ color: T.danger }}>Plan limit reached.</strong>{" "}
            Purchase a license and add your key below to restore service immediately.
          </Notice>
        </div>
      )}

      {usage && (
        <>
          <Kicker color={T.mute} style={{ display: "block", margin: "16px 0 14px" }}>Figure 01 · Usage</Kicker>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, marginBottom: 32 }}>
            <UsageMeter icon={Users}          label="Customers"             used={usage.customers_count} limit={usage.customers_limit} pct={usage.customers_pct} nearLimit={usage.near_customer_limit} limitReached={usage.customer_limit_reached} />
            <UsageMeter icon={MessageSquare}  label="Messages · this month" used={usage.messages_used}   limit={usage.messages_limit}   pct={usage.messages_pct}  nearLimit={usage.near_message_limit}  limitReached={usage.message_limit_reached} />
          </div>
        </>
      )}

      {licenseInfo?.has_license && (
        <div style={{ background: "#FFFFFF", border: `1px solid ${T.paperEdge}`, borderRadius: 10, padding: 24, marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
            <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#EBF1E9", border: `1px solid #CDDCCA`, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <CheckCircle2 size={16} color={T.success} />
            </div>
            <div>
              <Kicker color={T.success}>License active</Kicker>
              <div style={{ fontFamily: T.sans, fontWeight: 500, fontSize: 16, color: T.ink, marginTop: 2 }}>
                {PLAN_LABELS[licenseInfo.plan]?.label || licenseInfo.plan}
              </div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, padding: "14px 0", borderTop: `1px solid ${T.paperEdge}` }}>
            <div>
              <Kicker color={T.mute} style={{ display: "block", marginBottom: 6 }}>Key</Kicker>
              <code style={{ fontFamily: T.mono, fontSize: 12, color: T.ink, background: T.paperDeep, padding: "4px 8px", borderRadius: 4 }}>
                {licenseInfo.key_masked}
              </code>
            </div>
            <div>
              <Kicker color={T.mute} style={{ display: "block", marginBottom: 6 }}>Limits</Kicker>
              <div style={{ fontSize: 13, color: T.ink }}>
                {licenseInfo.max_messages_month} msg/mo · {licenseInfo.max_customers} customers
              </div>
            </div>
          </div>
          {licenseInfo.validated_at && (
            <p style={{ fontSize: 12, color: T.mute, margin: "12px 0 0" }}>
              Last validated {new Date(licenseInfo.validated_at).toLocaleString()} · revalidates every 24h.
            </p>
          )}
          {!licenseInfo.env_var_in_use && (
            <div style={{ marginTop: 16 }}>
              <Button variant="danger" size="sm" onClick={handleDeactivateLicense} disabled={licenseBusy}>
                <XCircle size={13} /> Deactivate license
              </Button>
            </div>
          )}
          {licenseInfo.env_var_in_use && (
            <p style={{ fontSize: 12, fontStyle: "italic", color: T.mute, margin: "12px 0 0" }}>
              License is pinned via <code style={{ fontFamily: T.mono, background: T.paperDeep, padding: "2px 6px", borderRadius: 3 }}>SHENMAY_LICENSE_KEY</code> in your .env — to deactivate, remove that line and restart.
            </p>
          )}
        </div>
      )}

      <div style={{ background: "#FFFFFF", border: `1px solid ${T.paperEdge}`, borderRadius: 10, padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: `${T.teal}15`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Key size={16} color={T.teal} />
          </div>
          <div>
            <Kicker>{licenseInfo?.has_license ? "Change license" : (isTrialPlan ? "Activate a license" : "Update license")}</Kicker>
            <div style={{ fontFamily: T.sans, fontWeight: 500, fontSize: 16, color: T.ink, marginTop: 2 }}>
              Paste your key to activate instantly.
            </div>
          </div>
        </div>

        {!licenseInfo?.has_license && (
          <Lede style={{ marginTop: 12, fontSize: 14 }}>
            Purchase a license at{" "}
            <a href="https://pontensolutions.com/shenmay/license" target="_blank" rel="noopener noreferrer" style={{ color: T.teal, textDecoration: "none", borderBottom: `1px solid ${T.teal}40` }}>
              pontensolutions.com/shenmay/license
            </a>
            . You'll receive a key by email — no restart required.
          </Lede>
        )}

        {licenseInfo?.env_var_in_use ? (
          <p style={{ fontSize: 12, fontStyle: "italic", color: T.mute, margin: "16px 0 0" }}>
            Your license is pinned via <code style={{ fontFamily: T.mono, background: T.paperDeep, padding: "2px 6px", borderRadius: 3 }}>SHENMAY_LICENSE_KEY</code> in .env (or legacy <code style={{ fontFamily: T.mono, background: T.paperDeep, padding: "2px 6px", borderRadius: 3 }}>NOMII_LICENSE_KEY</code>, both are read). To change from the dashboard, remove that line and restart, then come back here.
          </p>
        ) : (
          <form onSubmit={handleActivateLicense} style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <Kicker color={T.mute} style={{ display: "block", marginBottom: 8 }}>License key</Kicker>
              <input
                type="text"
                value={licenseInput}
                onChange={(e) => setLicenseInput(e.target.value)}
                placeholder="SHENMAY-XXXX-XXXX-XXXX-XXXX  (or legacy NOMII-)"
                disabled={licenseBusy}
                spellCheck={false}
                autoComplete="off"
                style={{
                  width: "100%", padding: "12px 14px",
                  fontFamily: T.mono, fontSize: 14, letterSpacing: "0.04em", color: T.ink,
                  background: "#FFFFFF", border: `1px solid ${T.paperEdge}`, borderRadius: 6,
                  outline: "none", transition: "border-color 180ms",
                }}
                onFocus={(e) => Object.assign(e.currentTarget.style, { borderColor: T.ink, boxShadow: `0 0 0 3px ${T.teal}1F` })}
                onBlur={(e) => Object.assign(e.currentTarget.style, { borderColor: T.paperEdge, boxShadow: "none" })}
              />
            </div>

            {licenseError && <Notice tone="danger" icon={XCircle}>{licenseError}</Notice>}
            {licenseSuccess && <Notice tone="success" icon={CheckCircle2}>{licenseSuccess}</Notice>}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Button type="submit" variant="primary" disabled={licenseBusy || !licenseInput.trim()}>
                {licenseBusy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Zap size={14} />}
                {licenseInfo?.has_license ? "Replace license" : "Activate license"}
              </Button>
              <a href="https://pontensolutions.com/shenmay/license" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                <Button variant="ghost">Get a license <ExternalLink size={13} /></Button>
              </a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
