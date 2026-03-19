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
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl flex flex-col" style={{ maxHeight: "85vh" }}>
        <div className="border-b border-gray-200 px-6 py-4">
          <h3 className="text-lg font-semibold text-gray-900">テンプレート編集</h3>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="案件タイプ名（例: 本店移転）"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm
                         focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={generateItems}
              disabled={generating || !name.trim()}
              className="shrink-0 rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-xs font-medium text-blue-700
                         hover:bg-blue-100 disabled:bg-gray-50 disabled:text-gray-400 disabled:border-gray-200 transition-colors"
            >
              {generating ? "生成中..." : "AIで生成"}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-1.5">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="flex flex-col shrink-0">
                  <button onClick={() => moveItem(i, -1)} className="text-[10px] text-gray-400 hover:text-gray-600 leading-none">▲</button>
                  <button onClick={() => moveItem(i, 1)} className="text-[10px] text-gray-400 hover:text-gray-600 leading-none">▼</button>
                </div>
                <input
                  type="text"
                  value={item}
                  onChange={e => updateItem(i, e.target.value)}
                  placeholder="確認項目名"
                  className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm
                             focus:border-blue-500 focus:outline-none"
                />
                <button onClick={() => removeItem(i)} className="text-red-400 hover:text-red-600 text-sm">&times;</button>
              </div>
            ))}
          </div>
          <button
            onClick={addItem}
            className="mt-3 w-full rounded-lg border border-dashed border-gray-300 py-1.5 text-xs text-gray-500
                       hover:border-blue-400 hover:text-blue-600 transition-colors"
          >
            + 項目を追加
          </button>
        </div>

        <div className="border-t border-gray-200 px-6 py-4 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || items.filter(i => i.trim()).length === 0}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white
                       hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
