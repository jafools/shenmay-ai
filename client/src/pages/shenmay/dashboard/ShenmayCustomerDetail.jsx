import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { getCustomer, deleteCustomer, exportCustomerData, getCustomerData, addCustomerDataRecord, deleteCustomerCategory, deleteCustomerRecord, triggerMemorySummary } from "@/lib/shenmayApi";
import { useShenmayAuth } from "@/contexts/ShenmayAuthContext";
import { toast } from "@/hooks/use-toast";
import { ArrowLeft, RefreshCw, AlertTriangle, User, MessageSquare, Trash2, Brain, BookOpen, Database, Plus, X, ChevronDown, ChevronRight, Tag, Target, Zap, Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TOKENS as T, Kicker, Display, Lede, Button } from "@/components/shenmay/ui/ShenmayUI";

const statusStyle = {
  complete:    { bg: "rgba(45,106,79,0.12)", color: "#2D6A4F", label: "Complete" },
  in_progress: { bg: "rgba(59,130,246,0.12)", color: "#60A5FA", label: "In Progress" },
  pending:     { bg: "rgba(245,158,11,0.12)", color: "#A6660E", label: "Pending" },
  new:         { bg: "#EDE7D7",                color: "#6B6B64", label: "New" },
};

const fmtDate = (d) => d ? new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "Never";

const card = { background: "#EDE7D7", border: "1px solid #EDE7D7" };

const ShenmayCustomerDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { shenmayTenant } = useShenmayAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const pollRef = useRef(null);

  const loadData = useCallback((silent = false) => {
    if (!silent) { setLoading(true); setError(null); }
    return getCustomer(id)
      .then((d) => { setData(d); setLastRefreshed(new Date()); })
      .catch((e) => { if (!silent) setError(e.message); })
      .finally(() => { if (!silent) setLoading(false); });
  }, [id]);

  // Initial load
  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh soul/memory every 20s so updates propagate without manual reload
  useEffect(() => {
    pollRef.current = setInterval(() => { loadData(true); }, 20000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadData]);

  // Also refresh when tab becomes visible again (user switches back)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        loadData(true);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [loadData]);

  // Expose manual refresh for error retry button
  const fetch = useCallback(() => loadData(false), [loadData]);

  if (loading) {
    return (
      <div className="space-y-6">
        {[120, 200, 160].map((h, i) => (
          <div key={i} className="rounded-2xl animate-pulse" style={{ ...card, height: h }} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "72px 0", textAlign: "center" }}>
        <div style={{ width: 54, height: 54, borderRadius: "50%", background: "#F3E8E4", border: `1px solid ${T.danger}33`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <AlertTriangle size={24} color={T.danger} />
        </div>
        <Lede style={{ marginTop: 0 }}>{error}</Lede>
        <Button variant="primary" onClick={fetch}><RefreshCw size={14} /> Retry</Button>
      </div>
    );
  }

  const customer = data?.customer || data || {};
  const soul = customer.soul_file;
  const memory = customer.memory_file;
  const conversations = customer.conversations || [];
  const st = statusStyle[customer.onboarding_status] || statusStyle.new;
  const initials = `${(customer.first_name?.[0] || "").toUpperCase()}${(customer.last_name?.[0] || "").toUpperCase()}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Back + refresh indicator */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={() => navigate("/dashboard/customers")} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: T.mute, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: T.sans }}>
          <ArrowLeft size={15} /> All customers
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {lastRefreshed && (
            <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: "0.1em", color: T.mute, textTransform: "uppercase" }}>
              Updated {lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button onClick={fetch} title="Refresh now" style={{ padding: 6, borderRadius: 4, background: "none", border: "none", color: T.mute, cursor: "pointer" }}>
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* Header Card */}
      <div style={{ background: "#FFFFFF", border: `1px solid ${T.paperEdge}`, borderRadius: 10, padding: 24, display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ width: 54, height: 54, borderRadius: "50%", background: `${T.teal}15`, color: T.teal, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 500, flexShrink: 0 }}>
          {initials || <User size={22} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Kicker color={T.mute}>Customer</Kicker>
          <div style={{ fontFamily: T.sans, fontWeight: 500, fontSize: 18, letterSpacing: "-0.015em", color: T.ink, margin: "4px 0 2px" }}>
            {customer.first_name} {customer.last_name}
          </div>
          <div style={{ fontSize: 13, color: T.mute }}>{customer.email}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", padding: "4px 10px", borderRadius: 3, background: `${st.color}18`, color: st.color }}>
            {st.label}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: "0.08em", color: T.mute, textTransform: "uppercase" }}>
            Last seen {fmtDate(customer.last_interaction_at)}
          </span>
        </div>
      </div>

      {/* Soul — everything the agent has learned about this customer */}
      <SoulSection soul={soul} memory={memory} />

      {/* Memory — conversation history */}
      <MemorySection memory={memory} />

      {/* Conversations */}
      <div className="rounded-2xl p-6" style={card}>
        <h3 className="text-sm font-semibold text-[#3A3D39] mb-3 flex items-center gap-2">
          <MessageSquare size={14} /> Conversations
        </h3>
        {conversations.length > 0 ? (
          <div className="space-y-1">
            {conversations.map((c) => (
              <ConversationRow key={c.id} conversation={c} onSynced={fetch} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-[#6B6B64] italic">No conversations yet.</p>
        )}
      </div>

      {/* Customer Data Records */}
      <CustomerDataSection customerId={id} />

      {/* Export Customer Data (GDPR Art. 20 — Data Portability) */}
      <ExportCustomerCard customerId={id} customerName={`${customer.first_name || ""} ${customer.last_name || ""}`.trim()} />

      {/* Delete Customer Data */}
      <DeleteCustomerCard customerId={id} navigate={navigate} />
    </div>
  );
};

// ── Soul Section ──────────────────────────────────────────────────────────────
// Everything the agent has learned about this customer — who they are, how to
// talk to them, their goals and concerns. Drives the agent's behavior.

const SoulSection = ({ soul, memory }) => {
  const profile     = memory?.personal_profile || {};
  const family      = profile.family || {};
  const soulProfile = soul?.personal_profile || {};
  const plan        = memory?.life_plan || memory?.goals || {};
  const goals       = plan.goals    || [];
  const concerns    = plan.concerns || [];
  const history     = memory?.conversation_history || [];
  const lastSession = history[history.length - 1];
  const actionItems = lastSession?.action_items || [];
  const agentNotes  = memory?.agent_notes || [];

  const bioFields = [
    { label: "Age",           value: profile.age },
    { label: "Location",      value: profile.location },
    { label: "Career",        value: profile.career },
    { label: "Tech Comfort",  value: profile.tech_comfort },
    { label: "Communication", value: profile.communication_preference },
    { label: "Marital Status",value: family.marital_status },
  ].filter(f => f.value);

  const hasFamily = family.spouse || family.children?.length > 0 || family.late_spouse;

  const personalityKeys = ["interests", "preferences", "personality_traits", "life_details"];
  const hasPersonality  = personalityKeys.some(k => soulProfile[k]?.length > 0);

  const hasGoals   = goals.length > 0 || concerns.length > 0 || actionItems.length > 0;
  const hasContent = bioFields.length > 0 || hasFamily || hasPersonality || hasGoals || agentNotes.length > 0;

  return (
    <div className="rounded-2xl p-6 space-y-5" style={card}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#3A3D39] flex items-center gap-2">
          <Brain size={14} style={{ color: "#0F5F5C" }} /> Soul
        </h3>
        <span className="text-[11px] text-[#6B6B64]">What the agent has learned about this customer</span>
      </div>

      {!hasContent ? (
        <p className="text-sm text-[#6B6B64] italic">No soul data yet — the agent is still getting to know this customer.</p>
      ) : (
        <>
          {/* Biographical facts */}
          {(bioFields.length > 0 || hasFamily) && (
            <div>
              <p className="text-[11px] font-semibold text-[#6B6B64] uppercase tracking-wider mb-2">About This Person</p>
              {bioFields.length > 0 && (
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 mb-3">
                  {bioFields.map(({ label, value }) => (
                    <div key={label}>
                      <span className="text-[11px] text-[#6B6B64] font-medium uppercase tracking-wide">{label}</span>
                      <p className="text-[13px] text-[#6B6B64] mt-0.5">{String(value)}</p>
                    </div>
                  ))}
                </div>
              )}
              {hasFamily && (
                <div className="space-y-1">
                  {family.spouse && (
                    <p className="text-[13px] text-[#6B6B64]">Spouse: {family.spouse.name}{family.spouse.age ? ` (${family.spouse.age})` : ""}{family.spouse.health_notes ? ` — ${family.spouse.health_notes}` : ""}</p>
                  )}
                  {family.late_spouse && (
                    <p className="text-[13px] text-[#6B6B64]">Late spouse: {family.late_spouse.name}{family.late_spouse.passed ? ` (passed ${family.late_spouse.passed})` : ""}</p>
                  )}
                  {family.children?.map((child, i) => (
                    <p key={i} className="text-[13px] text-[#6B6B64]">{child.name}{child.age ? ` (${child.age})` : ""}{child.location ? ` — ${child.location}` : ""}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Personality & style — how the agent should engage */}
          {hasPersonality && (
            <div>
              <p className="text-[11px] font-semibold text-[#6B6B64] uppercase tracking-wider mb-2">Personality & Style</p>
              <div className="space-y-2">
                {[
                  { key: "interests",         label: "Interests" },
                  { key: "preferences",       label: "Preferences" },
                  { key: "personality_traits",label: "Personality" },
                  { key: "life_details",      label: "Life Details" },
                ].map(({ key, label }) => {
                  const items = soulProfile[key];
                  if (!items || !Array.isArray(items) || items.length === 0) return null;
                  return (
                    <div key={key}>
                      <p className="text-[10px] text-[#6B6B64] uppercase tracking-wider mb-1">{label}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {items.map((item, i) => (
                          <span key={i} className="px-2.5 py-1 rounded-full text-[12px] font-medium" style={{ background: "rgba(15,95,92,0.1)", color: "#0F5F5C", border: "1px solid rgba(15,95,92,0.15)" }}>
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Goals & concerns */}
          {hasGoals && (
            <div>
              <p className="text-[11px] font-semibold text-[#6B6B64] uppercase tracking-wider mb-2">Goals & Concerns</p>
              <div className="space-y-2">
                {goals.length > 0 && (
                  <ul className="space-y-1">
                    {goals.map((g, i) => (
                      <li key={i} className="flex items-start gap-2 text-[13px] text-[#6B6B64]">
                        <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#FB923C", opacity: 0.6 }} />{g}
                      </li>
                    ))}
                  </ul>
                )}
                {concerns.length > 0 && (
                  <ul className="space-y-1">
                    {concerns.map((c, i) => (
                      <li key={i} className="flex items-start gap-2 text-[13px] text-[#6B6B64]">
                        <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#7A1F1A", opacity: 0.6 }} />{c}
                      </li>
                    ))}
                  </ul>
                )}
                {actionItems.length > 0 && (
                  <div>
                    <p className="text-[10px] text-[#6B6B64] uppercase tracking-wider mb-1">Open Action Items</p>
                    <ul className="space-y-1">
                      {actionItems.map((item, i) => (
                        <li key={i} className="flex items-start gap-2 text-[13px] text-[#6B6B64]">
                          <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#60A5FA", opacity: 0.6 }} />{item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Agent notes */}
          {agentNotes.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-[#6B6B64] uppercase tracking-wider mb-2">Agent Notes</p>
              <ul className="space-y-1">
                {agentNotes.map((note, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-[#6B6B64]">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#D8D0BD" }} />{note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
};


// ── Memory Section ────────────────────────────────────────────────────────────
// Past conversation summaries — what was discussed, giving the agent continuity.

const MemorySection = ({ memory }) => {
  const history = memory?.conversation_history || [];

  return (
    <div className="rounded-2xl p-6" style={card}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-[#3A3D39] flex items-center gap-2">
          <BookOpen size={14} style={{ color: "#60A5FA" }} /> Memory
        </h3>
        <span className="text-[11px] text-[#6B6B64]">Past conversation history</span>
      </div>
      {history.length > 0 ? (
        <div className="space-y-3">
          {history.map((entry, i) => (
            <div key={i} className="rounded-xl p-4" style={{ background: "#EDE7D7", border: "1px solid #EDE7D7" }}>
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <p className="text-[13px] font-semibold text-[#3A3D39]">
                  Session #{entry.session || i + 1}
                  {entry.date && <span className="text-[#6B6B64] font-normal"> — {new Date(entry.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>}
                </p>
                {entry.message_count != null && (
                  <span className="text-[11px] text-[#6B6B64]">{entry.message_count} messages</span>
                )}
              </div>
              {entry.summary && <p className="text-[13px] text-[#6B6B64] mb-2">{entry.summary}</p>}
              {entry.topics?.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {entry.topics.map((t, j) => (
                    <span key={j} className="px-2 py-0.5 rounded-full text-[11px] font-medium" style={{ background: "rgba(96,165,250,0.1)", color: "#60A5FA", border: "1px solid rgba(96,165,250,0.15)" }}>
                      {t.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[#6B6B64] italic">No memory yet — will populate after the first completed conversation.</p>
      )}
    </div>
  );
};


// ── Conversation Row ──────────────────────────────────────────────────────────
// Single conversation row with an inline "Sync Memory" button.

const ConversationRow = ({ conversation: c, onSynced }) => {
  const [syncing, setSyncing] = useState(false);

  const handleSync = async (e) => {
    e.preventDefault(); // prevent Link navigation
    e.stopPropagation();
    setSyncing(true);
    try {
      await triggerMemorySummary(c.id);
      toast({ title: "Memory sync queued", description: "Agent memory will update in the background." });
      setTimeout(() => onSynced?.(), 3000); // refresh detail after a moment
    } catch (err) {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex items-center gap-2" style={{ border: "1px solid #EDE7D7", borderRadius: "0.75rem" }}>
      <Link to={`/dashboard/conversations/${c.id}`} className="flex-1 flex items-center justify-between p-3 rounded-xl transition-colors hover:bg-[#F5F1E8]">
        <div className="text-sm">
          <span className="font-medium text-[#3A3D39]">{c.status}</span>
          <span className="text-[#6B6B64] ml-2">{c.message_count || 0} messages</span>
          {c.summary && <span className="text-[#6B6B64] ml-2 text-[12px]">{c.summary.substring(0, 60)}{c.summary.length > 60 ? "…" : ""}</span>}
        </div>
        <span className="text-[11px] text-[#6B6B64] ml-3 shrink-0">{fmtDate(c.created_at)}</span>
      </Link>
      <button
        onClick={handleSync}
        disabled={syncing}
        title="Sync memory from this conversation"
        className="mr-2 flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold transition-all hover:opacity-80 disabled:opacity-40"
        style={{ background: "rgba(167,139,250,0.1)", color: "#A78BFA", border: "1px solid rgba(167,139,250,0.15)" }}
      >
        <Zap size={10} />
        {syncing ? "…" : "Sync"}
      </button>
    </div>
  );
};


// ── Customer Data Section ─────────────────────────────────────────────────────

const CustomerDataSection = ({ customerId }) => {
  const [records, setRecords]           = useState({});    // { category: [rows] }
  const [total, setTotal]               = useState(0);
  const [loading, setLoading]           = useState(true);
  const [expanded, setExpanded]         = useState({});    // { category: bool }
  const [showAddForm, setShowAddForm]   = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null); // { type: 'category'|'record', category, label? }
  const [form, setForm]                 = useState({ category: "", label: "", value: "", value_type: "" });
  const [saving, setSaving]             = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getCustomerData(customerId);
      setRecords(d.records || {});
      setTotal(d.total || 0);
      const cats = Object.keys(d.records || {});
      setExpanded(cats.reduce((a, c) => ({ ...a, [c]: true }), {}));
    } catch (err) {
      toast({ title: "Failed to load data records", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  const toggleCategory = (cat) => setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!form.category.trim() || !form.label.trim()) {
      toast({ title: "Category and Label are required.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await addCustomerDataRecord(customerId, {
        category:   form.category.trim(),
        label:      form.label.trim(),
        value:      form.value.trim() || null,
        value_type: form.value_type.trim() || null,
      });
      toast({ title: "Record saved." });
      setForm({ category: "", label: "", value: "", value_type: "" });
      setShowAddForm(false);
      load();
    } catch (err) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      if (confirmDelete.type === "category") {
        await deleteCustomerCategory(customerId, confirmDelete.category);
        toast({ title: `Category "${confirmDelete.category}" cleared.` });
      } else {
        await deleteCustomerRecord(customerId, confirmDelete.category, confirmDelete.label);
        toast({ title: "Record deleted." });
      }
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
      setConfirmDelete(null);
    }
  };

  const categories = Object.keys(records);

  return (
    <>
      <div className="rounded-2xl p-6" style={card}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-[#3A3D39] flex items-center gap-2">
            <Database size={14} style={{ color: "#34D399" }} />
            Customer Data
            {total > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[11px]" style={{ background: "rgba(52,211,153,0.1)", color: "#34D399" }}>
                {total} record{total !== 1 ? "s" : ""}
              </span>
            )}
          </h3>
          <button
            onClick={() => setShowAddForm((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all hover:opacity-80"
            style={{ background: "rgba(52,211,153,0.1)", color: "#34D399", border: "1px solid rgba(52,211,153,0.15)" }}
          >
            <Plus size={12} /> Add Record
          </button>
        </div>

        {/* Add form */}
        {showAddForm && (
          <form onSubmit={handleAdd} className="rounded-xl p-4 mb-4 space-y-3" style={{ background: "#EDE7D7", border: "1px solid #EDE7D7" }}>
            <p className="text-[12px] font-semibold text-[#6B6B64] uppercase tracking-wider">New Record</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="cd-record-category" className="block text-[11px] text-[#6B6B64] mb-1">Category <span className="text-red-400">*</span></label>
                <input
                  id="cd-record-category"
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  placeholder="e.g. portfolio, goals"
                  className="w-full rounded-lg px-3 py-2 text-sm text-[#1A1D1A] bg-transparent outline-none"
                  style={{ background: "#FFFFFF", border: "1px solid #D8D0BD" }}
                />
              </div>
              <div>
                <label htmlFor="cd-record-label" className="block text-[11px] text-[#6B6B64] mb-1">Label <span className="text-red-400">*</span></label>
                <input
                  id="cd-record-label"
                  value={form.label}
                  onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="e.g. Account Balance"
                  className="w-full rounded-lg px-3 py-2 text-sm text-[#1A1D1A] bg-transparent outline-none"
                  style={{ background: "#FFFFFF", border: "1px solid #D8D0BD" }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="cd-record-value" className="block text-[11px] text-[#6B6B64] mb-1">Value</label>
                <input
                  id="cd-record-value"
                  value={form.value}
                  onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                  placeholder="e.g. $245,000"
                  className="w-full rounded-lg px-3 py-2 text-sm text-[#1A1D1A] bg-transparent outline-none"
                  style={{ background: "#FFFFFF", border: "1px solid #D8D0BD" }}
                />
              </div>
              <div>
                <label htmlFor="cd-record-value-type" className="block text-[11px] text-[#6B6B64] mb-1">Type</label>
                <input
                  id="cd-record-value-type"
                  value={form.value_type}
                  onChange={(e) => setForm((f) => ({ ...f, value_type: e.target.value }))}
                  placeholder="currency / date / text"
                  className="w-full rounded-lg px-3 py-2 text-sm text-[#1A1D1A] bg-transparent outline-none"
                  style={{ background: "#FFFFFF", border: "1px solid #D8D0BD" }}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowAddForm(false)} className="px-3 py-1.5 rounded-lg text-xs text-[#6B6B64] hover:text-[#6B6B64]">Cancel</button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
                style={{ background: "rgba(52,211,153,0.15)", color: "#34D399", border: "1px solid rgba(52,211,153,0.2)" }}
              >
                {saving ? "Saving…" : "Save Record"}
              </button>
            </div>
          </form>
        )}

        {/* Records */}
        {loading ? (
          <div className="space-y-2">
            {[1,2].map((i) => <div key={i} className="h-10 rounded-lg animate-pulse" style={{ background: "#EDE7D7" }} />)}
          </div>
        ) : categories.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-[#6B6B64] italic">No data records yet.</p>
            <p className="text-xs text-[#D8D0BD] mt-1">Add records manually above, or push data via the Data API.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {categories.map((cat) => (
              <div key={cat} className="rounded-xl overflow-hidden" style={{ border: "1px solid #EDE7D7" }}>
                {/* Category header */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={!!expanded[cat]}
                  className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-[#F5F1E8] transition-colors"
                  onClick={() => toggleCategory(cat)}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCategory(cat); } }}
                  style={{ background: "#EDE7D7" }}
                >
                  <div className="flex items-center gap-2">
                    {expanded[cat] ? <ChevronDown size={13} className="text-[#6B6B64]" /> : <ChevronRight size={13} className="text-[#6B6B64]" />}
                    <span className="text-[13px] font-semibold text-[#3A3D39] capitalize">{cat.replace(/_/g, " ")}</span>
                    <span className="text-[11px] text-[#6B6B64]">{records[cat]?.length} record{records[cat]?.length !== 1 ? "s" : ""}</span>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete({ type: "category", category: cat }); }}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] transition-all hover:opacity-80"
                    style={{ color: "rgba(248,113,113,0.6)", background: "rgba(122,31,26,0.05)" }}
                    title="Clear all records in this category"
                  >
                    <Trash2 size={11} /> Clear
                  </button>
                </div>

                {/* Records */}
                {expanded[cat] && (
                  <div className="divide-y" style={{ borderColor: "#EDE7D7" }}>
                    {(records[cat] || []).map((rec, i) => (
                      <div key={i} className="flex items-center justify-between px-4 py-2.5 group hover:bg-white/[0.01]">
                        <div className="flex items-center gap-3 min-w-0">
                          <Tag size={11} className="shrink-0 text-[#6B6B64]" />
                          <div className="min-w-0">
                            <span className="text-[13px] text-[#6B6B64] truncate">{rec.label}</span>
                            {rec.source && rec.source !== "portal" && (
                              <span className="ml-2 text-[10px] text-[#6B6B64]">[{rec.source}]</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          {rec.value != null && (
                            <span className="text-[13px] font-medium text-[#3A3D39]">{rec.value}</span>
                          )}
                          <button
                            onClick={() => setConfirmDelete({ type: "record", category: cat, label: rec.label })}
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-lg hover:bg-red-500/10"
                            style={{ color: "rgba(248,113,113,0.5)" }}
                            title="Delete this record"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Confirm delete modal */}
      {confirmDelete && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Close dialog"
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
          onClick={() => setConfirmDelete(null)}
          onKeyDown={e => { if (e.key === "Escape" || e.key === "Enter" || e.key === " ") { e.preventDefault(); setConfirmDelete(null); } }}
        >
          <div
            role="presentation"
            className="rounded-2xl p-6 max-w-sm w-full mx-4"
            style={{ background: "#EDE7D7", border: "1px solid #EDE7D7" }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "rgba(122,31,26,0.1)" }}>
                <Trash2 size={18} style={{ color: "#7A1F1A" }} />
              </div>
              <h3 className="text-base font-semibold text-[#1A1D1A]">
                {confirmDelete.type === "category" ? `Clear "${confirmDelete.category}"?` : "Delete record?"}
              </h3>
            </div>
            <p className="text-sm text-[#6B6B64] mb-6">
              {confirmDelete.type === "category"
                ? (() => {
                    const n = records[confirmDelete.category]?.length || 0;
                    return `This will delete all ${n} record${n !== 1 ? "s" : ""} in the "${confirmDelete.category}" category.`;
                  })()
                : `This will permanently remove the "${confirmDelete.label}" record.`}
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 rounded-xl text-sm font-medium" style={{ border: "1px solid #EDE7D7", color: "#6B6B64" }}>Cancel</button>
              <button onClick={handleDelete} className="px-4 py-2 rounded-xl text-sm font-semibold hover:opacity-90" style={{ background: "rgba(122,31,26,0.9)", color: "#fff" }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};


const ExportCustomerCard = ({ customerId, customerName }) => {
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportCustomerData(customerId, customerName);
      toast({ title: "Data export downloaded.", description: "The customer's full data package has been saved to your device." });
    } catch (err) {
      toast({ title: "Export failed", description: err.message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="rounded-2xl p-6" style={{ background: "rgba(15,95,92,0.03)", border: "1px solid rgba(15,95,92,0.12)" }}>
      <h3 className="text-sm font-semibold text-[#3A3D39] mb-2 flex items-center gap-2">
        <Download size={14} style={{ color: "#0F5F5C" }} /> Export Customer Data
      </h3>
      <p className="text-sm text-[#6B6B64] mb-4">
        Under GDPR Article 20 (Right to Data Portability) and CCPA, customers can request a copy of all personal data held about them. Export a complete JSON package including profile, memory, conversation summaries, and structured records.
      </p>
      <button
        onClick={handleExport}
        disabled={exporting}
        className="px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200 hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
        style={{ background: "rgba(15,95,92,0.15)", color: "#0F5F5C", border: "1px solid rgba(15,95,92,0.2)" }}
      >
        <Download size={14} />
        {exporting ? "Exporting…" : "Export customer data"}
      </button>
    </div>
  );
};


const DeleteCustomerCard = ({ customerId, navigate }) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteCustomer(customerId);
      toast({ title: "Customer data has been anonymised and removed." });
      navigate("/dashboard/customers");
    } catch (err) {
      toast({ title: "Deletion failed", description: err.message, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="rounded-2xl p-6" style={{ background: "rgba(122,31,26,0.03)", border: "1px solid rgba(122,31,26,0.12)" }}>
        <h3 className="text-sm font-semibold text-[#3A3D39] mb-2 flex items-center gap-2">
          <Trash2 size={14} style={{ color: "#7A1F1A" }} /> Delete Customer Data
        </h3>
        <p className="text-sm text-[#6B6B64] mb-4">
          If this customer has requested to be forgotten under GDPR or CCPA, you can anonymise and remove all their personal data here. <strong className="text-[#6B6B64]">This cannot be undone.</strong>
        </p>
        <button
          onClick={() => setShowConfirm(true)}
          className="px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200 hover:opacity-90"
          style={{ background: "rgba(122,31,26,0.15)", color: "#7A1F1A", border: "1px solid rgba(122,31,26,0.2)" }}
        >
          Delete customer data
        </button>
      </div>

      {showConfirm && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Close dialog"
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
          onClick={() => !deleting && setShowConfirm(false)}
          onKeyDown={e => { if ((e.key === "Escape" || e.key === "Enter" || e.key === " ") && !deleting) { e.preventDefault(); setShowConfirm(false); } }}
        >
          <div
            role="presentation"
            className="rounded-2xl p-6 max-w-md w-full mx-4"
            style={{ background: "#EDE7D7", border: "1px solid #EDE7D7" }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: "rgba(122,31,26,0.1)" }}>
                <AlertTriangle size={20} style={{ color: "#7A1F1A" }} />
              </div>
              <h3 className="text-lg font-semibold text-[#1A1D1A]">Confirm data deletion</h3>
            </div>
            <p className="text-sm text-[#6B6B64] mb-6">
              This will permanently anonymise and remove all personal data for this customer, including their soul file, memory file, and conversation history. This action cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                disabled={deleting}
                className="px-4 py-2 rounded-xl text-sm font-medium transition-colors"
                style={{ border: "1px solid #EDE7D7", color: "#6B6B64" }}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200 hover:opacity-90 disabled:opacity-50"
                style={{ background: "rgba(122,31,26,0.9)", color: "#fff" }}
              >
                {deleting ? "Deleting…" : "Yes, delete all data"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ShenmayCustomerDetail;
