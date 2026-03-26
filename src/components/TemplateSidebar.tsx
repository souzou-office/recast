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

  useEffect(() => {
    if (tab === "chat") {
      fetch("/api/prompt-templates").then(r => r.json()).then(d => setPrompts(d.templates || [])).catch(() => {});
    } else if (tab === "organize") {
      fetch("/api/templates").then(r => r.json()).then(d => setTemplates(Array.isArray(d) ? d : [])).catch(() => {});
    }
  }, [tab]);

  return (
    <aside className="w-56 shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto">
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
        <div className="p-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
            テンプレート
          </h3>
          {templates.length === 0 ? (
            <p className="text-[10px] text-gray-400 py-2">設定タブから追加してください</p>
          ) : (
            <ul className="space-y-1">
              {templates.map(t => (
                <li key={t.id}>
                  <button
                    onClick={() => onSelectTemplate(t.id)}
                    className="w-full text-left rounded-lg px-2.5 py-1.5 text-xs text-gray-600 hover:bg-white hover:text-blue-600 transition-colors"
                  >
                    {t.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </aside>
  );
}
