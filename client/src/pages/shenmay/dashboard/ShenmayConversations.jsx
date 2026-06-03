import { useState, useEffect, useCallback, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getConversations, getConversation, getLabels, bulkConversations, takeoverConversation } from "@/lib/shenmayApi";
import { relTime, fmtTime } from "@/lib/format";
import { useShenmayAuth } from "@/contexts/ShenmayAuthContext";
import { toast } from "@/hooks/use-toast";
import {
  MessageSquare, AlertTriangle, RefreshCw, ExternalLink, ArrowUpRight,
  Users, Search, X, Circle, ThumbsUp, ThumbsDown, Square, CheckSquare,
  CheckCheck, Tag, ChevronDown, UserCheck,
} from "lucide-react";
import { TOKENS as T, Kicker, Display, Lede, Button } from "@/components/shenmay/ui/ShenmayUI";

/* ── Helpers ──────────────────────────────────────────────────────────────── */
const statusStyle = {
  active:    { bg: "rgba(45,106,79,0.12)",   color: "#2D6A4F",              label: "Active"    },
  ended:     { bg: "#EDE7D7", color: "#6B6B64", label: "Ended"   },
  escalated: { bg: "rgba(122,31,26,0.12)",   color: "#7A1F1A",              label: "Escalated" },
};

function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/* ── Filter pill ──────────────────────────────────────────────────────────── */
function Pill({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1 rounded-full text-[11px] font-semibold transition-all duration-150 shrink-0"
      style={{
        background: active ? "rgba(15,95,92,0.18)" : "#EDE7D7",
        color:      active ? "#0F5F5C"               : "#6B6B64",
        border:     active ? "1px solid rgba(15,95,92,0.35)" : "1px solid transparent",
      }}
    >
      {children}
    </button>
  );
}

/* ── Left panel: search bar + filters + list ─────────────────────────────── */
const ConversationList = ({
  conversations, selectedId, onSelect, loading, total,
  search, onSearchChange,
  statusFilter, onStatusFilter,
  modeFilter, onModeFilter,
  unreadOnly, onUnreadToggle,
  selectedIds, onToggleSelect, anySelected,
}) => {
  const inputRef = useRef(null);

  const statusPills = [
    { value: "",          label: "All" },
    { value: "active",    label: "Active" },
    { value: "escalated", label: "Escalated" },
    { value: "ended",     label: "Ended" },
  ];
  const modePills = [
    { value: "",      label: "All modes" },
    { value: "ai",    label: "AI" },
    { value: "human", label: "Human" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="px-3 pt-3 pb-2 shrink-0">
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "#6B6B64" }} />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full pl-8 pr-7 py-2 rounded-lg text-[12px] outline-none"
            style={{
              background: "#FFFFFF",
              border: "1px solid #D8D0BD",
              color: "#1A1D1A",
            }}
            onFocus={e => e.target.style.borderColor = "rgba(15,95,92,0.4)"}
            onBlur={e  => e.target.style.borderColor = "#D8D0BD"}
          />
          {search && (
            <button onClick={() => onSearchChange("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2">
              <X size={12} style={{ color: "#6B6B64" }} />
            </button>
          )}
        </div>
      </div>

      {/* Status pills */}
      <div className="flex gap-1.5 px-3 pb-2 overflow-x-auto shrink-0" style={{ scrollbarWidth: "none" }}>
        {statusPills.map(p => (
          <Pill key={p.value} active={statusFilter === p.value}
            onClick={() => onStatusFilter(p.value)}>
            {p.label}
          </Pill>
        ))}
      </div>

      {/* Mode + Unread row */}
      <div className="flex items-center gap-1.5 px-3 pb-2.5 overflow-x-auto shrink-0" style={{ scrollbarWidth: "none" }}>
        {modePills.map(p => (
          <Pill key={p.value} active={modeFilter === p.value}
            onClick={() => onModeFilter(p.value)}>
            {p.label}
          </Pill>
        ))}
        <div className="w-px h-3 shrink-0" style={{ background: "#EDE7D7" }} />
        <Pill active={unreadOnly} onClick={onUnreadToggle}>
          <span className="flex items-center gap-1">
            <Circle size={5} fill={unreadOnly ? "#EAB308" : "#6B6B64"}
              stroke="none" className="shrink-0" />
            Unread
          </span>
        </Pill>
      </div>

      {/* Divider + result count */}
      <div className="shrink-0 flex items-center justify-between px-4 pb-2"
        style={{ borderBottom: "1px solid #EDE7D7" }}>
        <span className="text-[10px]" style={{ color: "#6B6B64" }}>
          {loading ? "Loading…" : `${conversations.length} of ${total}`}
        </span>
      </div>

      {/* List */}
      {loading ? (
        <div className="p-4 space-y-3 animate-pulse flex-1">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="flex gap-3 items-center">
              <div className="h-9 w-9 rounded-full shrink-0" style={{ background: "#EDE7D7" }} />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-24 rounded" style={{ background: "#EDE7D7" }} />
                <div className="h-2.5 w-36 rounded" style={{ background: "#EDE7D7" }} />
              </div>
            </div>
          ))}
        </div>
      ) : conversations.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 text-center p-6">
          <MessageSquare className="h-7 w-7 mb-2" style={{ color: "#EDE7D7" }} />
          <p className="text-xs" style={{ color: "#6B6B64" }}>
            {search || statusFilter || modeFilter || unreadOnly
              ? "No conversations match your filters"
              : "No conversations yet"}
          </p>
          {(search || statusFilter || modeFilter || unreadOnly) && (
            <button
              onClick={() => { onSearchChange(""); onStatusFilter(""); onModeFilter(""); onUnreadToggle(false); }}
              className="mt-3 text-[11px] font-medium"
              style={{ color: "rgba(15,95,92,0.65)" }}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-y-auto flex-1">
          {conversations.map((c) => {
            const id         = c._id || c.id;
            const isSelected = id === selectedId;
            const fullName   = [c.first_name, c.last_name].filter(Boolean).join(" ");
            const name       = c.is_anonymous
              ? "Anonymous Visitor"
              : (fullName || c.customer_display_name || c.email || "Unknown");
            const lastMsg    = c.last_message || "";
            const truncMsg   = lastMsg.length > 52 ? lastMsg.slice(0, 52) + "…" : lastMsg;

            const isUnread    = !isSelected && c.unread;
            const isHuman     = c.mode === "human";
            const isEscalated = c.status === "escalated";

            const isChecked  = selectedIds?.has(id);
            const labels     = c.labels || [];
            const csatScore  = c.csat_score;

            return (
              <div
                key={id}
                className="group flex items-start gap-0 transition-all duration-150"
                style={{
                  background: isSelected
                    ? "rgba(15,95,92,0.10)"
                    : isUnread
                    ? "rgba(255,255,255,0.025)"
                    : "transparent",
                  borderLeft: isSelected
                    ? "2px solid #0F5F5C"
                    : isUnread
                    ? "2px solid rgba(234,179,8,0.6)"
                    : "2px solid transparent",
                  borderBottom: "1px solid #EDE7D7",
                }}
              >
                {/* Checkbox — visible on hover or when any items selected */}
                <div
                  role="checkbox"
                  aria-checked={isChecked}
                  tabIndex={0}
                  className={`flex items-center justify-center self-stretch px-2 shrink-0 cursor-pointer transition-opacity ${anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                  style={{ minWidth: 32 }}
                  onClick={e => { e.stopPropagation(); onToggleSelect?.(id); }}
                  onKeyDown={e => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onToggleSelect?.(id);
                    }
                  }}
                >
                  {isChecked
                    ? <CheckSquare size={14} style={{ color: "#0F5F5C" }} />
                    : <Square size={14} style={{ color: "#6B6B64" }} />}
                </div>

                <button
                  onClick={() => onSelect(id)}
                  className="flex-1 flex items-center gap-3 pr-4 py-3.5 text-left min-w-0"
                >
                  {/* Avatar */}
                  <div className="relative shrink-0">
                    <div className="h-9 w-9 rounded-full flex items-center justify-center text-[12px] font-bold"
                      style={{
                        background: isSelected   ? "rgba(15,95,92,0.20)"
                                  : isEscalated  ? "rgba(122,31,26,0.12)"
                                  : "#EDE7D7",
                        color: isSelected   ? "#0F5F5C"
                             : isEscalated  ? "#7A1F1A"
                             : "#6B6B64",
                      }}>
                      {name[0]?.toUpperCase() || "?"}
                    </div>
                    {isUnread && (
                      <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full border-2"
                        style={{ background: "#EAB308", borderColor: "#F5F1E8" }} />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[13px] truncate"
                        style={{
                          color: isSelected ? "#0F5F5C" : isUnread ? "#1A1D1A" : "#3A3D39",
                          fontWeight: isUnread ? 700 : 600,
                        }}>
                        {name}
                      </p>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {csatScore === 2 && <ThumbsUp size={10} style={{ color: "#2D6A4F" }} />}
                        {csatScore === 1 && <ThumbsDown size={10} style={{ color: "#7A1F1A" }} />}
                        <span className="text-[10px]"
                          style={{ color: isUnread ? "#6B6B64" : "#6B6B64" }}>
                          {relTime(c.last_message_at)}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 mt-0.5">
                      {isEscalated && (
                        <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded"
                          style={{ background: "rgba(122,31,26,0.15)", color: "#7A1F1A" }}>
                          ESCALATED
                        </span>
                      )}
                      {isHuman && !isEscalated && (
                        <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded flex items-center gap-0.5"
                          style={{ background: "rgba(16,185,129,0.12)", color: "#10B981" }}>
                          <Users size={8} /> HUMAN
                        </span>
                      )}
                      <p className="text-[12px] truncate flex-1" style={{ color: "#6B6B64" }}>
                        {truncMsg || "No messages yet"}
                      </p>
                    </div>

                    {/* Label chips */}
                    {labels.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {labels.slice(0, 3).map(l => (
                          <span key={l.id}
                            className="inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold"
                            style={{ background: l.color + "22", color: l.color }}>
                            {l.name}
                          </span>
                        ))}
                        {labels.length > 3 && (
                          <span className="text-[9px]" style={{ color: "#6B6B64" }}>
                            +{labels.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/* ── Right panel: thread view ────────────────────────────────────────────── */
const ThreadView = ({ conversationId, shenmayTenant }) => {
  const [convo, setConvo]       = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const [takingOver, setTakingOver] = useState(false);
  const scrollRef               = useRef(null);

  const fetchThread = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true); setError("");
    try {
      const res = await getConversation(conversationId);
      setConvo({ ...(res.conversation || res), messages: res.messages || [] });
    } catch (err) {
      setError(err.message || "Failed to load conversation.");
    } finally { setLoading(false); }
  }, [conversationId]);

  const handleTakeover = async () => {
    setTakingOver(true);
    try {
      await takeoverConversation(conversationId);
      await fetchThread();
    } catch (err) {
      console.error("Takeover failed:", err);
    } finally {
      setTakingOver(false);
    }
  };

  useEffect(() => { fetchThread(); }, [fetchThread]);
  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [convo?.messages]);

  if (!conversationId) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", textAlign: "center", padding: 32 }}>
      <div style={{ width: 62, height: 62, borderRadius: "50%", background: T.paperDeep, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
        <MessageSquare size={24} color={T.paperEdge} />
      </div>
      <Kicker color={T.mute}>No thread selected</Kicker>
      <p style={{ fontSize: 13, color: T.mute, margin: "8px 0 0" }}>Pick a conversation from the list.</p>
    </div>
  );

  if (loading) return (
    <div className="flex flex-col h-full">
      <div className="h-16 flex items-center px-6 animate-pulse"
        style={{ borderBottom: "1px solid #EDE7D7" }}>
        <div className="h-4 w-32 rounded" style={{ background: "#EDE7D7" }} />
      </div>
      <div className="flex-1 p-6 space-y-4 animate-pulse">
        {[...Array(4)].map((_, i) => (
          <div key={i} className={`flex ${i % 2 ? "justify-end" : "justify-start"}`}>
            <div className="h-14 w-56 rounded-2xl" style={{ background: "#EDE7D7" }} />
          </div>
        ))}
      </div>
    </div>
  );

  if (error) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", textAlign: "center", padding: 32, gap: 14 }}>
      <div style={{ width: 54, height: 54, borderRadius: "50%", background: "#F3E8E4", border: `1px solid ${T.danger}33`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <AlertTriangle size={22} color={T.danger} />
      </div>
      <p style={{ fontSize: 13, color: T.mute, margin: 0 }}>{error}</p>
      <Button variant="primary" onClick={fetchThread}><RefreshCw size={13} /> Retry</Button>
    </div>
  );

  const fullName = [convo?.first_name, convo?.last_name].filter(Boolean).join(" ");
  const name     = convo?.is_anonymous ? "Anonymous Visitor" : (fullName || convo?.customer_display_name || convo?.email || "Unknown");
  const st       = (convo?.status || "active").toLowerCase();
  const badge    = statusStyle[st] || statusStyle.active;
  const messages = convo?.messages || [];
  const isActive = st === "active" || st === "escalated";
  const isHuman  = (convo?.mode || "ai") === "human";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-16 flex items-center justify-between px-6 shrink-0"
        style={{ borderBottom: "1px solid #EDE7D7" }}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0"
            style={{ background: "rgba(15,95,92,0.15)", color: "#0F5F5C" }}>
            {name[0]?.toUpperCase() || "?"}
          </div>
          <div>
            {convo?.customer_id && !convo?.is_anonymous ? (
              <Link to={`/dashboard/customers/${convo.customer_id}`}
                className="text-[14px] font-semibold text-[#1A1D1A] hover:text-[#0F5F5C] transition-colors flex items-center gap-1">
                {name}<ExternalLink className="h-3 w-3 opacity-40" />
              </Link>
            ) : (
              <p className="text-[14px] font-semibold text-[#1A1D1A]">{name}</p>
            )}
            {convo?.email && !convo?.is_anonymous && (
              <p className="text-[11px] text-[#6B6B64]">{convo.email}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block px-2.5 py-1 rounded-full text-[11px] font-semibold"
            style={{ background: badge.bg, color: badge.color }}>{badge.label}</span>
          {isActive && !isHuman && (
            <Button variant="teal" size="sm" onClick={handleTakeover} disabled={takingOver}>
              <UserCheck size={12} />
              {takingOver ? "Taking over…" : "Take over"}
            </Button>
          )}
          {conversationId && (
            <Link to={`/dashboard/conversations/${conversationId}`}
              title="Open full conversation"
              className="p-1.5 rounded-lg hover:opacity-70 transition-opacity"
              style={{ color: "#6B6B64" }}>
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      </div>

      {/* Escalated banner */}
      {st === "escalated" && (
        <div className="mx-6 mt-3 rounded-xl px-4 py-2.5 flex items-center gap-2.5 text-[13px] font-medium"
          style={{ background: "rgba(122,31,26,0.08)", border: "1px solid rgba(122,31,26,0.12)", color: "#7A1F1A" }}>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Escalated for human review
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
        {messages.length === 0 ? (
          <div className="text-center py-10">
            <MessageSquare className="h-8 w-8 mx-auto mb-3" style={{ color: "#EDE7D7" }} />
            <p className="text-xs" style={{ color: "#D8D0BD" }}>No messages in this conversation.</p>
          </div>
        ) : messages.map((msg, i) => {
          const role    = (msg.role || msg.sender || "").toLowerCase();
          const isAgent = role === "agent" || role === "assistant";
          const isHumanSent = isAgent && !!msg.sent_by_admin_id;
          const humanName = isHumanSent
            ? (`${msg.sender_first_name || ""} ${msg.sender_last_name || ""}`.trim() || "Human")
            : null;
          const content = msg.content || msg.text || msg.message || "";
          const ts      = fmtTime(msg.createdAt || msg.created_at || msg.timestamp);

          return (
            <div key={msg._id || msg.id || i} className={`flex ${isAgent ? "justify-end" : "justify-start"}`}>
              <div className="max-w-[70%]">
                <div className="rounded-2xl px-4 py-2.5"
                  style={isAgent ? {
                    background: T.ink,
                    color: T.paper,
                    borderBottomRightRadius: "6px",
                    borderRight: isHumanSent ? "3px solid #0F5F5C" : undefined,
                  } : {
                    background: T.paperDeep,
                    border: `1px solid ${T.paperEdge}`,
                    borderBottomLeftRadius: "6px",
                  }}>
                  <p className="text-[13px] whitespace-pre-wrap" style={{ color: isAgent ? T.paper : T.ink, margin: 0, lineHeight: 1.5 }}>
                    {content}
                  </p>
                </div>
                <p className="text-[10px] mt-1 px-1" style={{ color: "#D8D0BD" }}>
                  {isHumanSent && (
                    <span style={{ display: "inline-block", marginRight: 5, padding: "1px 5px", borderRadius: 3, background: "#0F5F5C", color: "#FFFFFF", fontSize: 9, letterSpacing: "0.06em" }}>HUMAN</span>
                  )}
                  {isAgent ? (humanName || (shenmayTenant?.agent_name || "Agent")) : ""}
                  {isAgent && ts ? " · " : ""}{ts}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ── Main component ──────────────────────────────────────────────────────── */
const ShenmayConversations = () => {
  const { shenmayTenant } = useShenmayAuth();

  const [conversations, setConversations] = useState([]);
  const [total, setTotal]                 = useState(0);
  const [selectedId, setSelectedId]       = useState(null);
  const [listLoading, setListLoading]     = useState(true);
  const [error, setError]                 = useState("");

  // Filter state
  const [search, setSearch]           = useState("");
  const [statusFilter, setStatus]     = useState("");
  const [modeFilter, setMode]         = useState("");
  const [unreadOnly, setUnreadOnly]   = useState(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkLabelOpen, setBulkLabelOpen] = useState(false);
  const [allLabels, setAllLabels]     = useState([]);

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  // Load labels for bulk label picker
  useEffect(() => {
    getLabels().then(d => setAllLabels(d.labels || [])).catch(() => {});
  }, []);

  const debouncedSearch = useDebounce(search, 300);
  const intervalRef     = useRef(null);

  const handleBulkResolve = async () => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      await bulkConversations([...selectedIds], "resolve");
      clearSelection();
      fetchList();
    } catch (err) {
      console.error("Bulk resolve failed:", err);
      toast({ title: "Could not resolve conversations", description: err.message, variant: "destructive" });
    }
    finally { setBulkLoading(false); }
  };

  const handleBulkLabel = async (labelId) => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    setBulkLabelOpen(false);
    try {
      await bulkConversations([...selectedIds], "label", { label_id: labelId });
      clearSelection();
      fetchList();
    } catch (err) {
      console.error("Bulk label failed:", err);
      toast({ title: "Could not apply label", description: err.message, variant: "destructive" });
    }
    finally { setBulkLoading(false); }
  };

  const fetchList = useCallback(async (bg = false) => {
    if (!bg) setListLoading(true);
    try {
      const res = await getConversations(1, {
        status: statusFilter || undefined,
        mode:   modeFilter   || undefined,
        unread: unreadOnly   || undefined,
        search: debouncedSearch || undefined,
      }, 50);
      const list = res.conversations || [];
      setConversations(list);
      setTotal(res.total || list.length);
      // Re-select when the current selection is filtered out — otherwise
      // the right-panel keeps showing a thread that's no longer in the list.
      if (!bg) {
        if (list.length === 0) {
          setSelectedId(null);
        } else if (!selectedId || !list.some(c => (c._id || c.id) === selectedId)) {
          setSelectedId(list[0]._id || list[0].id);
        }
      }
    } catch (err) {
      if (!bg) setError(err.message || "Failed to load conversations.");
    } finally {
      if (!bg) setListLoading(false);
    }
  }, [statusFilter, modeFilter, unreadOnly, debouncedSearch, selectedId]);

  // Reload when filters change
  useEffect(() => {
    fetchList();
  }, [statusFilter, modeFilter, unreadOnly, debouncedSearch]);

  // Background poll (30s) — only when no active filters that would make polling confusing
  useEffect(() => {
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => fetchList(true), 30000);
    return () => clearInterval(intervalRef.current);
  }, [fetchList]);

  if (error && conversations.length === 0) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "72px 0", textAlign: "center" }}>
      <div style={{ width: 54, height: 54, borderRadius: "50%", background: "#F3E8E4", border: `1px solid ${T.danger}33`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <AlertTriangle size={24} color={T.danger} />
      </div>
      <Lede style={{ marginTop: 0 }}>{error}</Lede>
      <Button variant="primary" onClick={() => fetchList()}><RefreshCw size={14} /> Retry</Button>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 4rem)" }}>
      <div style={{ padding: "24px 24px 16px" }}>
        <Kicker>Live</Kicker>
        <Display size={32} italic style={{ marginTop: 10 }}>Conversations.</Display>
      </div>
      <div className="flex rounded-t-none overflow-hidden"
      style={{
        background: "#FFFFFF",
        border: `1px solid ${T.paperEdge}`,
        borderRadius: 10,
        margin: "0 24px 24px",
        flex: 1,
        minHeight: 0,
      }}>
      {/* Left panel */}
      <div className="w-[310px] shrink-0 flex flex-col"
        style={{ borderRight: "1px solid #EDE7D7" }}>
        <div className="h-12 flex items-center px-4 shrink-0"
          style={{ borderBottom: "1px solid #EDE7D7" }}>
          {selectedIds.size > 0 ? (
            /* Bulk action toolbar */
            <div className="flex items-center gap-2 w-full relative">
              <span className="text-[11px] font-semibold shrink-0" style={{ color: "#0F5F5C" }}>
                {selectedIds.size} selected
              </span>
              <button onClick={handleBulkResolve} disabled={bulkLoading}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-opacity hover:opacity-80 disabled:opacity-50 shrink-0"
                style={{ background: "rgba(45,106,79,0.12)", color: "#2D6A4F" }}>
                <CheckCheck size={11} /> Resolve
              </button>
              {allLabels.length > 0 && (
                <div className="relative shrink-0">
                  <button onClick={() => setBulkLabelOpen(v => !v)} disabled={bulkLoading}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-opacity hover:opacity-80 disabled:opacity-50"
                    style={{ background: "rgba(15,95,92,0.12)", color: "#0F5F5C" }}>
                    <Tag size={11} /> Label <ChevronDown size={9} />
                  </button>
                  {bulkLabelOpen && (
                    <div className="absolute left-0 top-8 z-20 rounded-xl shadow-2xl overflow-hidden min-w-[140px]"
                      style={{ background: "#FFFFFF", border: "1px solid #D8D0BD", boxShadow: "0 12px 32px -12px rgba(26,29,26,0.18)" }}>
                      {allLabels.map(l => (
                        <button key={l.id} onClick={() => handleBulkLabel(l.id)}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-white/5 transition-colors">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: l.color }} />
                          <span style={{ color: "#3A3D39" }}>{l.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <button onClick={clearSelection}
                className="ml-auto p-1 rounded-lg transition-opacity hover:opacity-70"
                style={{ color: "#6B6B64" }}>
                <X size={13} />
              </button>
            </div>
          ) : (
            <h3 className="text-[13px] font-semibold" style={{ color: "#6B6B64" }}>
              Conversations
            </h3>
          )}
        </div>

        <ConversationList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={(id) => { setSelectedId(id); setBulkLabelOpen(false); }}
          loading={listLoading}
          total={total}
          search={search}
          onSearchChange={setSearch}
          statusFilter={statusFilter}
          onStatusFilter={setStatus}
          modeFilter={modeFilter}
          onModeFilter={setMode}
          unreadOnly={unreadOnly}
          onUnreadToggle={() => setUnreadOnly(v => !v)}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          anySelected={selectedIds.size > 0}
        />
      </div>

      {/* Right panel */}
      <div className="flex-1 min-w-0">
        <ThreadView
          key={selectedId}
          conversationId={selectedId}
          shenmayTenant={shenmayTenant}
        />
      </div>
      </div>
    </div>
  );
};

export default ShenmayConversations;
