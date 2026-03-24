"use client";

import { useState, useEffect, useCallback } from "react";
import type { Company, DocumentTemplate } from "@/types";

interface Props {
  company: Company | null;
}

export default function DocumentGenerator({ company }: Props) {
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState("");
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [templateFiles, setTemplateFiles] = useState<{ id: string; name: string; mimeType: string }[]>([]);

  const fetchTemplates = useCallback(async () => {
    const res = await fetch("/api/document-templates");
    if (res.ok) {
      const data = await res.json();
      setTemplates(data.templates);
    }
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">サイドバーから会社を選択してください</p>
      </div>
    );
  }

  const hasMasterSheet = !!company.masterSheet?.structured;
  const hasProfile = !!company.profile?.structured;

  // 雛形を過去案件から生成
  const handleGenerateTemplate = async () => {
    if (templateFiles.length === 0) return;
    setCreatingTemplate(true);
    try {
      const res = await fetch("/api/document-templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: templateFiles }),
      });
      if (res.ok) {
        const { templates: generated } = await res.json();
        // 生成された雛形を保存
        for (const t of generated) {
          await fetch("/api/document-templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(t),
          });
        }
        await fetchTemplates();
        setTemplateFiles([]);
      }
    } catch { /* ignore */ }
    finally { setCreatingTemplate(false); }
  };

  // 書類生成
  const handleProduce = async () => {
    if (selectedIds.size === 0) return;
    setGenerating(true);
    setResult("");
    try {
      const res = await fetch("/api/document-templates/produce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          templateIds: Array.from(selectedIds),
        }),
      });

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const match = line.match(/^data: (.+)$/m);
          if (!match) continue;
          const data = JSON.parse(match[1]);
          if (data.type === "text") {
            setResult(prev => prev + data.text);
          }
        }
      }
    } catch { /* ignore */ }
    finally { setGenerating(false); }
  };

  // 雛形削除
  const handleDeleteTemplate = async (id: string) => {
    if (!confirm("この雛形を削除しますか？")) return;
    await fetch("/api/document-templates", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await fetchTemplates();
    setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
  };

  // 案件フォルダのファイル一覧
  const jobFiles = company.subfolders
    .filter(s => s.role === "job" && s.active && s.files)
    .flatMap(s => s.files || [])
    .filter(f => f.enabled);

  return (
    <div className="flex h-full">
      {/* 左: 設定 */}
      <div className="w-1/2 border-r border-gray-200 overflow-y-auto">
        <div className="p-6 space-y-6">
          {/* ステータス */}
          <div>
            <h2 className="text-lg font-bold text-gray-900 mb-2">{company.name}</h2>
            <div className="flex gap-2">
              <span className={`rounded px-2 py-0.5 text-xs ${hasProfile ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                基本情報 {hasProfile ? "✓" : "未生成"}
              </span>
              <span className={`rounded px-2 py-0.5 text-xs ${hasMasterSheet ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                マスターシート {hasMasterSheet ? "✓" : "未生成"}
              </span>
            </div>
          </div>

          {/* 雛形一覧 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-700">書類雛形</h3>
            </div>
            {templates.length === 0 ? (
              <p className="text-xs text-gray-400 py-2">雛形がありません。過去案件から作成してください。</p>
            ) : (
              <div className="space-y-1">
                {templates.map(t => (
                  <div key={t.id} className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(t.id)}
                      onChange={() => {
                        setSelectedIds(prev => {
                          const next = new Set(prev);
                          if (next.has(t.id)) next.delete(t.id);
                          else next.add(t.id);
                          return next;
                        });
                      }}
                    />
                    <div className="flex-1">
                      <span className="text-sm text-gray-700">{t.name}</span>
                      <span className="ml-2 text-[10px] text-gray-400">{t.category}</span>
                    </div>
                    <button
                      onClick={() => handleDeleteTemplate(t.id)}
                      className="text-[10px] text-red-400 hover:text-red-600"
                    >
                      削除
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 過去案件から雛形作成 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">過去案件から雛形作成</h3>
            <p className="text-xs text-gray-400 mb-2">案件フォルダのファイルを選択して雛形を自動生成します</p>
            {jobFiles.length === 0 ? (
              <p className="text-xs text-gray-400">案件フォルダのファイルがありません</p>
            ) : (
              <>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {jobFiles.map(f => (
                    <label key={f.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={templateFiles.some(tf => tf.id === f.id)}
                        onChange={() => {
                          setTemplateFiles(prev => {
                            if (prev.some(tf => tf.id === f.id)) {
                              return prev.filter(tf => tf.id !== f.id);
                            }
                            return [...prev, { id: f.id, name: f.name, mimeType: f.mimeType }];
                          });
                        }}
                      />
                      <span className="text-xs text-gray-600">{f.name}</span>
                    </label>
                  ))}
                </div>
                <button
                  onClick={handleGenerateTemplate}
                  disabled={creatingTemplate || templateFiles.length === 0}
                  className="mt-2 w-full rounded-lg bg-gray-800 py-2 text-xs text-white hover:bg-gray-700 disabled:bg-gray-300 transition-colors"
                >
                  {creatingTemplate ? "雛形生成中..." : `${templateFiles.length}件から雛形を作成`}
                </button>
              </>
            )}
          </div>

          {/* 書類生成ボタン */}
          <button
            onClick={handleProduce}
            disabled={generating || selectedIds.size === 0 || (!hasProfile && !hasMasterSheet)}
            className="w-full rounded-lg bg-blue-600 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
          >
            {generating ? "書類生成中..." : `選択した雛形で書類を生成（${selectedIds.size}件）`}
          </button>
        </div>
      </div>

      {/* 右: 生成結果 */}
      <div className="w-1/2 overflow-y-auto bg-white">
        {result ? (
          <pre className="p-6 text-sm text-gray-800 whitespace-pre-wrap leading-relaxed font-mono">
            {result}
          </pre>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center text-gray-400">
              <p className="text-3xl mb-2">📝</p>
              <p className="text-sm">雛形を選択して書類を生成</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
