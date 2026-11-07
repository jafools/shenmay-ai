import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { completeSetup, setToken } from "@/lib/shenmayApi";
import { Building2, User, Key, Eye, EyeOff, ArrowRight, CheckCircle, ExternalLink, Loader2 } from "lucide-react";
import ShenmayWordmark from "@/components/shenmay/ShenmayWordmark";
import ShenmaySeal from "@/components/shenmay/ShenmaySeal";
import {
  TOKENS as T,
  Kicker,
  Display,
  Lede,
  Field,
  Input,
  Button,
  Notice,
  PageShell,
} from "@/components/shenmay/ui/ShenmayUI";

const STEPS = [
  { id: 1, label: "Your company",   icon: Building2 },
  { id: 2, label: "Admin account",  icon: User },
  { id: 3, label: "Connect AI",     icon: Key },
];

const ShenmaySetup = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const next = () => {
    setError("");
    if (step === 1 && !companyName.trim()) { setError("Please enter your company name."); return; }
    if (step === 2) {
      if (!email.trim()) { setError("Please enter your email address."); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Please enter a valid email address."); return; }
      if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
      if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    }
    setStep((s) => s + 1);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (!apiKey.trim().startsWith("sk-ant-")) { setError("Please enter a valid Anthropic API key. It starts with sk-ant-"); return; }
    setLoading(true);
    try {
      const data = await completeSetup({ companyName: companyName.trim(), email: email.trim(), password, anthropicApiKey: apiKey.trim() });
      setToken(data.token);
      // Self-hosted first-run lands on widget-install step of onboarding
      // (products/customers/api_key/tools are pre-marked complete server-side,
      // so /shenmay/onboarding resumes at install_widget — fixes SH-1/SH-2).
      navigate("/onboarding", { replace: true });
    } catch (err) {
      setError(err.message || "Setup failed. Please try again.");
    } finally { setLoading(false); }
  };

  return (
    <PageShell style={{ display: "flex" }}>
      {/* ── LEFT editorial panel ───────────────────────────── */}
      <aside className="shenmay-setup-aside"
        style={{
          display: "none",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "45%",
          background: T.paperDeep,
          borderRight: `1px solid ${T.paperEdge}`,
          padding: "56px 64px",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <style>{`@media (min-width: 1024px) { .shenmay-setup-aside { display: flex !important; } }`}</style>

        <div>
          <ShenmayWordmark size={26} />
          <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: T.mute, marginTop: 10 }}>
            Self-hosted setup
          </div>
        </div>

        <div style={{ maxWidth: 440 }}>
          <Kicker style={{ marginBottom: 18 }}>Figure 03 · First boot</Kicker>
          <Display size={40} italic>Your agent.</Display>
          <Display size={40} italic={false} style={{ fontWeight: 500 }}>Your server.</Display>
          <Lede style={{ fontSize: 16, marginTop: 18 }}>
            Three steps to get Shenmay AI running locally. Everything stays on your infrastructure — we don't touch it.
          </Lede>
        </div>

        {/* Step rail */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {STEPS.map((s) => {
            const done    = step > s.id;
            const current = step === s.id;
            const bg     = done ? T.teal : current ? T.ink : T.paperEdge;
            const color  = done || current ? T.paper : T.mute;
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 6, flexShrink: 0,
                  background: bg, color, display: "inline-flex", alignItems: "center", justifyContent: "center",
                  transition: "background 200ms, color 200ms",
                }}>
                  {done ? <CheckCircle size={16} /> : <s.icon size={15} />}
                </div>
                <span style={{ fontSize: 14, fontWeight: 500, color: done ? T.ink : current ? T.ink : T.mute, letterSpacing: "-0.005em" }}>
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>

        <div style={{ position: "absolute", top: 40, right: 40, opacity: 0.9 }}>
          <ShenmaySeal size={88} paper={T.paperDeep} />
        </div>
      </aside>

      {/* ── RIGHT form ────────────────────────────────────── */}
      <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "56px 24px" }}>
        <div style={{ width: "100%", maxWidth: 440 }}>
          {/* Mobile wordmark + step dots */}
          <div className="shenmay-setup-mobile"
            style={{ marginBottom: 32, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
            <ShenmayWordmark size={22} />
            <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: T.mute }}>
              Self-hosted setup
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              {STEPS.map((s) => (
                <div key={s.id}
                  style={{
                    width: step === s.id ? 24 : 8, height: 6, borderRadius: 3,
                    background: step >= s.id ? T.teal : T.paperEdge, transition: "width 200ms, background 200ms",
                  }}
                />
              ))}
            </div>
          </div>
          <style>{`@media (min-width: 1024px) { .shenmay-setup-mobile { display: none !important; } }`}</style>

          {step === 1 && (
            <>
              <Kicker>Step 1 of 3</Kicker>
              <Display size={32} italic style={{ marginTop: 12 }}>What's your company?</Display>
              <Lede>This is what your Shenmay workspace will be called.</Lede>

              <form onSubmit={(e) => { e.preventDefault(); next(); }} style={{ marginTop: 32, display: "flex", flexDirection: "column", gap: 20 }}>
                <Field id="companyName" label="Company name">
                  <Input id="companyName" type="text" placeholder="Acme Corp" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
                </Field>

                {error && <Notice tone="danger">{error}</Notice>}

                <Button type="submit" variant="primary" size="lg">
                  Continue <ArrowRight size={15} />
                </Button>
              </form>
            </>
          )}

          {step === 2 && (
            <>
              <Kicker>Step 2 of 3</Kicker>
              <Display size={32} italic style={{ marginTop: 12 }}>Create admin access.</Display>
              <Lede>The credentials you'll use to sign in to your Shenmay dashboard.</Lede>

              <form onSubmit={(e) => { e.preventDefault(); next(); }} style={{ marginTop: 32, display: "flex", flexDirection: "column", gap: 20 }}>
                <Field id="email" label="Email">
                  <Input id="email" type="email" placeholder="you@yourcompany.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>

                <Field id="password" label="Password">
                  <div style={{ position: "relative" }}>
                    <Input id="password" type={showPassword ? "text" : "password"} placeholder="Min. 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} style={{ paddingRight: 40 }} />
                    <button type="button" onClick={() => setShowPassword((v) => !v)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: T.mute, cursor: "pointer", padding: 4 }}>
                      {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </Field>

                <Field id="confirmPassword" label="Confirm password">
                  <div style={{ position: "relative" }}>
                    <Input id="confirmPassword" type={showConfirm ? "text" : "password"} placeholder="Repeat your password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} style={{ paddingRight: 40 }} />
                    <button type="button" onClick={() => setShowConfirm((v) => !v)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: T.mute, cursor: "pointer", padding: 4 }}>
                      {showConfirm ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </Field>

                {error && <Notice tone="danger">{error}</Notice>}

                <div style={{ display: "flex", gap: 10 }}>
                  <Button type="button" variant="ghost" style={{ flex: 1 }} onClick={() => { setError(""); setStep(1); }}>Back</Button>
                  <Button type="submit" variant="primary" style={{ flex: 1 }}>Continue <ArrowRight size={15} /></Button>
                </div>
              </form>
            </>
          )}

          {step === 3 && (
            <>
              <Kicker>Step 3 of 3</Kicker>
              <Display size={32} italic style={{ marginTop: 12 }}>Connect your AI.</Display>
              <Lede>Shenmay uses Claude by Anthropic. Paste your API key — it's encrypted with AES-256 and stays on your server.</Lede>

              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer"
                style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 20, fontSize: 13, color: T.teal, textDecoration: "none", fontWeight: 500, borderBottom: `1px solid ${T.teal}40` }}>
                <ExternalLink size={12} /> Get an API key at console.anthropic.com
              </a>

              <form onSubmit={handleSubmit} style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 20 }}>
                <Field id="apiKey" label="Anthropic API key" hint="Your key never leaves your server.">
                  <div style={{ position: "relative" }}>
                    <Input
                      id="apiKey"
                      type={showApiKey ? "text" : "password"}
                      placeholder="sk-ant-..."
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      style={{ paddingRight: 40, fontFamily: showApiKey ? T.sans : T.mono, letterSpacing: showApiKey ? "-0.01em" : "0.05em" }}
                    />
                    <button type="button" onClick={() => setShowApiKey((v) => !v)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: T.mute, cursor: "pointer", padding: 4 }}>
                      {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </Field>

                {error && <Notice tone="danger">{error}</Notice>}

                <div style={{ display: "flex", gap: 10 }}>
                  <Button type="button" variant="ghost" style={{ flex: 1 }} disabled={loading} onClick={() => { setError(""); setStep(2); }}>Back</Button>
                  <Button type="submit" variant="primary" style={{ flex: 1 }} disabled={loading}>
                    {loading ? (<><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Setting up…</>) : (<>Finish setup <ArrowRight size={15} /></>)}
                  </Button>
                </div>
              </form>

              <p style={{ textAlign: "center", fontSize: 12, marginTop: 28, color: T.mute, lineHeight: 1.6 }}>
                Starting on the free trial — 50 messages/mo, 3 customers.&nbsp;{" "}
                <a href="https://pontensolutions.com/shenmay/license" target="_blank" rel="noopener noreferrer"
                  style={{ color: T.teal, textDecoration: "none", borderBottom: `1px solid ${T.teal}40` }}>
                  Upgrade anytime
                </a>
              </p>
            </>
          )}
        </div>
      </main>
    </PageShell>
  );
};

export default ShenmaySetup;
