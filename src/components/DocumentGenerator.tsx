"use client";

import { useState, useEffect, useCallback } from "react";
import type { Company, DocumentTemplate } from "@/types";

interface SuggestedDoc {
  name: string;
  reason: string;
  required: boolean;
}

interface Props {
  company: Company | null;
}

export default function DocumentGenerator({ company }: Props) {
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState("");

  // 雛形作成
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [templateFiles, setTemplateFiles] = useState<{ id: string; name: string; mimeType: string }[]>([]);

  // 書類提案
  const [suggestedDocs, setSuggestedDocs] = useState<SuggestedDoc[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<Set<number>>(new Set());
  const [suggesting, setSuggesting] = useState(false);
  const [showSuggestion, setShowSuggestion] = useState(false);

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

  // 必要書類の提案を取得
  const handleSuggest = async () => {
    setSuggesting(true);
    setSuggestedDocs([]);
    try {
      const res = await fetch("/api/document-templates/suggest-documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id }),
      });
      if (res.ok) {
        const { documents } = await res.json();
        setSuggestedDocs(documents);
        // 必須のものは自動選択
        const required = new Set<number>();
        documents.forEach((d: SuggestedDoc, i: number) => { if (d.required) required.add(i); });
        setSelectedDocs(required);
        setShowSuggestion(true);
      }
    } catch { /* ignore */ }
    finally { setSuggesting(false); }
  };

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

  // 書類生成（雛形あり or なし）
  const handleProduce = async () => {
    setGenerating(true);
    setResult("");

    // 選択された書類名リスト
    const docNames = Array.from(selectedDocs).map(i => suggestedDocs[i]?.name).filter(Boolean);
    const templateIds = Array.from(selectedTemplateIds);

    try {
      const res = await fetch("/api/document-templates/produce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          templateIds,
          documentNames: docNames,
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
    setSelectedTemplateIds(prev => { const next = new Set(prev); next.delete(id); return next; });
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
        <div className="p-6 space-y-5">
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

          {/* 必要書類の提案 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-700">作成する書類</h3>
              <button
                onClick={handleSuggest}
                disabled={suggesting || (!hasProfile && !hasMasterSheet)}
                className="text-xs text-blue-600 hover:text-blue-800 disabled:text-gray-400"
              >
                {suggesting ? "提案中..." : "AIで提案"}
              </button>
            </div>
            {showSuggestion && suggestedDocs.length > 0 ? (
              <div className="space-y-1">
                {suggestedDocs.map((doc, i) => (
                  <label key={i} className="flex items-start gap-2 rounded-lg bg-gray-50 px-3 py-2 cursor-pointer hover:bg-gray-100">
                    <input
                      type="checkbox"
                      checked={selectedDocs.has(i)}
                      onChange={() => {
                        setSelectedDocs(prev => {
                          const next = new Set(prev);
                          if (next.has(i)) next.delete(i);
                          else next.add(i);
                          return next;
                        });
                      }}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <span className="text-sm text-gray-700">{doc.name}</span>
                      {doc.required && <span className="ml-1 text-[10px] text-red-500">必須</span>}
                      <p className="text-[10px] text-gray-400 mt-0.5">{doc.reason}</p>
                    </div>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400 py-2">
                {!hasProfile && !hasMasterSheet
                  ? "基本情報またはマスターシートを先に生成してください"
                  : "「AIで提案」をクリックすると必要書類が表示されます"}
              </p>
            )}
          </div>

          {/* 雛形一覧 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">書類雛形（任意）</h3>
            <p className="text-[10px] text-gray-400 mb-2">雛形がある場合はそれに沿って書類を生成します</p>
            {templates.length === 0 ? (
              <p className="text-xs text-gray-400 py-1">雛形なし</p>
            ) : (
              <div className="space-y-1">
                {templates.map(t => (
                  <div key={t.id} className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-1.5">
                    <input
                      type="checkbox"
                      checked={selectedTemplateIds.has(t.id)}
                      onChange={() => {
                        setSelectedTemplateIds(prev => {
                          const next = new Set(prev);
                          if (next.has(t.id)) next.delete(t.id);
                          else next.add(t.id);
                          return next;
                        });
                      }}
                    />
                    <span className="flex-1 text-sm text-gray-700">{t.name}</span>
                    <span className="text-[10px] text-gray-400">{t.category}</span>
                    <button onClick={() => handleDeleteTemplate(t.id)} className="text-[10px] text-red-400 hover:text-red-600">削除</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 過去案件から雛形作成 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">過去案件から雛形作成</h3>
            {jobFiles.length === 0 ? (
              <p className="text-xs text-gray-400">案件フォルダのファイルがありません</p>
            ) : (
              <>
                <div className="space-y-0.5 max-h-32 overflow-y-auto">
                  {jobFiles.map(f => (
                    <label key={f.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={templateFiles.some(tf => tf.id === f.id)}
                        onChange={() => {
                          setTemplateFiles(prev =>
                            prev.some(tf => tf.id === f.id)
                              ? prev.filter(tf => tf.id !== f.id)
                              : [...prev, { id: f.id, name: f.name, mimeType: f.mimeType }]
                          );
                        }}
                      />
                      <span className="text-xs text-gray-600">{f.name}</span>
                    </label>
                  ))}
                </div>
                <button
                  onClick={handleGenerateTemplate}
                  disabled={creatingTemplate || templateFiles.length === 0}
                  className="mt-2 w-full rounded-lg bg-gray-800 py-1.5 text-xs text-white hover:bg-gray-700 disabled:bg-gray-300 transition-colors"
                >
                  {creatingTemplate ? "雛形生成中..." : `${templateFiles.length}件から雛形を作成`}
                </button>
              </>
            )}
          </div>

          {/* 書類生成ボタン */}
          <button
            onClick={handleProduce}
            disabled={generating || (selectedDocs.size === 0 && selectedTemplateIds.size === 0)}
            className="w-full rounded-lg bg-blue-600 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
          >
            {generating ? "書類生成中..." : "書類を生成"}
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
              <p className="text-sm">「AIで提案」→ 書類を選択 → 生成</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
