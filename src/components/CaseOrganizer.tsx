"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Company, CaseRoom } from "@/types";
import FilePreview from "./FilePreview";

interface Props {
  company: Company | null;
  caseRoom?: CaseRoom;
  visible?: boolean;
  onUpdate?: () => void;
}

export default function CaseOrganizer({ company, caseRoom, visible, onUpdate }: Props) {
  const [result, setResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sourceFiles, setSourceFiles] = useState<{ id: string; name: string; mimeType: string }[]>([]);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [sourceLinks, setSourceLinks] = useState<Record<string, { id: string; name: string }[]>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [result]);

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">サイドバーから会社を選択してください</p>
      </div>
    );
  }

  const savedResult = caseRoom?.masterSheet?.content || company.masterSheet?.content || "";
  const displayResult = result || savedResult;

  const handleExecute = async () => {
    setIsLoading(true);
    setResult("");
    setSourceFiles([]);
    setSourceLinks({});

    try {
      const res = await fetch("/api/templates/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id }),
      });

      if (!res.ok) {
        const err = await res.json();
        setResult(`エラー: ${err.error || "実行に失敗しました"}`);
        setIsLoading(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";
      let metaSourceFiles: { id: string; name: string; mimeType: string }[] = [];

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

          if (data.type === "meta") {
            metaSourceFiles = data.sourceFiles || [];
            setSourceFiles(metaSourceFiles);
          } else if (data.type === "text") {
            setResult(prev => prev + data.text);
          }
        }
      }

      setIsLoading(false);

      // Haikuで各セクションとファイルの紐付け
      if (metaSourceFiles.length > 0) {
        const finalResult = await new Promise<string>(resolve => {
          setResult(prev => { resolve(prev); return prev; });
        });
        try {
          const linkRes = await fetch("/api/templates/link-sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: finalResult, sourceFiles: metaSourceFiles }),
          });
          if (linkRes.ok) {
            const { links } = await linkRes.json();
            setSourceLinks(links);
          }
        } catch { /* ignore */ }
      }

      // マスターシートとして保存
      if (company) {
        const finalResult = await new Promise<string>(resolve => {
          setResult(prev => { resolve(prev); return prev; });
        });
        const masterData = {
          templateId: "",
          templateName: "案件整理",
          content: finalResult,
          sourceFiles: metaSourceFiles,
          createdAt: new Date().toISOString(),
        };
        try {
          if (caseRoom) {
            await fetch("/api/workspace", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "saveCaseRoomMasterSheet",
                companyId: company.id,
                caseRoomId: caseRoom.id,
                masterSheet: masterData,
              }),
            });
          } else {
            await fetch("/api/templates/save-master", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ companyId: company.id, ...masterData }),
            });
          }
          onUpdate?.();
        } catch { /* ignore */ }
      }
    } catch {
      setIsLoading(false);
      setResult("エラーが発生しました");
    }
  };

  return (
    <div id="main-content-area" className="flex h-full overflow-hidden">
      <div className={`flex flex-col overflow-hidden ${previewFileId ? "flex-1 min-w-0" : "w-full"} transition-all`}>
        {/* ヘッダー */}
        <div className="border-b border-gray-200 px-6 py-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-900">{company.name}</h2>
          <div className="flex items-center gap-2">
            {displayResult && !isLoading && (
              <button
                onClick={async () => {
                  if (!confirm("案件整理の結果を削除しますか？")) return;
                  setResult("");
                  setSourceLinks({});
                  if (company) {
                    if (caseRoom) {
                      await fetch("/api/workspace", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          action: "updateCaseRoom",
                          companyId: company.id,
                          caseRoomId: caseRoom.id,
                          masterSheet: null,
                        }),
                      });
                    } else {
                      await fetch("/api/workspace", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "deleteMasterSheet", companyId: company.id }),
                      });
                    }
                    onUpdate?.();
                  }
                }}
                className="text-[10px] text-red-400 hover:text-red-600 transition-colors"
              >
                削除
              </button>
            )}
          </div>
        </div>

        {/* 結果 */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 flex justify-center">
          <div className="w-full max-w-4xl">
          {displayResult ? (
            <>
              {isLoading && (
                <div className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                  {result}
                  <span className="animate-pulse">▍</span>
                </div>
              )}
              {!isLoading && (
                <div className="prose prose-sm max-w-none text-gray-800
                                prose-headings:text-gray-900 prose-headings:font-semibold
                                prose-h2:text-base prose-h2:mt-3 prose-h2:mb-1
                                prose-p:leading-snug prose-p:my-0.5
                                prose-table:border-collapse prose-table:w-full prose-table:my-0.5
                                prose-th:border prose-th:border-gray-300 prose-th:bg-gray-50 prose-th:px-2 prose-th:py-1 prose-th:text-left prose-th:text-xs
                                prose-td:border prose-td:border-gray-300 prose-td:px-2 prose-td:py-1 prose-td:text-sm
                                prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h2: ({ children }) => {
                        const text = String(children).trim();
                        const cleanText = text.replace(/^#+\s*/, "").replace(/^\d+\.\s*/, "");
                        const files = sourceLinks[text] || sourceLinks[cleanText] ||
                          Object.entries(sourceLinks).find(([k]) => k.includes(cleanText) || cleanText.includes(k))?.[1];
                        return (
                          <h2>
                            {children}
                            {files && files.map((f, i) => (
                              <button
                                key={i}
                                onClick={() => setPreviewFileId(previewFileId === f.id ? null : f.id)}
                                className="ml-2 inline-flex items-center gap-0.5 text-[10px] font-normal text-blue-500 hover:text-blue-700 align-middle"
                              >
                                📄{f.name}
                              </button>
                            ))}
                          </h2>
                        );
                      },
                    }}
                  >
                    {displayResult}
                  </ReactMarkdown>
                </div>
              )}

              {/* 参照元資料 */}
              {(sourceFiles.length > 0 || caseRoom?.masterSheet?.sourceFiles || company.masterSheet?.sourceFiles) && !isLoading && (
                <div className="mt-4 border-t border-gray-100 pt-3">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">参照元資料</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(sourceFiles.length > 0 ? sourceFiles : caseRoom?.masterSheet?.sourceFiles || company.masterSheet?.sourceFiles || []).map((f, i) => (
                      <button
                        key={`${f.id}-${i}`}
                        onClick={() => setPreviewFileId(previewFileId === f.id ? null : f.id)}
                        className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                          previewFileId === f.id
                            ? "bg-blue-100 text-blue-700"
                            : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                        }`}
                      >
                        📄 {f.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-3xl mb-4">📋</p>
                <p className="text-sm text-gray-500 mb-4">サイドバーで選択したフォルダの資料を<br />AIが自動で抽出・整理します</p>
                <button
                  onClick={handleExecute}
                  disabled={isLoading}
                  className="rounded-lg bg-blue-600 px-8 py-3 text-sm font-bold text-white hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
                >
                  {isLoading ? "整理中..." : "案件を整理"}
                </button>
              </div>
            </div>
          )}
          </div>
        </div>
      </div>

      {/* 右: ファイルプレビュー */}
      {previewFileId && (
        <FilePreview
          filePath={previewFileId}
          fileName={(sourceFiles.length > 0 ? sourceFiles : caseRoom?.masterSheet?.sourceFiles || company.masterSheet?.sourceFiles || []).find(f => f.id === previewFileId)?.name || ""}
          onClose={() => setPreviewFileId(null)}
        />
      )}
    </div>
  );
}
