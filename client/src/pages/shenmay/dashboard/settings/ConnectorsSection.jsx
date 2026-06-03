import { useState, useEffect } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { useShenmayAuth } from "@/contexts/ShenmayAuthContext";
import { getMe, updateCompany, updatePrivacySettings, updateAnonymousOnlyMode, getProducts, addProduct, updateProduct, deleteProduct, getDataApiKey, generateDataApiKey, revokeDataApiKey, getAgentSoul, generateSoul, getWebhooks, createWebhook, updateWebhook, deleteWebhook, testWebhook, getLabels, createLabel, updateLabel, deleteLabel, getConnectors, updateConnectors, testSlack, testTeams, getEmailTemplates, updateEmailTemplates } from "@/lib/shenmayApi";
import { toast } from "@/hooks/use-toast";
import { Copy, Check, Plus, Trash2, Pencil, X, ChevronUp, Key, AlertTriangle, RefreshCw, Eye, EyeOff, Brain, Sparkles, Shield, MessageSquare, Webhook, ToggleLeft, ToggleRight, Send, ChevronDown, Tag, Plug2, Zap, Mail } from "lucide-react";
import { Link } from "react-router-dom";
import { TOKENS as T, Kicker, Display, Lede } from "@/components/shenmay/ui/ShenmayUI";


import { card, inputClass, inputStyle } from "./_shared";

const CONNECTOR_EVENTS = [
  { value: "conversation.started",   label: "New conversation started"  },
  { value: "conversation.escalated", label: "Conversation escalated"    },
  { value: "handoff.requested",      label: "Human support requested"   },
  { value: "human.takeover",         label: "Human took over"           },
  { value: "human.handback",         label: "Handed back to AI"         },
  { value: "csat.received",          label: "CSAT rating received"      },
];

const ConnectorsSection = () => {
  const [tab,        setTab]        = useState("slack");
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [testing,    setTesting]    = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, message }
  const [slackUrl,    setSlackUrl]    = useState("");
  const [teamsUrl,    setTeamsUrl]    = useState("");
  const [slackEvents, setSlackEvents] = useState([]);
  const [teamsEvents, setTeamsEvents] = useState([]);
  const [showSlackUrl, setShowSlackUrl] = useState(false);
  const [showTeamsUrl, setShowTeamsUrl] = useState(false);

  useEffect(() => {
    getConnectors()
      .then(d => {
        const c = d.connectors || {};
        setSlackUrl(c.slack_webhook_url || "");
        setTeamsUrl(c.teams_webhook_url || "");
        setSlackEvents(c.slack_notify_events || []);
        setTeamsEvents(c.teams_notify_events || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggleEvent = (setList, val) => {
    setList(prev => prev.includes(val) ? prev.filter(e => e !== val) : [...prev, val]);
    setTestResult(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      await updateConnectors({
        slack_webhook_url:   slackUrl || null,
        teams_webhook_url:   teamsUrl || null,
        slack_notify_events: slackEvents,
        teams_notify_events: teamsEvents,
      });
      toast({ title: "Connectors saved" });
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (tab === "slack") await testSlack();
      if (tab === "teams") await testTeams();
      setTestResult({ ok: true, message: "Test message sent successfully!" });
    } catch (err) {
      setTestResult({ ok: false, message: err.message || "Delivery failed — check your webhook URL." });
    } finally { setTesting(false); }
  };

  const tabs = [
    { id: "slack",  label: "Slack"             },
    { id: "teams",  label: "Microsoft Teams"   },
    { id: "zapier", label: "Zapier"            },
  ];

  const isSlack   = tab === "slack";
  const isTeams   = tab === "teams";
  const isZapier  = tab === "zapier";
  const currentUrl    = isSlack ? slackUrl    : teamsUrl;
  const setCurrentUrl = isSlack ? setSlackUrl : setTeamsUrl;
  const currentEvents    = isSlack ? slackEvents    : teamsEvents;
  const setCurrentEvents = isSlack ? setSlackEvents : setTeamsEvents;
  const showUrl    = isSlack ? showSlackUrl    : showTeamsUrl;
  const setShowUrl = isSlack ? setShowSlackUrl : setShowTeamsUrl;

  return (
    <div className="rounded-2xl p-6 space-y-5"
      style={{ background: "#EDE7D7", border: "1px solid #EDE7D7" }}>

      {/* Header */}
      <div className="flex items-center gap-2">
        <Plug2 size={16} style={{ color: "#0F5F5C" }} />
        <div>
          <h3 className="text-[14px] font-semibold text-[#1A1D1A]">Connectors</h3>
          <p className="text-[11px] text-[#6B6B64] mt-0.5">Send real-time alerts to Slack, Teams, or Zapier when key events occur.</p>
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex gap-1 p-1 rounded-xl" style={{ background: "#EDE7D7" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setTestResult(null); }}
            className="flex-1 py-1.5 rounded-lg text-[12px] font-medium transition-all"
            style={tab === t.id
              ? { background: "rgba(15,95,92,0.15)", color: "#0F5F5C", border: "1px solid rgba(15,95,92,0.20)" }
              : { color: "#6B6B64" }}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3 animate-pulse">
          <div className="h-10 rounded-xl" style={{ background: "#EDE7D7" }} />
          <div className="h-32 rounded-xl" style={{ background: "#EDE7D7" }} />
        </div>

      ) : isZapier ? (
        /* ── Zapier tab ──────────────────────────────────────────── */
        <div className="space-y-4">
          <div className="rounded-xl p-4 space-y-2"
            style={{ background: "rgba(251,146,60,0.06)", border: "1px solid rgba(251,146,60,0.15)" }}>
            <div className="flex items-center gap-2">
              <Zap size={14} style={{ color: "#FB923C" }} />
              <span className="text-[13px] font-semibold" style={{ color: "#FB923C" }}>Zapier-ready Webhooks</span>
            </div>
            <p className="text-[12px] leading-relaxed" style={{ color: "#6B6B64" }}>
              Shenmay AI fires outgoing webhooks on every key conversation event. Connect Zapier by creating a <strong className="text-[#3A3D39]">Webhooks by Zapier</strong> trigger, then paste the Zapier URL into your Shenmay webhook settings below.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#6B6B64" }}>Supported events</p>
            <div className="grid grid-cols-2 gap-2">
              {CONNECTOR_EVENTS.map(ev => (
                <div key={ev.value} className="flex items-start gap-2 px-3 py-2 rounded-lg"
                  style={{ background: "rgba(255,255,255,0.025)", border: "1px solid #EDE7D7" }}>
                  <div className="w-1.5 h-1.5 rounded-full mt-1 shrink-0" style={{ background: "#0F5F5C" }} />
                  <div>
                    <p className="text-[11px] font-mono" style={{ color: "#6B6B64" }}>{ev.value}</p>
                    <p className="text-[10px]" style={{ color: "#6B6B64" }}>{ev.label}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl p-4 space-y-3"
            style={{ background: "#EDE7D7", border: "1px solid #EDE7D7" }}>
            <p className="text-[12px] font-semibold" style={{ color: "#6B6B64" }}>How to connect</p>
            <ol className="space-y-2 text-[12px]" style={{ color: "#6B6B64" }}>
              <li className="flex gap-2.5">
                <span className="font-bold shrink-0" style={{ color: "#0F5F5C" }}>1.</span>
                In Zapier, create a new Zap and choose <strong className="text-[#6B6B64]">Webhooks by Zapier</strong> as the trigger.
              </li>
              <li className="flex gap-2.5">
                <span className="font-bold shrink-0" style={{ color: "#0F5F5C" }}>2.</span>
                Select <strong className="text-[#6B6B64]">Catch Hook</strong> and copy your unique Zapier webhook URL.
              </li>
              <li className="flex gap-2.5">
                <span className="font-bold shrink-0" style={{ color: "#0F5F5C" }}>3.</span>
                Go to <strong className="text-[#6B6B64]">Settings → Webhooks</strong> and add a new webhook with that URL and the events you need.
              </li>
              <li className="flex gap-2.5">
                <span className="font-bold shrink-0" style={{ color: "#0F5F5C" }}>4.</span>
                Trigger any event in Shenmay to let Zapier detect the payload structure, then build your Zap actions.
              </li>
            </ol>
          </div>
        </div>

      ) : (
        /* ── Slack / Teams tab ───────────────────────────────────── */
        <div className="space-y-5">

          {/* Webhook URL field */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium" style={{ color: "#6B6B64" }}>
              {isSlack ? "Slack Incoming Webhook URL" : "Teams Incoming Webhook URL"}
            </label>
            <div className="relative">
              <input
                type={showUrl ? "text" : "password"}
                value={currentUrl}
                onChange={e => { setCurrentUrl(e.target.value); setTestResult(null); }}
                placeholder={isSlack
                  ? "https://hooks.slack.com/services/…"
                  : "https://outlook.office.com/webhook/…"}
                className="w-full px-3 py-2.5 pr-10 rounded-xl text-[13px] outline-none"
                style={inputStyle}
              />
              <button onClick={() => setShowUrl(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 transition-opacity hover:opacity-70"
                style={{ color: "#6B6B64" }}>
                {showUrl ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <p className="text-[11px]" style={{ color: "#6B6B64" }}>
              {isSlack
                ? "Create an incoming webhook at api.slack.com/apps → your app → Incoming Webhooks."
                : "Add a connector in Teams: open the channel → Connectors → Incoming Webhook → Configure."}
            </p>
          </div>

          {/* Events */}
          <div className="space-y-2">
            <p className="text-[12px] font-medium" style={{ color: "#6B6B64" }}>Notify on</p>
            <div className="grid grid-cols-2 gap-2">
              {CONNECTOR_EVENTS.map(ev => {
                const on = currentEvents.includes(ev.value);
                return (
                  <button key={ev.value}
                    onClick={() => toggleEvent(setCurrentEvents, ev.value)}
                    className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-all"
                    style={on
                      ? { background: "rgba(15,95,92,0.10)", border: "1px solid rgba(15,95,92,0.22)", color: "#0F5F5C" }
                      : { background: "#EDE7D7", border: "1px solid #EDE7D7", color: "#6B6B64" }}>
                    <div className="w-3.5 h-3.5 rounded flex items-center justify-center shrink-0"
                      style={{
                        background: on ? "rgba(15,95,92,0.25)" : "#EDE7D7",
                        border: `1px solid ${on ? "rgba(15,95,92,0.45)" : "#EDE7D7"}`,
                      }}>
                      {on && <Check size={9} strokeWidth={3} />}
                    </div>
                    <span className="text-[12px] leading-tight">{ev.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Test result banner */}
          {testResult && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-[12px]"
              style={testResult.ok
                ? { background: "rgba(45,106,79,0.07)", border: "1px solid rgba(45,106,79,0.18)", color: "#2D6A4F" }
                : { background: "rgba(248,113,113,0.07)", border: "1px solid rgba(248,113,113,0.18)", color: "#7A1F1A" }}>
              {testResult.ok ? <Check size={13} /> : <AlertTriangle size={13} />}
              <span>{testResult.message}</span>
            </div>
          )}

          {/* Action row */}
          <div className="flex items-center justify-between pt-1">
            <button
              onClick={handleTest}
              disabled={testing || !currentUrl}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-medium transition-opacity hover:opacity-80 disabled:opacity-30"
              style={{ background: "#EDE7D7", border: "1px solid #EDE7D7", color: "#6B6B64" }}>
              <Send size={12} />
              {testing ? "Sending…" : "Send test message"}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-[12px] font-semibold transition-opacity hover:opacity-80 disabled:opacity-50"
              style={{ background: "linear-gradient(135deg, #0F5F5C, #083A38)", color: "#F5F1E8" }}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ConnectorsSection;
