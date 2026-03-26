"use client";

import { useState, useEffect } from "react";
import type { CheckTemplate } from "@/types";

interface PromptTemplate {
  id: string;
  label: string;
  prompt: string;
}

interface Props {
  tab: string;
  onSelectPrompt: (prompt: string) => void;
  onSelectTemplate: (templateId: string) => void;
}

export default function TemplateSidebar({ tab, onSelectPrompt, onSelectTemplate }: Props) {
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [templates, setTemplates] = useState<CheckTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");

  useEffect(() => {
    if (tab === "chat") {
      fetch("/api/prompt-templates").then(r => r.json()).then(d => setPrompts(d.templates || [])).catch(() => {});
    } else if (tab === "organize") {
      fetch("/api/templates").then(r => r.json()).then(d => {
        const list = Array.isArray(d) ? d : [];
        setTemplates(list);
        if (list.length > 0 && !selectedTemplateId) setSelectedTemplateId(list[0].id);
      }).catch(() => {});
    }
  }, [tab]);

  const selectedTemplate = templates.find(t => t.id === selectedTemplateId);

  return (
    <aside className="w-56 shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto flex flex-col">
      {tab === "chat" ? (
        <div className="p-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
            プロンプト
          </h3>
          {prompts.length === 0 ? (
            <p className="text-[10px] text-gray-400 py-2">設定タブから追加してください</p>
          ) : (
            <ul className="space-y-1">
              {prompts.map(p => (
                <li key={p.id}>
                  <button
                    onClick={() => onSelectPrompt(p.prompt)}
                    className="w-full text-left rounded-lg px-2.5 py-1.5 text-xs text-gray-600 hover:bg-white hover:text-blue-600 transition-colors"
                  >
                    {p.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : tab === "organize" ? (
        <div className="p-3 flex flex-col h-full">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
            テンプレート
          </h3>
          {templates.length === 0 ? (
            <p className="text-[10px] text-gray-400 py-2">設定タブから追加してください</p>
          ) : (
            <>
              {/* プルダウン */}
              <select
                value={selectedTemplateId}
                onChange={e => setSelectedTemplateId(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-700 mb-3 focus:border-blue-400 focus:outline-none"
              >
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>

              {/* 確認項目一覧 */}
              {selectedTemplate && (
                <div className="flex-1 overflow-y-auto mb-3">
                  <p className="text-[10px] text-gray-400 mb-1">確認項目</p>
                  <ul className="space-y-0.5">
                    {selectedTemplate.items.map((item, i) => (
                      <li key={i} className="text-xs text-gray-600 rounded px-2 py-1 bg-white">
                        {i + 1}. {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 実行ボタン */}
              <button
                onClick={() => selectedTemplateId && onSelectTemplate(selectedTemplateId)}
                disabled={!selectedTemplateId}
                className="w-full rounded-lg bg-blue-600 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
              >
                案件を整理
              </button>
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}
