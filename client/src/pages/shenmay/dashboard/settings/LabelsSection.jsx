import { useState, useEffect } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { useShenmayAuth } from "@/contexts/ShenmayAuthContext";
import { getMe, updateCompany, updatePrivacySettings, updateAnonymousOnlyMode, getProducts, addProduct, updateProduct, deleteProduct, getDataApiKey, generateDataApiKey, revokeDataApiKey, getAgentSoul, generateSoul, getWebhooks, createWebhook, updateWebhook, deleteWebhook, testWebhook, getLabels, createLabel, updateLabel, deleteLabel, getConnectors, updateConnectors, testSlack, testTeams, getEmailTemplates, updateEmailTemplates } from "@/lib/shenmayApi";
import { toast } from "@/hooks/use-toast";
import { Copy, Check, Plus, Trash2, Pencil, X, ChevronUp, Key, AlertTriangle, RefreshCw, Eye, EyeOff, Brain, Sparkles, Shield, MessageSquare, Webhook, ToggleLeft, ToggleRight, Send, ChevronDown, Tag, Plug2, Zap, Mail } from "lucide-react";
import { Link } from "react-router-dom";
import { TOKENS as T, Kicker, Display, Lede } from "@/components/shenmay/ui/ShenmayUI";


import { card, inputClass, inputStyle } from "./_shared";

const PRESET_COLORS = [
  "#0F5F5C", "#2D6A4F", "#60A5FA", "#7A1F1A", "#A78BFA",
  "#FB923C", "#34D399", "#F472B6", "#94A3B8", "#A6660E",
];

const LabelsSection = () => {
  const [labels, setLabels]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [editing, setEditing]   = useState(null);  // label id or 'new'
  const [formName, setFormName] = useState("");
  const [formColor, setFormColor] = useState(PRESET_COLORS[0]);

  const load = async () => {
    try {
      const d = await getLabels();
      setLabels(d.labels || []);
    } catch (_) {}
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openNew = () => {
    setFormName(""); setFormColor(PRESET_COLORS[0]); setEditing("new");
  };
  const openEdit = (l) => {
    setFormName(l.name); setFormColor(l.color); setEditing(l.id);
  };
  const cancel = () => setEditing(null);

  const handleSave = async () => {
    if (!formName.trim()) {
      toast({ title: "Label name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      if (editing === "new") {
        await createLabel({ name: formName.trim(), color: formColor });
      } else {
        await updateLabel(editing, { name: formName.trim(), color: formColor });
      }
      await load();
      setEditing(null);
    } catch (err) {
      toast({ title: "Error", description: err.message || "Failed to save label", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this label? It will be removed from all conversations.")) return;
    try {
      await deleteLabel(id);
      setLabels(prev => prev.filter(l => l.id !== id));
    } catch (err) {
      toast({ title: "Error", description: err.message || "Failed to delete label", variant: "destructive" });
    }
  };

  return (
    <div className="rounded-2xl p-6 space-y-5"
      style={{ background: "#EDE7D7", border: "1px solid #EDE7D7" }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Tag size={16} style={{ color: "#0F5F5C" }} />
          <div>
            <h3 className="text-[14px] font-semibold text-[#1A1D1A]">Conversation Labels</h3>
            <p className="text-[11px] text-[#6B6B64] mt-0.5">Tag conversations to organise and filter them.</p>
          </div>
        </div>
        <button onClick={openNew}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-semibold transition-opacity hover:opacity-80"
          style={{ background: "rgba(15,95,92,0.12)", color: "#0F5F5C", border: "1px solid rgba(15,95,92,0.20)" }}>
          <Plus size={13} /> New Label
        </button>
      </div>

      {/* New / edit form */}
      {editing && (
        <div className="rounded-xl p-4 space-y-3"
          style={{ background: "#EDE7D7", border: "1px solid #EDE7D7" }}>
          <div className="flex gap-3">
            <input
              value={formName}
              onChange={e => setFormName(e.target.value)}
              maxLength={50}
              placeholder="Label name…"
              className="flex-1 px-3 py-2 rounded-lg text-[13px] outline-none"
              style={inputStyle}
              onKeyDown={e => e.key === "Enter" && handleSave()}
            />
            {/* Color preview */}
            <div className="w-9 h-9 rounded-lg shrink-0" style={{ background: formColor, border: "2px solid #D8D0BD" }} />
          </div>
          {/* Color presets */}
          <div className="flex gap-2 flex-wrap">
            {PRESET_COLORS.map(c => (
              <button key={c} onClick={() => setFormColor(c)}
                className="w-6 h-6 rounded-full transition-transform hover:scale-110"
                style={{ background: c, outline: formColor === c ? `2px solid ${c}` : "none", outlineOffset: 2 }} />
            ))}
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={cancel} className="px-3 py-1.5 rounded-lg text-[12px]" style={{ color: "#6B6B64" }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={!formName.trim() || saving}
              className="px-4 py-1.5 rounded-lg text-[12px] font-semibold disabled:opacity-50 transition-opacity hover:opacity-80"
              style={{ background: "linear-gradient(135deg, #0F5F5C, #083A38)", color: "#F5F1E8" }}>
              {saving ? "Saving…" : editing === "new" ? "Create" : "Save"}
            </button>
          </div>
        </div>
      )}

      {/* Labels list */}
      {loading ? (
        <div className="space-y-2 animate-pulse">
          {[1,2,3].map(i => <div key={i} className="h-10 rounded-lg" style={{ background: "#EDE7D7" }} />)}
        </div>
      ) : labels.length === 0 && !editing ? (
        <div className="text-center py-8">
          <Tag size={28} className="mx-auto mb-2" style={{ color: "#EDE7D7" }} />
          <p className="text-[12px]" style={{ color: "#6B6B64" }}>No labels yet. Create one to start tagging conversations.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {labels.map(l => (
            <div key={l.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl group"
              style={{ background: "rgba(255,255,255,0.025)" }}>
              <span className="w-3 h-3 rounded-full shrink-0" style={{ background: l.color }} />
              <span className="flex-1 text-[13px]" style={{ color: "#3A3D39" }}>{l.name}</span>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => openEdit(l)}
                  className="p-1.5 rounded-lg transition-colors hover:opacity-70"
                  style={{ color: "#6B6B64" }}>
                  <Pencil size={12} />
                </button>
                <button onClick={() => handleDelete(l.id)}
                  className="p-1.5 rounded-lg transition-colors hover:opacity-70"
                  style={{ color: "#7A1F1A" }}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default LabelsSection;
