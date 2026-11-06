import { useState, useEffect, useCallback, useRef } from "react";
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useShenmayAuth } from "@/contexts/ShenmayAuthContext";
import {
  clearToken,
  getBadgeCounts,
  getSubscription as fetchSubscriptionUsage,
  getNotifications,
  markNotificationsRead,
} from "@/lib/shenmayApi";
import SubscriptionGate from "@/components/shenmay/SubscriptionGate";
import { PLAN_LABELS, NOTIFICATION_TYPES } from "@/lib/constants";
import ShenmayWordmark from "@/components/shenmay/ShenmayWordmark";
import { TOKENS as T, Kicker } from "@/components/shenmay/ui/ShenmayUI";
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  AlertTriangle,
  Settings,
  LogOut,
  Menu,
  X,
  UserCircle,
  Zap,
  Users2,
  Wrench,
  Bell,
  Flag,
  MessageCircle,
  TrendingUp,
  Brain,
} from "lucide-react";

// ── Notification helpers ───────────────────────────────────────────────
const NOTIF_ICON = {
  [NOTIFICATION_TYPES.FLAG]:          { Icon: Flag,          color: T.danger  },
  [NOTIFICATION_TYPES.HUMAN_REPLY]:   { Icon: MessageCircle, color: T.teal    },
  [NOTIFICATION_TYPES.ESCALATION]:    { Icon: TrendingUp,    color: T.warning },
  [NOTIFICATION_TYPES.LIMIT_REACHED]: { Icon: Zap,           color: T.danger  },
};

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function NotifItem({ n, onNavigate }) {
  const { Icon, color } = NOTIF_ICON[n.type] || { Icon: Bell, color: T.mute };
  const isUnread = !n.read_at;
  return (
    <button
      onClick={() => onNavigate(n)}
      style={{
        width: "100%", textAlign: "left", padding: "12px 16px",
        display: "flex", alignItems: "flex-start", gap: 12,
        borderLeft: isUnread ? `2px solid ${color}` : "2px solid transparent",
        background: "transparent", border: "none", borderBottom: `1px solid ${T.paperEdge}`, cursor: "pointer",
        fontFamily: T.sans,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = T.paperDeep)}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <div style={{ width: 26, height: 26, borderRadius: 6, background: `${color}1A`, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 }}>
        <Icon size={13} color={color} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <p style={{ fontSize: 13, fontWeight: isUnread ? 500 : 400, color: isUnread ? T.ink : T.inkSoft, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {n.title}
        </p>
        {n.body && (
          <p style={{ fontSize: 12, color: T.mute, margin: "2px 0 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {n.body}
          </p>
        )}
        <p style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: "0.08em", color: T.mute, margin: "4px 0 0", textTransform: "uppercase" }}>
          {timeAgo(n.created_at)}
        </p>
      </div>
    </button>
  );
}

function UsageBar({ label, used, limit, pct, nearLimit }) {
  if (limit === null || limit === undefined) return null;
  const barColor = pct >= 100 ? T.danger : nearLimit ? T.warning : T.teal;
  const displayPct = Math.min(100, pct ?? 0);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: T.mute }}>{label}</span>
        <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 500, color: nearLimit || pct >= 100 ? barColor : T.inkSoft, letterSpacing: "0.05em" }}>
          {used?.toLocaleString() ?? 0} / {limit?.toLocaleString()}
        </span>
      </div>
      <div style={{ height: 2, borderRadius: 1, background: T.paperEdge, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${displayPct}%`, background: barColor, transition: "width 500ms ease" }} />
      </div>
    </div>
  );
}

const NAV = [
  { label: "Overview",          icon: LayoutDashboard, to: "/dashboard",               end: true },
  { label: "Conversations",     icon: MessageSquare,   to: "/dashboard/conversations",  badge: "conversations" },
  { label: "Customers",         icon: Users,           to: "/dashboard/customers" },
  { label: "Concerns",          icon: AlertTriangle,   to: "/dashboard/concerns",       badge: "concerns" },
  { label: "AI tools",          icon: Wrench,          to: "/dashboard/tools" },
  { label: "Brand learning",    icon: Brain,           to: "/dashboard/brand-learning" },
  { label: "Team",              icon: Users2,          to: "/dashboard/team" },
  { label: "Plans & billing",   icon: Zap,             to: "/dashboard/plans" },
  { label: "Settings",          icon: Settings,        to: "/dashboard/settings" },
  { label: "Profile",           icon: UserCircle,      to: "/dashboard/profile" },
];

const PAGE_TITLES = {
  "/dashboard": "Overview",
  "/dashboard/conversations": "Conversations",
  "/dashboard/customers": "Customers",
  "/dashboard/concerns": "Concerns",
  "/dashboard/tools": "AI tools",
  "/dashboard/brand-learning": "Brand learning",
  "/dashboard/team": "Team",
  "/dashboard/plans": "Plans & billing",
  "/dashboard/settings": "Settings",
  "/dashboard/profile": "Profile",
};

const SidebarContent = ({ shenmayTenant, shenmayUser, badges, handleSignOut, subscription, usage }) => {
  const planInfo = subscription ? (PLAN_LABELS[subscription.plan] || PLAN_LABELS.free) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: T.sans }}>
      {/* Brand */}
      <div style={{ padding: "28px 24px 20px" }}>
        <ShenmayWordmark size={22} />
      </div>

      {/* Tenant pill */}
      {shenmayTenant && (
        <div style={{ margin: "0 16px 16px", padding: "14px 14px 12px", background: "#FFFFFF", border: `1px solid ${T.paperEdge}`, borderRadius: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div style={{ width: 30, height: 30, borderRadius: 6, background: T.ink, color: T.paper, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 500, flexShrink: 0 }}>
              {shenmayTenant.name?.[0]?.toUpperCase() || "S"}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ fontSize: 13, fontWeight: 500, color: T.ink, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: "-0.005em" }}>
                {shenmayTenant.name}
              </p>
              {shenmayTenant.agent_name && (
                <p style={{ fontSize: 11, color: T.mute, margin: "2px 0 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{shenmayTenant.agent_name}</p>
              )}
            </div>
            {planInfo && (
              <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", padding: "3px 6px", borderRadius: 3, background: `${T.teal}18`, color: T.teal, flexShrink: 0 }}>
                {planInfo.label}
              </span>
            )}
          </div>

          {usage && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.paperEdge}` }}>
              <UsageBar label="Customers" used={usage.customers_count} limit={usage.customers_limit} pct={usage.customers_pct} nearLimit={usage.near_customer_limit} />
              <UsageBar label="Messages · this month" used={usage.messages_used} limit={usage.messages_limit} pct={usage.messages_pct} nearLimit={usage.near_message_limit} />
              {(usage.near_customer_limit || usage.near_message_limit) && !usage.customer_limit_reached && !usage.message_limit_reached && (
                <NavLink to="/dashboard/plans" style={{ display: "block", fontFamily: T.mono, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 500, color: T.warning, textDecoration: "none", marginTop: 6 }}>
                  Approaching limit · upgrade →
                </NavLink>
              )}
              {(usage.customer_limit_reached || usage.message_limit_reached) && (
                <NavLink to="/dashboard/plans" style={{ display: "block", fontFamily: T.mono, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 500, color: T.danger, textDecoration: "none", marginTop: 6 }}>
                  Limit reached · upgrade →
                </NavLink>
              )}
            </div>
          )}
        </div>
      )}

      {/* Nav */}
      <nav style={{ flex: 1, padding: "0 12px", display: "flex", flexDirection: "column", gap: 2 }}>
        <Kicker color={T.mute} style={{ fontSize: 10, letterSpacing: "0.14em", padding: "0 12px 10px", display: "block" }}>Menu</Kicker>
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={({ isActive }) => ({
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: "-0.005em",
                textDecoration: "none",
                color: isActive ? T.ink : T.inkSoft,
                background: isActive ? "#FFFFFF" : "transparent",
                border: isActive ? `1px solid ${T.paperEdge}` : "1px solid transparent",
                boxShadow: isActive ? "inset 3px 0 0 " + T.teal : "none",
                transition: "background 180ms, color 180ms",
              })}
              onMouseEnter={(e) => { if (!e.currentTarget.style.background.includes("255, 255")) e.currentTarget.style.background = "rgba(255,255,255,0.5)"; }}
              onMouseLeave={(e) => {
                const isActive = e.currentTarget.getAttribute("aria-current") === "page";
                if (!isActive) e.currentTarget.style.background = "transparent";
              }}
            >
              <Icon size={15} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.badge === "conversations" && badges.unread_conversations > 0 && (
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 500, letterSpacing: "0.02em", padding: "2px 6px", borderRadius: 3, background: T.teal, color: T.paper, minWidth: 20, textAlign: "center" }}>
                  {badges.unread_conversations > 99 ? "99+" : badges.unread_conversations}
                </span>
              )}
              {item.badge === "concerns" && badges.open_concerns > 0 && (
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 500, letterSpacing: "0.02em", padding: "2px 6px", borderRadius: 3, background: badges.unread_concerns > 0 ? T.danger : `${T.danger}80`, color: T.paper, minWidth: 20, textAlign: "center" }}>
                  {badges.open_concerns > 99 ? "99+" : badges.open_concerns}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Bottom · user + sign out */}
      <div style={{ padding: "16px 20px 24px", borderTop: `1px solid ${T.paperEdge}`, marginTop: 12 }}>
        {shenmayUser && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div style={{ width: 30, height: 30, borderRadius: "50%", background: T.paperEdge, color: T.ink, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 500, flexShrink: 0 }}>
              {(shenmayUser.firstName?.[0] || "").toUpperCase()}{(shenmayUser.lastName?.[0] || "").toUpperCase()}
            </div>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 12, color: T.ink, fontWeight: 500, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {shenmayUser.firstName} {shenmayUser.lastName}
              </p>
              <p style={{ fontSize: 11, color: T.mute, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{shenmayUser.email}</p>
            </div>
          </div>
        )}
        <button
          onClick={handleSignOut}
          style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: T.mute, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: T.sans }}
          onMouseEnter={(e) => (e.currentTarget.style.color = T.danger)}
          onMouseLeave={(e) => (e.currentTarget.style.color = T.mute)}
        >
          <LogOut size={13} /> Sign out
        </button>
      </div>
    </div>
  );
};

const ShenmayDashboardLayout = () => {
  const { shenmayUser, shenmayTenant, setShenmayUser, subscription } = useShenmayAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [badges, setBadges] = useState({ unread_conversations: 0, open_concerns: 0, unread_concerns: 0 });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [usageData, setUsageData] = useState(null);
  const badgeIntervalRef = useRef(null);

  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await getNotifications();
      setNotifications(data.notifications || []);
      setUnreadCount(data.unread_count || 0);
    } catch {}
  }, []);

  useEffect(() => {
    if (!notifOpen) return;
    const handler = (e) => { if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [notifOpen]);

  const handleBellClick = async () => {
    setNotifOpen((prev) => !prev);
    if (!notifOpen && unreadCount > 0) {
      try {
        await markNotificationsRead();
        setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
        setUnreadCount(0);
      } catch {}
    }
  };

  const handleNotifNavigate = (n) => {
    setNotifOpen(false);
    if (n.resource_type === "conversation" && n.resource_id) navigate(`/dashboard/conversations/${n.resource_id}`);
    else navigate("/dashboard/concerns");
  };

  const fetchBadges = useCallback(async () => {
    try { const data = await getBadgeCounts(); setBadges(data); } catch {}
  }, []);

  const fetchUsage = useCallback(async () => {
    try { const data = await fetchSubscriptionUsage(); if (data?.usage) setUsageData(data.usage); } catch {}
  }, []);

  useEffect(() => {
    fetchBadges(); fetchUsage(); fetchNotifications();
    badgeIntervalRef.current = setInterval(fetchBadges, 10000);
    const notifId = setInterval(fetchNotifications, 15000);
    const usageId = setInterval(fetchUsage, 60000);
    return () => { clearInterval(badgeIntervalRef.current); clearInterval(notifId); clearInterval(usageId); };
  }, [fetchBadges, fetchUsage, fetchNotifications]);

  useEffect(() => { fetchBadges(); }, [location.pathname, fetchBadges]);
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const handleSignOut = () => { clearToken(); setShenmayUser(null); navigate("/login", { replace: true }); };

  // Match longest key first so /dashboard/customers/:id resolves to "Customers",
  // not the bare "/dashboard" → "Overview" prefix.
  const pageTitle =
    PAGE_TITLES[location.pathname] ||
    Object.entries(PAGE_TITLES)
      .sort(([a], [b]) => b.length - a.length)
      .find(([k]) => location.pathname === k || location.pathname.startsWith(k + "/"))?.[1] ||
    "Dashboard";

  const sidebarProps = { shenmayTenant, shenmayUser, badges, handleSignOut, subscription, usage: usageData };
  const isConversationsList = location.pathname.startsWith("/dashboard/conversations") && !location.pathname.includes("/conversations/");

  return (
    <div className="shenmay-scope" style={{ minHeight: "100vh", display: "flex", background: T.paper, color: T.ink, fontFamily: T.sans }}>
      {/* Desktop sidebar */}
      <aside
        className="shenmay-dash-sidebar"
        style={{
          display: "none",
          width: 256,
          flexShrink: 0,
          flexDirection: "column",
          background: T.paperDeep,
          borderRight: `1px solid ${T.paperEdge}`,
          minHeight: "100vh",
          position: "sticky",
          top: 0,
        }}
      >
        <SidebarContent {...sidebarProps} />
      </aside>
      <style>{`@media (min-width: 1024px) { .shenmay-dash-sidebar { display: flex !important; } }`}</style>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 40 }}>
          <div
            role="button"
            aria-label="Close menu"
            tabIndex={0}
            style={{ position: "absolute", inset: 0, background: "rgba(26,29,26,0.35)", backdropFilter: "blur(4px)" }}
            onClick={() => setMobileOpen(false)}
            onKeyDown={e => { if (e.key === "Escape" || e.key === "Enter" || e.key === " ") { e.preventDefault(); setMobileOpen(false); } }}
          />
          <aside style={{ position: "relative", width: 280, height: "100%", display: "flex", flexDirection: "column", zIndex: 50, overflow: "auto", background: T.paperDeep, borderRight: `1px solid ${T.paperEdge}` }}>
            <button onClick={() => setMobileOpen(false)} style={{ position: "absolute", top: 20, right: 16, color: T.mute, background: "none", border: "none", cursor: "pointer", zIndex: 10 }}>
              <X size={18} />
            </button>
            <SidebarContent {...sidebarProps} />
          </aside>
        </div>
      )}

      {/* Main */}
      <div style={{ flex: 1, minWidth: 0, minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        {/* Top bar */}
        <header
          style={{
            height: 56,
            display: "flex",
            alignItems: "center",
            padding: "0 20px",
            position: "sticky",
            top: 0,
            zIndex: 20,
            background: "rgba(245,241,232,0.88)",
            backdropFilter: "blur(12px)",
            borderBottom: `1px solid ${T.paperEdge}`,
          }}
        >
          <button className="shenmay-dash-menu-btn" onClick={() => setMobileOpen(true)} style={{ background: "none", border: "none", padding: 6, marginRight: 10, color: T.ink, cursor: "pointer", display: "inline-flex" }} aria-label="Open menu">
            <Menu size={18} />
          </button>
          <style>{`@media (min-width: 1024px) { .shenmay-dash-menu-btn { display: none !important; } }`}</style>
          <h1 style={{ margin: 0, fontSize: 14, fontWeight: 500, color: T.ink, letterSpacing: "-0.005em" }}>{pageTitle}</h1>

          {/* Notification bell */}
          <div style={{ marginLeft: "auto", position: "relative" }} ref={notifRef}>
            <button
              onClick={handleBellClick}
              style={{ position: "relative", padding: 8, borderRadius: 6, background: "transparent", border: "none", color: notifOpen ? T.teal : T.ink, cursor: "pointer", display: "inline-flex" }}
              aria-label="Notifications"
              onMouseEnter={(e) => { if (!notifOpen) e.currentTarget.style.color = T.teal; }}
              onMouseLeave={(e) => { if (!notifOpen) e.currentTarget.style.color = T.ink; }}
            >
              <Bell size={17} />
              {unreadCount > 0 && (
                <span style={{ position: "absolute", top: 0, right: 0, fontFamily: T.mono, fontSize: 9, fontWeight: 500, padding: "1px 4px", borderRadius: 8, background: T.danger, color: T.paper, minWidth: 14, textAlign: "center" }}>
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>

            {notifOpen && (
              <div style={{ position: "absolute", right: 0, top: "100%", marginTop: 8, width: 336, background: "#FFFFFF", border: `1px solid ${T.paperEdge}`, borderRadius: 10, boxShadow: "0 16px 48px rgba(26,29,26,0.12)", zIndex: 50, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${T.paperEdge}` }}>
                  <Kicker color={T.mute}>Notifications</Kicker>
                  {notifications.some((n) => !n.read_at) && (
                    <button
                      onClick={async () => {
                        await markNotificationsRead();
                        setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
                        setUnreadCount(0);
                      }}
                      style={{ fontSize: 11, fontWeight: 500, color: T.teal, background: "none", border: "none", cursor: "pointer", fontFamily: T.sans, padding: 0 }}
                    >
                      Mark all read
                    </button>
                  )}
                </div>

                <div style={{ overflowY: "auto", maxHeight: 360 }}>
                  {notifications.length === 0 ? (
                    <div style={{ padding: "36px 16px", textAlign: "center", color: T.mute, fontSize: 12 }}>
                      <Bell size={20} style={{ margin: "0 auto 8px", opacity: 0.4, display: "block" }} />
                      No notifications yet
                    </div>
                  ) : (
                    notifications.map((n) => <NotifItem key={n.id} n={n} onNavigate={handleNotifNavigate} />)
                  )}
                </div>
              </div>
            )}
          </div>
        </header>

        {/* Trial limit banner */}
        {subscription && ["trial", "free"].includes(subscription.plan) && usageData && (usageData.customer_limit_reached || usageData.message_limit_reached) && (
          <div style={{ padding: "14px 20px", background: T.ink, color: T.paper, borderBottom: `1px solid ${T.ink}`, display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ width: 26, height: 26, borderRadius: 13, background: T.danger, color: T.paper, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: T.mono, fontWeight: 500 }}>!</div>
              <div>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 500, letterSpacing: "-0.005em" }}>
                  {usageData.message_limit_reached
                    ? "Trial limit reached — your agents are paused"
                    : "Trial customer limit reached — new sessions blocked"}
                </p>
                <p style={{ margin: "4px 0 0", fontSize: 12, color: "rgba(245,241,232,0.7)", lineHeight: 1.5 }}>
                  {usageData.customer_limit_reached && usageData.message_limit_reached
                    ? "You've used all trial customers and messages — no new sessions, and no agent replies until you upgrade."
                    : usageData.customer_limit_reached
                    ? `You've reached the ${usageData.customers_limit}-customer trial limit. Existing conversations keep flowing; new visitors can't start a session until you upgrade.`
                    : `You've used all ${usageData.messages_limit} trial messages this month. Agents stop replying until next month or until you upgrade.`}
                </p>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <NavLink to="/dashboard/plans" style={{ fontSize: 12, fontWeight: 500, padding: "8px 14px", borderRadius: 6, background: T.paper, color: T.ink, textDecoration: "none", letterSpacing: "0.01em" }}>
                View plans
              </NavLink>
              <a href="https://pontensolutions.com/contact" target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 500, padding: "8px 14px", borderRadius: 6, border: `1px solid ${T.paper}66`, color: T.paper, textDecoration: "none", letterSpacing: "0.01em" }}>
                Contact sales
              </a>
            </div>
          </div>
        )}

        <main style={{ flex: 1, overflowX: "hidden", padding: isConversationsList ? 0 : "20px 24px" }}>
          {/* Plans + Profile always accessible; everything else is gated */}
          {location.pathname.includes("/plans") || location.pathname.includes("/profile")
            ? <Outlet />
            : <SubscriptionGate subscription={subscription}><Outlet /></SubscriptionGate>
          }
        </main>
      </div>
    </div>
  );
};

export default ShenmayDashboardLayout;
