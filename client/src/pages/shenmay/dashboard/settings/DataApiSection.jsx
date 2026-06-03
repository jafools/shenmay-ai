import { useState, useEffect } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { useShenmayAuth } from "@/contexts/ShenmayAuthContext";
import { getMe, updateCompany, updatePrivacySettings, updateAnonymousOnlyMode, getProducts, addProduct, updateProduct, deleteProduct, getDataApiKey, generateDataApiKey, revokeDataApiKey, getAgentSoul, generateSoul, getWebhooks, createWebhook, updateWebhook, deleteWebhook, testWebhook, getLabels, createLabel, updateLabel, deleteLabel, getConnectors, updateConnectors, testSlack, testTeams, getEmailTemplates, updateEmailTemplates } from "@/lib/shenmayApi";
import { toast } from "@/hooks/use-toast";
import { Copy, Check, Plus, Trash2, Pencil, X, ChevronUp, Key, AlertTriangle, RefreshCw, Eye, EyeOff, Brain, Sparkles, Shield, MessageSquare, Webhook, ToggleLeft, ToggleRight, Send, ChevronDown, Tag, Plug2, Zap, Mail } from "lucide-react";
import { Link } from "react-router-dom";
import { TOKENS as T, Kicker, Display, Lede } from "@/components/shenmay/ui/ShenmayUI";


import { card, inputClass, inputStyle } from "./_shared";

const DataApiSection = () => {
  const [keyInfo, setKeyInfo]     = useState(null);   // { has_key, prefix }
  const [loading, setLoading]     = useState(true);
  const [newKey, setNewKey]       = useState(null);   // shown ONCE after generation
  const [showKey, setShowKey]     = useState(false);
  const [copied, setCopied]       = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking]   = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const load = async () => {
    try { setKeyInfo(await getDataApiKey()); }
    catch { /* not critical */ }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleGenerate = async () => {
    setGenerating(true);
    setNewKey(null);
    try {
      const res = await generateDataApiKey();
      setNewKey(res.key);
      setShowKey(true);
      await load();
      toast({ title: "Data API key generated", description: "Copy it now — it won't be shown again." });
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally { setGenerating(false); }
  };

  const handleRevoke = async () => {
    setRevoking(true);
    try {
      await revokeDataApiKey();
      setKeyInfo({ has_key: false, prefix: null });
      setNewKey(null);
      setConfirmRevoke(false);
      toast({ title: "API key revoked", description: "Any integrations using it have stopped working." });
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally { setRevoking(false); }
  };

  const copy = (text, setter) => {
    copyToClipboard(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  };

  const exampleSnippet = `curl -X POST https://shenmay.ai/api/v1/customers \\
  -H "Authorization: Bearer YOUR_DATA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "external_id": "client-123",
    "name": "Jane Smith",
    "email": "jane@example.com"
  }'

# Push data records for that client:
curl -X POST https://shenmay.ai/api/v1/customers/client-123/records \\
  -H "Authorization: Bearer YOUR_DATA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "records": [
      { "category": "portfolio", "label": "Total Value", "value": "450000" },
      { "category": "goals",     "label": "Retirement Target", "value": "1200000" }
    ]
  }'`;

  return (
    <div className="rounded-2xl p-6 space-y-5" style={card}>
      <div className="flex items-center gap-3">
        <Key size={16} style={{ color: "#A78BFA" }} />
        <h3 className="text-sm font-semibold text-[#3A3D39]">Data API</h3>
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "rgba(167,139,250,0.1)", color: "#A78BFA" }}>
          For developers
        </span>
      </div>

      <p className="text-[13px] text-[#6B6B64] leading-relaxed">
        Push customer data directly from your own system — no file uploads needed.
        Your data stays in your CRM; Shenmay reads it at query time. Use this if your
        company's IT team wants to automate the data sync.
      </p>

      {/* Three-model explainer */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          { icon: "📤", label: "CSV Upload", desc: "Upload a spreadsheet from your computer. Good for manual one-time imports.", nav: "/dashboard/customers", navLabel: "Go to Customers" },
          { icon: "🔌", label: "Data API", desc: "Push data programmatically. Set it up once; it syncs automatically.", active: true },
          { icon: "🔗", label: "Live Connector", desc: "Shenmay calls your system in real time. Data never leaves your servers.", nav: "/dashboard/tools", navLabel: "Set up in Tools →" },
        ].map((m) => (
          <div key={m.label} className="rounded-xl p-4" style={{ background: m.active ? "rgba(167,139,250,0.06)" : "#EDE7D7", border: `1px solid ${m.active ? "rgba(167,139,250,0.2)" : "#EDE7D7"}` }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">{m.icon}</span>
              <span className="text-[12px] font-semibold text-[#3A3D39]">{m.label}</span>
              {m.active && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full ml-auto" style={{ background: "rgba(167,139,250,0.15)", color: "#A78BFA" }}>You are here</span>}
            </div>
            <p className="text-[11px] text-[#6B6B64] leading-relaxed">{m.desc}</p>
            {m.nav && <Link to={m.nav} className="text-[11px] font-medium mt-2 inline-block hover:underline" style={{ color: "#0F5F5C" }}>{m.navLabel}</Link>}
          </div>
        ))}
      </div>

      {/* Key status */}
      {loading ? (
        <div className="h-10 rounded-xl animate-pulse" style={{ background: "#EDE7D7" }} />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-[12px] font-medium text-[#6B6B64] mb-1">API Key Status</p>
              {keyInfo?.has_key ? (
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold" style={{ background: "rgba(45,106,79,0.12)", color: "#2D6A4F" }}>
                    <Check size={11} /> Active
                  </span>
                  <span className="text-[12px] font-mono text-[#6B6B64]">{keyInfo.prefix}</span>
                </div>
              ) : (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold" style={{ background: "#EDE7D7", color: "#6B6B64" }}>
                  No key generated
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #0F5F5C, #083A38)", color: "#F5F1E8" }}
              >
                <RefreshCw size={13} className={generating ? "animate-spin" : ""} />
                {keyInfo?.has_key ? "Rotate Key" : "Generate Key"}
              </button>
              {keyInfo?.has_key && !confirmRevoke && (
                <button
                  onClick={() => setConfirmRevoke(true)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium transition-colors"
                  style={{ border: "1px solid rgba(248,113,113,0.3)", color: "#7A1F1A" }}
                >
                  <Trash2 size={13} /> Revoke
                </button>
              )}
              {confirmRevoke && (
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-[#6B6B64]">Confirm revoke?</span>
                  <button onClick={handleRevoke} disabled={revoking} className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: "rgba(248,113,113,0.15)", color: "#7A1F1A" }}>
                    {revoking ? "Revoking…" : "Yes, revoke"}
                  </button>
                  <button onClick={() => setConfirmRevoke(false)} className="px-3 py-1.5 rounded-lg text-xs font-medium text-[#6B6B64] hover:text-[#3A3D39]">Cancel</button>
                </div>
              )}
            </div>
          </div>

          {/* New key — shown once */}
          {newKey && (
            <div className="rounded-xl p-4 space-y-3" style={{ background: "rgba(15,95,92,0.06)", border: "1px solid rgba(15,95,92,0.25)" }}>
              <div className="flex items-center gap-2">
                <AlertTriangle size={14} style={{ color: "#A6660E" }} />
                <p className="text-[12px] font-semibold" style={{ color: "#A6660E" }}>Copy this key now — it won't be shown again</p>
              </div>
              <div className="flex gap-2">
                <input
                  type={showKey ? "text" : "password"}
                  readOnly
                  value={newKey}
                  className="flex-1 px-3 py-2 rounded-xl text-xs font-mono focus:outline-none"
                  style={inputStyle}
                />
                <button onClick={() => setShowKey(v => !v)} className="px-2.5 py-2 rounded-xl transition-colors" style={{ border: "1px solid #EDE7D7", color: "#6B6B64" }}>
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button onClick={() => copy(newKey, setCopied)} className="px-3 py-2 rounded-xl text-sm font-medium flex items-center gap-1.5" style={{ border: "1px solid #EDE7D7", color: "#6B6B64" }}>
                  {copied ? <><Check size={13} style={{ color: "#2D6A4F" }} /> Copied</> : <><Copy size={13} /> Copy</>}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Code snippet */}
      <div>
        <p className="text-[12px] font-medium text-[#6B6B64] mb-2">Example API calls</p>
        <div className="relative">
          <pre className="p-4 rounded-xl text-[11px] font-mono overflow-x-auto whitespace-pre" style={{ background: "#EDE7D7", border: "1px solid #EDE7D7", color: "#6B6B64", lineHeight: "1.6" }}>{exampleSnippet}</pre>
          <button onClick={() => copy(exampleSnippet, setCopiedSnippet)} className="absolute top-2 right-2 px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors" style={{ background: "#EDE7D7", border: "1px solid #EDE7D7", color: "#6B6B64" }}>
            {copiedSnippet ? <><Check size={11} style={{ color: "#2D6A4F" }} /> Copied</> : <><Copy size={11} /> Copy</>}
          </button>
        </div>
        <p className="text-[11px] mt-2 text-[#6B6B64]">Full API reference: <a href="https://github.com/jafools/shenmay-ai/blob/main/docs/DATA-API.md" target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: "#0F5F5C" }}>github.com/jafools/shenmay-ai/docs/DATA-API.md</a></p>
      </div>
    </div>
  );
};

export default DataApiSection;
