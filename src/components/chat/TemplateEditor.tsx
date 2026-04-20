"use client";

import { useState } from "react";
import type { CheckTemplate } from "@/types";

interface Props {
  template: CheckTemplate;
  onSave: (template: CheckTemplate) => void;
  onClose: () => void;
}

export default function TemplateEditor({ template, onSave, onClose }: Props) {
  const [name, setName] = useState(template.name);
  const [items, setItems] = useState<string[]>([...template.items]);
  const [generating, setGenerating] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const addItem = () => setItems([...items, ""]);

  const removeItem = (i: number) => setItems(items.filter((_, idx) => idx !== i));

  const updateItem = (i: number, value: string) => {
    const updated = [...items];
    updated[i] = value;
    setItems(updated);
  };

  const moveItem = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const updated = [...items];
    [updated[i], updated[j]] = [updated[j], updated[i]];
    setItems(updated);
  };

  // AIで項目を自動生成
  const generateItems = async () => {
    if (!name.trim()) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseType: name.trim() }),
      });
      if (res.ok) {
        const { items: generated } = await res.json();
        setItems(generated);
      }
    } catch { /* ignore */ }
    finally { setGenerating(false); }
  };

  const handleSave = () => {
    const validItems = items.filter(i => i.trim());
    onSave({ ...template, name: name.trim(), items: validItems });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-2xl bg-[var(--color-panel)] shadow-xl flex flex-col" style={{ maxHeight: "85vh" }}>
        <div className="border-b border-[var(--color-border)] px-6 py-4">
          <h3 className="text-lg font-semibold text-[var(--color-fg)]">テンプレート編集</h3>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="案件タイプ名（例: 本店移転）"
              className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm
                         focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={generateItems}
              disabled={generating || !name.trim()}
              className="shrink-0 rounded-lg bg-[var(--color-accent-soft)] border border-[var(--color-accent-soft)] px-3 py-2 text-xs font-medium text-[var(--color-accent-fg)]
                         hover:bg-[var(--color-accent-soft)] disabled:bg-[var(--color-hover)] disabled:text-[var(--color-fg-subtle)] disabled:border-[var(--color-border)] transition-colors"
            >
              {generating ? "生成中..." : "AIで生成"}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-1.5">
            {items.map((item, i) => (
              <div
                key={i}
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragOver={e => { e.preventDefault(); setDragOverIndex(i); }}
                onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
                onDrop={() => {
                  if (dragIndex !== null && dragIndex !== i) {
                    const updated = [...items];
                    const [moved] = updated.splice(dragIndex, 1);
                    updated.splice(i, 0, moved);
                    setItems(updated);
                  }
                  setDragIndex(null);
                  setDragOverIndex(null);
                }}
                className={`flex items-center gap-2 rounded-lg px-1 py-0.5 transition-colors ${
                  dragOverIndex === i ? "bg-[var(--color-accent-soft)]" : ""
                } ${dragIndex === i ? "opacity-50" : ""}`}
              >
                <span className="text-[var(--color-fg-subtle)] text-sm cursor-grab active:cursor-grabbing shrink-0">⠿</span>
                <input
                  type="text"
                  value={item}
                  onChange={e => updateItem(i, e.target.value)}
                  placeholder="確認項目名"
                  className="flex-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-sm
                             focus:border-blue-500 focus:outline-none"
                />
                <button onClick={() => removeItem(i)} className="text-red-400 hover:text-red-600 text-sm shrink-0">&times;</button>
              </div>
            ))}
          </div>
          <button
            onClick={addItem}
            className="mt-3 w-full rounded-lg border border-dashed border-[var(--color-border)] py-1.5 text-xs text-[var(--color-fg-muted)]
                       hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
          >
            + 項目を追加
          </button>
        </div>

        <div className="border-t border-[var(--color-border)] px-6 py-4 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]">
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || items.filter(i => i.trim()).length === 0}
            className="rounded-lg bg-[var(--color-fg)] px-4 py-2 text-sm font-medium text-white
                       hover:opacity-90 disabled:bg-gray-300 transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
