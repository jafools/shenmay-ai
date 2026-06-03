import { useState, useEffect } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { useShenmayAuth } from "@/contexts/ShenmayAuthContext";
import { getMe, updateCompany, updatePrivacySettings, updateAnonymousOnlyMode, getProducts, addProduct, updateProduct, deleteProduct, getDataApiKey, generateDataApiKey, revokeDataApiKey, getAgentSoul, generateSoul, getWebhooks, createWebhook, updateWebhook, deleteWebhook, testWebhook, getLabels, createLabel, updateLabel, deleteLabel, getConnectors, updateConnectors, testSlack, testTeams, getEmailTemplates, updateEmailTemplates } from "@/lib/shenmayApi";
import { toast } from "@/hooks/use-toast";
import { Copy, Check, Plus, Trash2, Pencil, X, ChevronUp, Key, AlertTriangle, RefreshCw, Eye, EyeOff, Brain, Sparkles, Shield, MessageSquare, Webhook, ToggleLeft, ToggleRight, Send, ChevronDown, Tag, Plug2, Zap, Mail } from "lucide-react";
import { Link } from "react-router-dom";
import { TOKENS as T, Kicker, Display, Lede } from "@/components/shenmay/ui/ShenmayUI";


import { card, inputClass, inputStyle } from "./_shared";

const ALL_EVENTS = [
  { value: "session.started",  label: "Session started" },
  { value: "session.ended",    label: "Session ended" },
  { value: "customer.created", label: "Customer created" },
  { value: "flag.created",     label: "Flag created" },
  { value: "concern.raised",   label: "Concern raised" },
];

const WebhooksSection = () => {
  const [hooks, setHooks]             = useState([]);
  const [loading, setLoading]         = useState(true);
  const [showForm, setShowForm]       = useState(false);
  const [form, setForm]               = useState({ label: "", url: "", event_types: ["flag.created", "concern.raised"] });
  const [saving, setSaving]           = useState(false);
  const [newSecret, setNewSecret]     = useState(null);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [editingId, setEditingId]     = useState(null);
  const [editForm, setEditForm]       = useState({});
  const [editSaving, setEditSaving]   = useState(false);
  const [testing, setTesting]         = useState({});
  const [deleting, setDeleting]       = useState({});
  const [toggling, setToggling]       = useState({});

  const load = async () => {
    try {
      const data = await getWebhooks();
      setHooks(data.webhooks || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggleEvent = (arr, val) =>
    arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val];

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.url.trim()) {
      toast({ title: "Endpoint URL is required", variant: "destructive" }); return;
    }
    if (form.event_types.length === 0) {
      toast({ title: "Select at least one event", variant: "destructive" }); return;
    }
    setSaving(true);
    try {
      const data = await createWebhook(form);
      setNewSecret(data.secret);
      setShowForm(false);
      setForm({ label: "", url: "", event_types: ["flag.created", "concern.raised"] });
      toast({ title: "Webhook registered" });
      await load();
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (h) => {
    setEditingId(h.id);
    setEditForm({ label: h.label || "", url: h.url || "", event_types: h.event_types || [] });
  };

  const handleEditSave = async () => {
    if (!editForm.url.trim()) {
      toast({ title: "Endpoint URL is required", variant: "destructive" }); return;
    }
    if (editForm.event_types.length === 0) {
      toast({ title: "Select at least one event", variant: "destructive" }); return;
    }
    setEditSaving(true);
    try {
      await updateWebhook(editingId, editForm);
      setEditingId(null);
      toast({ title: "Webhook updated" });
      await load();
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setEditSaving(false);
    }
  };

  const handleToggle = async (h) => {
    setToggling(t => ({ ...t, [h.id]: true }));
    try {
      await updateWebhook(h.id, { enabled: !h.enabled });
      await load();
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setToggling(t => ({ ...t, [h.id]: false }));
    }
  };

  const handleDelete = async (id) => {
    setDeleting(d => ({ ...d, [id]: true }));
    try {
      await deleteWebhook(id);
      toast({ title: "Webhook removed" });
      await load();
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setDeleting(d => ({ ...d, [id]: false }));
    }
  };

  const handleTest = async (id) => {
    setTesting(t => ({ ...t, [id]: true }));
    try {
      await testWebhook(id);
      toast({ title: "Test ping sent", description: "Check your endpoint for the test.ping event." });
    } catch (err) {
      toast({ title: "Test failed", description: err.message, variant: "destructive" });
    } finally {
      setTesting(t => ({ ...t, [id]: false }));
    }
  };

  const copySecret = () => {
    copyToClipboard(newSecret);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 2000);
  };

  const relativeTime = (ts) => {
    if (!ts) return null;
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <div className="rounded-2xl p-6 space-y-5" style={card}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[#3A3D39]">Webhooks</h3>
          <p className="text-[11px] mt-0.5" style={{ color: "#6B6B64" }}>
            Receive signed POST requests when events occur in your account.
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => { setShowForm(true); setNewSecret(null); }}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all hover:opacity-90"
            style={{ background: "linear-gradient(135deg, #0F5F5C, #083A38)", color: "#F5F1E8" }}
          >
            <Plus size={13} /> Add webhook
          </button>
        )}
      </div>

      {/* One-time secret reveal */}
      {newSecret && (
        <div className="rounded-xl p-4 space-y-3" style={{ background: "rgba(15,95,92,0.06)", border: "1px solid rgba(15,95,92,0.25)" }}>
          <div className="flex items-center gap-2">
            <AlertTriangle size={13} style={{ color: "#A6660E" }} />
            <p className="text-[12px] font-semibold" style={{ color: "#A6660E" }}>
              Copy your signing secret now — it won't be shown again
            </p>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={newSecret}
              className="flex-1 px-3 py-2 rounded-xl text-xs font-mono focus:outline-none"
              style={inputStyle}
            />
            <button
              onClick={copySecret}
              className="px-3 py-2 rounded-xl text-sm font-medium flex items-center gap-1.5"
              style={{ border: "1px solid #EDE7D7", color: "#6B6B64" }}
            >
              {copiedSecret ? <><Check size={13} style={{ color: "#2D6A4F" }} /> Copied</> : <><Copy size={13} /> Copy</>}
            </button>
          </div>
          <p className="text-[11px]" style={{ color: "#6B6B64" }}>
            Verify the <code style={{ color: "#6B6B64" }}>X-Shenmay-Signature</code> header on incoming requests using HMAC-SHA256.
          </p>
        </div>
      )}

      {/* Add form */}
      {showForm && (
        <div className="rounded-xl p-4 space-y-4" style={{ background: "#EDE7D7", border: "1px solid #EDE7D7" }}>
          <p className="text-[12px] font-semibold text-[#3A3D39]">New webhook</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label htmlFor="wh-add-label" className="block text-[11px] font-medium text-[#6B6B64] mb-1">Label</label>
              <input
                id="wh-add-label"
                type="text"
                placeholder="e.g. Slack alerts"
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                className={inputClass}
                style={inputStyle}
              />
            </div>
            <div>
              <label htmlFor="wh-add-url" className="block text-[11px] font-medium text-[#6B6B64] mb-1">Endpoint URL <span style={{ color: "#0F5F5C" }}>*</span></label>
              <input
                id="wh-add-url"
                type="url"
                required
                placeholder="https://your-server.com/hooks/shenmay"
                value={form.url}
                onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                className={inputClass}
                style={inputStyle}
              />
            </div>
          </div>
          <div>
            <div className="block text-[11px] font-medium text-[#6B6B64] mb-2">Events to send</div>
            <div className="flex flex-wrap gap-2">
              {ALL_EVENTS.map(ev => {
                const on = form.event_types.includes(ev.value);
                return (
                  <button
                    key={ev.value}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, event_types: toggleEvent(f.event_types, ev.value) }))}
                    className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
                    style={{
                      background: on ? "rgba(15,95,92,0.15)" : "#EDE7D7",
                      border: `1px solid ${on ? "rgba(15,95,92,0.4)" : "#EDE7D7"}`,
                      color: on ? "#0F5F5C" : "#6B6B64",
                    }}
                  >
                    {ev.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleCreate}
              disabled={saving}
              className="px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 transition-all hover:opacity-90"
              style={{ background: "linear-gradient(135deg, #0F5F5C, #083A38)", color: "#F5F1E8" }}
            >
              {saving ? "Saving…" : "Create webhook"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 rounded-xl text-sm font-medium"
              style={{ border: "1px solid #EDE7D7", color: "#6B6B64" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="h-16 rounded-xl animate-pulse" style={{ background: "#EDE7D7" }} />
          ))}
        </div>
      ) : hooks.length === 0 ? (
        <div className="py-8 text-center">
          <Webhook size={28} className="mx-auto mb-3" style={{ color: "#D8D0BD" }} />
          <p className="text-sm" style={{ color: "#6B6B64" }}>No webhooks yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {hooks.map(h => (
            <div key={h.id} className="rounded-xl p-4 space-y-3" style={{ background: "#EDE7D7", border: "1px solid #EDE7D7" }}>
              {editingId === h.id ? (
                /* inline edit form */
                <div className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={`wh-edit-label-${h.id}`} className="block text-[11px] font-medium text-[#6B6B64] mb-1">Label</label>
                      <input id={`wh-edit-label-${h.id}`} type="text" value={editForm.label} onChange={e => setEditForm(f => ({ ...f, label: e.target.value }))} className={inputClass} style={inputStyle} />
                    </div>
                    <div>
                      <label htmlFor={`wh-edit-url-${h.id}`} className="block text-[11px] font-medium text-[#6B6B64] mb-1">Endpoint URL</label>
                      <input id={`wh-edit-url-${h.id}`} type="url" value={editForm.url} onChange={e => setEditForm(f => ({ ...f, url: e.target.value }))} className={inputClass} style={inputStyle} />
                    </div>
                  </div>
                  <div>
                    <div className="block text-[11px] font-medium text-[#6B6B64] mb-2">Events</div>
                    <div className="flex flex-wrap gap-2">
                      {ALL_EVENTS.map(ev => {
                        const on = editForm.event_types?.includes(ev.value);
                        return (
                          <button
                            key={ev.value}
                            type="button"
                            onClick={() => setEditForm(f => ({ ...f, event_types: toggleEvent(f.event_types || [], ev.value) }))}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
                            style={{
                              background: on ? "rgba(15,95,92,0.15)" : "#EDE7D7",
                              border: `1px solid ${on ? "rgba(15,95,92,0.4)" : "#EDE7D7"}`,
                              color: on ? "#0F5F5C" : "#6B6B64",
                            }}
                          >
                            {ev.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={handleEditSave} disabled={editSaving} className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50" style={{ background: "linear-gradient(135deg, #0F5F5C, #083A38)", color: "#F5F1E8" }}>
                      {editSaving ? "Saving…" : "Save"}
                    </button>
                    <button onClick={() => setEditingId(null)} className="px-3 py-1.5 rounded-lg text-xs font-medium" style={{ border: "1px solid #EDE7D7", color: "#6B6B64" }}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                /* read view */
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[13px] font-semibold text-[#1A1D1A] truncate">{h.label}</span>
                        <span
                          className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                          style={h.enabled
                            ? { background: "rgba(45,106,79,0.1)", color: "#2D6A4F" }
                            : { background: "#EDE7D7", color: "#6B6B64" }}
                        >
                          {h.enabled ? "Active" : "Paused"}
                        </span>
                        {h.consecutive_failures >= 3 && (
                          <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: "rgba(122,31,26,0.1)", color: "#7A1F1A" }}>
                            {h.consecutive_failures} failures
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] font-mono truncate" style={{ color: "#6B6B64" }}>{h.url}</p>
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {(h.event_types || []).map(ev => (
                          <span key={ev} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: "rgba(15,95,92,0.08)", color: "rgba(15,95,92,0.6)", border: "1px solid rgba(15,95,92,0.15)" }}>
                            {ev}
                          </span>
                        ))}
                      </div>
                      {h.last_triggered_at && (
                        <p className="text-[10px] mt-1.5" style={{ color: "#6B6B64" }}>
                          Last triggered {relativeTime(h.last_triggered_at)}
                          {h.last_success_at && ` · Success ${relativeTime(h.last_success_at)}`}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => handleToggle(h)}
                        disabled={toggling[h.id]}
                        title={h.enabled ? "Pause" : "Enable"}
                        className="p-1.5 rounded-lg transition-colors hover:bg-white/5 disabled:opacity-50"
                        style={{ color: h.enabled ? "#2D6A4F" : "#6B6B64" }}
                      >
                        {h.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                      </button>
                      <button
                        onClick={() => handleTest(h.id)}
                        disabled={testing[h.id] || !h.enabled}
                        title="Send test ping"
                        className="p-1.5 rounded-lg transition-colors hover:bg-white/5 disabled:opacity-40"
                        style={{ color: "#6B6B64" }}
                      >
                        <Send size={13} />
                      </button>
                      <button
                        onClick={() => startEdit(h)}
                        aria-label="Edit webhook"
                        title="Edit webhook"
                        className="p-1.5 rounded-lg transition-colors hover:bg-white/5"
                        style={{ color: "#6B6B64" }}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => handleDelete(h.id)}
                        disabled={deleting[h.id]}
                        aria-label="Delete webhook"
                        title="Delete webhook"
                        className="p-1.5 rounded-lg transition-colors hover:bg-white/5 disabled:opacity-50"
                        style={{ color: "rgba(122,31,26,0.5)" }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="pt-1" style={{ borderTop: "1px solid #EDE7D7" }}>
        <p className="text-[11px]" style={{ color: "#6B6B64" }}>
          All payloads are signed with HMAC-SHA256. Verify using the <code style={{ color: "#6B6B64" }}>X-Shenmay-Signature</code> header.
          Endpoints must respond within 10 seconds. One automatic retry after 3s on failure.
        </p>
      </div>
    </div>
  );
};

export default WebhooksSection;
