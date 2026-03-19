"use client";

import { useState, useEffect } from "react";
import type { CheckTemplate } from "@/types";
import TemplateEditor from "./TemplateEditor";

interface Props {
  onExecute: (templateId: string) => void;
  onClose: () => void;
}

export default function TemplateSelectModal({ onExecute, onClose }: Props) {
  const [templates, setTemplates] = useState<CheckTemplate[]>([]);
  const [suggested, setSuggested] = useState<CheckTemplate | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [jobNames, setJobNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<CheckTemplate | null>(null);

  const fetchSuggestion = () => {
    setLoading(true);
    fetch("/api/templates/suggest")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setTemplates(data.templates || []);
          setSuggested(data.suggested || null);
          setSelected(data.suggested?.id || data.templates?.[0]?.id || "");
          setJobNames(data.jobNames || []);
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchSuggestion(); }, []);

  const handleSaveTemplate = async (template: CheckTemplate) => {
    const res = await fetch("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(template),
    });
    if (res.ok) {
      const updated = await res.json();
      setTemplates(updated);
      setSelected(template.id);
    }
    setEditing(null);
  };

  const selectedTemplate = templates.find(t => t.id === selected);

  if (editing) {
    return (
      <TemplateEditor
        template={editing}
        onSave={handleSaveTemplate}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">案件を整理</h3>
        {jobNames.length > 0 && (
          <p className="text-xs text-gray-400 mb-4">
            対象: {jobNames.join(", ")}
          </p>
        )}

        {loading ? (
          <p className="text-sm text-gray-400 py-4 text-center">読み込み中...</p>
        ) : (
          <>
            <div className="mb-4">
              <label className="mb-1 block text-sm font-medium text-gray-700">
                テンプレート
              </label>
              <div className="flex gap-2">
                <select
                  value={selected}
                  onChange={e => setSelected(e.target.value)}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm
                             focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name}{t.id === suggested?.id ? "（推定）" : ""}
                    </option>
                  ))}
                </select>
                {selectedTemplate && (
                  <button
                    onClick={() => setEditing(selectedTemplate)}
                    className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 transition-colors"
                  >
                    編集
                  </button>
                )}
              </div>
              {suggested && (
                <p className="mt-1 text-xs text-blue-600">
                  案件名から「{suggested.name}」を推定しました
                </p>
              )}
            </div>

            {/* 確認項目プレビュー */}
            {selectedTemplate && (
              <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 max-h-48 overflow-y-auto">
                <p className="text-[10px] font-semibold text-gray-500 uppercase mb-2">確認項目（{selectedTemplate.items.length}件）</p>
                <ul className="space-y-1">
                  {selectedTemplate.items.map((item, i) => (
                    <li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
                      <span className="text-gray-400 mt-0.5">&#8226;</span>
                      <span>{typeof item === "string" ? item : item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex justify-between">
              <button
                onClick={() => setEditing({
                  id: `template-${Date.now()}`,
                  name: "",
                  items: [],
                })}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                + 新しいテンプレートを作成
              </button>
            </div>

            <div className="flex justify-end gap-3 mt-3">
              <button
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={() => selected && onExecute(selected)}
                disabled={!selected}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white
                           hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
              >
                実行
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
