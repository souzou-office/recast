"use client";

import { useState, useEffect } from "react";
import type { CheckTemplate } from "@/types";

interface PromptTemplate {
  id: string;
  label: string;
  prompt: string;
}

const DEFAULT_PROMPTS: PromptTemplate[] = [
  { id: "summary", label: "案件の概要を教えて", prompt: "この案件の概要を簡潔にまとめてください。" },
  { id: "officers", label: "役員構成を確認", prompt: "現在の役員構成（役職・氏名・就任日・任期満了時期）を教えてください。" },
  { id: "shareholders", label: "株主構成を確認", prompt: "株主構成（氏名・持株数・持株比率）を教えてください。" },
  { id: "schedule", label: "スケジュール確認", prompt: "この案件のスケジュール（各タスクと期限）を教えてください。" },
  { id: "documents", label: "必要書類を確認", prompt: "この案件で必要な書類一覧を教えてください。" },
  { id: "issues", label: "注意点を確認", prompt: "この案件で注意すべき点や確認が必要な事項を教えてください。" },
];

interface Props {
  tab: string;
  onSelectPrompt: (prompt: string) => void;
  onSelectTemplate: (templateId: string) => void;
}

export default function TemplateSidebar({ tab, onSelectPrompt, onSelectTemplate }: Props) {
  const [templates, setTemplates] = useState<CheckTemplate[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/templates");
        if (res.ok) {
          const data = await res.json();
          setTemplates(Array.isArray(data) ? data : []);
        }
      } catch { /* ignore */ }
    };
    load();
  }, []);

  return (
    <aside className="w-56 shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto">
      {tab === "chat" ? (
        <div className="p-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
            プロンプト
          </h3>
          <ul className="space-y-1">
            {DEFAULT_PROMPTS.map(p => (
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
        </div>
      ) : tab === "organize" ? (
        <div className="p-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
            テンプレート
          </h3>
          {templates.length === 0 ? (
            <p className="text-[10px] text-gray-400 py-2">テンプレートがありません</p>
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
