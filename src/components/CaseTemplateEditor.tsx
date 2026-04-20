"use client";

import { useState, useEffect } from "react";

interface Template {
  id: string;
  name: string;
  items: string[];
}

export default function CaseTemplateEditor() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editItems, setEditItems] = useState<string[]>([""]);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  const load = () => {
    fetch("/api/templates").then(r => r.json()).then(d => {
      setTemplates(Array.isArray(d) ? d : []);
    }).catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const startEdit = (t: Template) => {
    setEditingId(t.id);
    setEditName(t.name);
    setEditItems([...t.items, ""]); // 末尾に空行追加
  };

  const startNew = () => {
    setEditingId("new");
    setEditName("");
    setEditItems([""]);
  };

  const cancel = () => {
    setEditingId(null);
    setEditName("");
    setEditItems([""]);
  };

  const updateItem = (index: number, value: string) => {
    setEditItems(prev => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const addItem = () => {
    setEditItems(prev => [...prev, ""]);
  };

  const removeItem = (index: number) => {
    setEditItems(prev => prev.filter((_, i) => i !== index));
  };

  const handleItemKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // 現在の位置の次に空行を挿入
      setEditItems(prev => {
        const next = [...prev];
        next.splice(index + 1, 0, "");
        return next;
      });
      // 次のinputにフォーカス（少し遅延）
      setTimeout(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>("[data-item-input]");
        inputs[index + 1]?.focus();
      }, 50);
    } else if (e.key === "Backspace" && editItems[index] === "" && editItems.length > 1) {
      e.preventDefault();
      removeItem(index);
      setTimeout(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>("[data-item-input]");
        inputs[Math.max(0, index - 1)]?.focus();
      }, 50);
    }
  };

  const save = async () => {
    const name = editName.trim();
    const items = editItems.map(s => s.trim()).filter(Boolean);
    if (!name || items.length === 0) return;

    setSaving(true);
    const id = editingId === "new" ? `template-${Date.now()}` : editingId;

    await fetch("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, items }),
    });
    setSaving(false);
    cancel();
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("このテンプレートを削除しますか？")) return;
    await fetch("/api/templates", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    load();
  };

  const generateItems = async () => {
    if (!editName.trim()) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseType: editName.trim() }),
      });
      const data = await res.json();
      if (data.items) setEditItems([...data.items, ""]);
    } catch { /* ignore */ }
    setGenerating(false);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-fg)]">案件整理テンプレート</h2>
          <p className="text-xs text-[var(--color-fg-muted)]">案件整理で使うチェック項目のテンプレートを管理します</p>
        </div>
        <button
          onClick={startNew}
          disabled={editingId !== null}
          className="rounded-lg bg-[var(--color-fg)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:bg-gray-300"
        >
          + 新規作成
        </button>
      </div>

      {/* 編集フォーム */}
      {editingId && (
        <div className="mb-4 rounded-lg border border-[var(--color-accent-soft)] bg-[var(--color-accent-soft)] p-4">
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              placeholder="テンプレート名（例: 役員辞任）"
              className="flex-1 rounded border border-[var(--color-border)] px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={generateItems}
              disabled={generating || !editName.trim()}
              className="rounded-lg border border-[var(--color-accent)]/30 bg-[var(--color-panel)] px-3 py-2 text-xs font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-soft)] disabled:bg-[var(--color-hover)] disabled:text-[var(--color-fg-subtle)] shrink-0"
            >
              {generating ? "生成中..." : "AIで生成"}
            </button>
          </div>

          <p className="text-[10px] text-[var(--color-fg-muted)] mb-2">確認項目（Enterで追加、空でBackspaceで削除）</p>
          <div className="space-y-1 mb-3">
            {editItems.map((item, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-[10px] text-[var(--color-fg-subtle)] w-5 text-right shrink-0">{i + 1}.</span>
                <input
                  data-item-input
                  type="text"
                  value={item}
                  onChange={e => updateItem(i, e.target.value)}
                  onKeyDown={e => handleItemKeyDown(e, i)}
                  placeholder="確認項目を入力"
                  className="flex-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                />
                <button
                  onClick={() => removeItem(i)}
                  className="text-[var(--color-fg-subtle)] hover:text-red-500 text-xs shrink-0"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button onClick={addItem} className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] mb-3">+ 項目を追加</button>

          <div className="flex gap-2">
            <button onClick={save} disabled={saving || !editName.trim() || editItems.filter(s => s.trim()).length === 0}
              className="rounded-lg bg-[var(--color-fg)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:bg-gray-300">
              {saving ? "保存中..." : "保存"}
            </button>
            <button onClick={cancel} className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]">
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* テンプレート一覧 */}
      <div className="space-y-2">
        {templates.map(t => (
          <div key={t.id} className="rounded-lg border border-[var(--color-border)] p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-[var(--color-fg)]">{t.name}</h3>
              <div className="flex gap-2">
                <button onClick={() => startEdit(t)} className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]">編集</button>
                <button onClick={() => remove(t.id)} className="text-xs text-red-400 hover:text-red-600">削除</button>
              </div>
            </div>
            <ul className="space-y-0.5">
              {t.items.map((item, i) => (
                <li key={i} className="text-xs text-[var(--color-fg-muted)]">{i + 1}. {item}</li>
              ))}
            </ul>
          </div>
        ))}
        {templates.length === 0 && (
          <p className="text-sm text-[var(--color-fg-subtle)] py-8 text-center">テンプレートがありません</p>
        )}
      </div>
    </div>
  );
}
