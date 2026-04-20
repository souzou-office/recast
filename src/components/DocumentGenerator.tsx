"use client";

import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Company, CaseRoom, GeneratedDocument } from "@/types";
import FilePreview from "./FilePreview";

interface TemplateFolder {
  name: string;
  path: string;
  files: { name: string; path: string }[];
}

interface Props {
  company: Company | null;
  caseRoom?: CaseRoom;
  onUpdate?: () => void;
}

function downloadDocx(base64: string, fileName: string) {
  const byteChars = atob(base64);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
  const blob = new Blob([byteArray], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export default function DocumentGenerator({ company, caseRoom, onUpdate }: Props) {
  const [templateFolders, setTemplateFolders] = useState<TemplateFolder[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateFolder | null>(null);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState("");
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [templateBasePath, setTemplateBasePath] = useState<string>("");

  // プレビュー中のドキュメント
  const [viewingDoc, setViewingDoc] = useState<GeneratedDocument | null>(null);
  const [deleteChecked, setDeleteChecked] = useState<Set<number>>(new Set());

  useEffect(() => {
    fetch("/api/workspace").then(r => r.json()).then(config => {
      if (config.templateBasePath) {
        setTemplateBasePath(config.templateBasePath);
        loadTemplateFolders(config.templateBasePath);
      }
    }).catch(() => {});
  }, []);

  const loadTemplateFolders = async (basePath: string) => {
    try {
      const res = await fetch("/api/workspace/list-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: basePath }),
      });
      const data = await res.json();
      const folders: TemplateFolder[] = [];
      for (const sf of data.subfolders || []) {
        const subRes = await fetch("/api/workspace/list-files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sf.path }),
        });
        const subData = await subRes.json();
        folders.push({ name: sf.name, path: sf.path, files: subData.files || [] });
      }
      setTemplateFolders(folders);
    } catch { /* ignore */ }
  };

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-hover)]">
        <p className="text-sm text-[var(--color-fg-subtle)]">サイドバーから会社を選択してください</p>
      </div>
    );
  }

  const hasMasterSheet = !!(caseRoom?.masterSheet || company.masterSheet);
  const savedDocs = caseRoom?.generatedDocuments || company.generatedDocuments || [];

  const handleGenerate = async () => {
    if (!selectedTemplate) return;
    setGenerating(true);
    setResult("");
    setViewingDoc(null);

    const hasDocx = selectedTemplate.files.some(f =>
      (f.name.endsWith(".docx") || f.name.endsWith(".doc")) &&
      !f.name.toLowerCase().includes("メモ") && !f.name.toLowerCase().includes("memo")
    );

    try {
      const res = await fetch("/api/document-templates/produce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id, templateFolderPath: selectedTemplate.path, caseRoomId: caseRoom?.id }),
      });

      const contentType = res.headers.get("Content-Type") || "";

      if (hasDocx && contentType.includes("application/json")) {
        const data = await res.json();
        if (data.documents && data.documents.length > 0) {
          // 複数ドキュメントを保存
          for (const d of data.documents) {
            await fetch("/api/workspace", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(caseRoom ? {
                action: "saveCaseRoomDocument",
                companyId: company.id,
                caseRoomId: caseRoom.id,
                templateName: d.name,
                docxBase64: d.docxBase64,
                previewHtml: d.previewHtml,
                fileName: d.fileName,
              } : {
                action: "saveGeneratedDocument",
                companyId: company.id,
                templateName: d.name,
                docxBase64: d.docxBase64,
                previewHtml: d.previewHtml,
                fileName: d.fileName,
              }),
            });
          }
          onUpdate?.();
          // 最初のドキュメントをプレビュー
          setViewingDoc({
            templateName: data.documents[0].name,
            docxBase64: data.documents[0].docxBase64,
            previewHtml: data.documents[0].previewHtml,
            fileName: data.documents[0].fileName,
            createdAt: new Date().toISOString(),
          });
        } else if (data.error) {
          setResult(`エラー: ${data.error}`);
        }
      } else {
        // ストリーミングテキスト
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
            if (data.type === "text") setResult(prev => prev + data.text);
          }
        }
      }
    } catch { /* ignore */ }
    finally { setGenerating(false); }
  };

  const handleDeleteDoc = async (index: number) => {
    if (!confirm("この書類を削除しますか？")) return;
    if (caseRoom) {
      const updated = [...savedDocs];
      updated.splice(index, 1);
      await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "updateCaseRoom",
          companyId: company.id,
          caseRoomId: caseRoom.id,
          generatedDocuments: updated,
        }),
      });
    } else {
      await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deleteGeneratedDocument", companyId: company.id, index }),
      });
    }
    if (viewingDoc === savedDocs[index]) setViewingDoc(null);
    onUpdate?.();
  };

  if (!templateBasePath) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-[var(--color-fg-subtle)]">
          <p className="text-3xl mb-2">📝</p>
          <p className="text-sm">設定で書類テンプレートフォルダを指定してください</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className={`flex flex-col overflow-hidden ${previewFileId || viewingDoc ? "flex-1 min-w-0" : "w-full"} transition-all`}>
        <div className="border-b border-[var(--color-border)] px-6 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-[var(--color-fg)]">{company.name}</h2>
            <span className={`rounded px-2 py-0.5 text-[10px] ${hasMasterSheet ? "bg-green-100 text-[var(--color-ok-fg)]" : "bg-[var(--color-hover)] text-[var(--color-fg-muted)]"}`}>
              案件整理 {hasMasterSheet ? "✓" : "未生成"}
            </span>
          </div>
          {viewingDoc && (
            <button
              onClick={() => setViewingDoc(null)}
              className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]"
            >
              一覧に戻る
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-6 flex justify-center">
          <div className="w-full max-w-4xl">

          {result ? (
            <>
              {generating ? (
                <div className="text-sm text-[var(--color-fg)] whitespace-pre-wrap leading-relaxed">
                  {result}<span className="animate-pulse">▍</span>
                </div>
              ) : (
                <div className="prose prose-sm max-w-none text-[var(--color-fg)]
                                prose-headings:text-[var(--color-fg)] prose-headings:font-semibold
                                prose-h2:text-base prose-h2:mt-3 prose-h2:mb-1">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{result}</ReactMarkdown>
                </div>
              )}
            </>
          ) : (
            <div>
              <h2 className="text-lg font-bold text-[var(--color-fg)] mb-4">書類を生成する</h2>

              {/* 保存済みドキュメント */}
              {savedDocs.length > 0 && (
                <div className="mb-6">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-semibold text-[var(--color-fg-muted)]">生成済み書類</h3>
                    {deleteChecked.size > 0 && (
                      <button
                        onClick={async () => {
                          if (!confirm(`${deleteChecked.size}件の書類を削除しますか？`)) return;
                          // インデックスの大きい方から削除
                          const indices = Array.from(deleteChecked).sort((a, b) => b - a);
                          if (caseRoom) {
                            const updated = savedDocs.filter((_, i) => !deleteChecked.has(i));
                            await fetch("/api/workspace", {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                action: "updateCaseRoom",
                                companyId: company.id,
                                caseRoomId: caseRoom.id,
                                generatedDocuments: updated,
                              }),
                            });
                          } else {
                            for (const idx of indices) {
                              await fetch("/api/workspace", {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: "deleteGeneratedDocument", companyId: company.id, index: idx }),
                              });
                            }
                          }
                          setDeleteChecked(new Set());
                          if (viewingDoc && deleteChecked.has(savedDocs.indexOf(viewingDoc))) setViewingDoc(null);
                          onUpdate?.();
                        }}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        {deleteChecked.size}件を削除
                      </button>
                    )}
                  </div>
                  <div className="space-y-1">
                    {savedDocs.map((doc, i) => (
                      <div key={i} className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
                        <input
                          type="checkbox"
                          checked={deleteChecked.has(i)}
                          onChange={() => setDeleteChecked(prev => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i); else next.add(i);
                            return next;
                          })}
                          className="w-4 h-4 shrink-0"
                        />
                        <button
                          onClick={() => setViewingDoc(doc)}
                          className="flex-1 text-left"
                        >
                          <span className="text-sm text-[var(--color-fg)] font-medium">{doc.templateName}</span>
                          <span className="text-[10px] text-[var(--color-fg-subtle)] ml-2">{new Date(doc.createdAt).toLocaleString("ja-JP")}</span>
                        </button>
                        <button
                          onClick={() => downloadDocx(doc.docxBase64, doc.fileName)}
                          className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] shrink-0"
                        >
                          DL
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* テンプレート選択（生成済み書類がなければ表示） */}
              {savedDocs.length === 0 && (
                <>
              {!hasMasterSheet && (
                <p className="text-xs text-[var(--color-warn-fg)] bg-[var(--color-warn-bg)] rounded-lg px-3 py-2 mb-4">
                  案件整理を先に実行してください。
                </p>
              )}
              <h3 className="text-xs font-semibold text-[var(--color-fg-muted)] mb-2">テンプレートから生成</h3>
              <div className="grid grid-cols-1 gap-3">
                {templateFolders.map(tf => {
                  const isSelected = selectedTemplate?.path === tf.path;
                  return (
                    <div
                      key={tf.path}
                      className={`rounded-xl border-2 cursor-pointer transition-all ${
                        isSelected ? "border-blue-500 bg-[var(--color-accent-soft)] shadow-sm" : "border-[var(--color-border)] hover:border-[var(--color-accent)]/30"
                      }`}
                      onClick={() => setSelectedTemplate(isSelected ? null : tf)}
                    >
                      <div className="px-5 py-4 flex items-center justify-between">
                        <h3 className={`text-base font-bold ${isSelected ? "text-[var(--color-accent-fg)]" : "text-[var(--color-fg)]"}`}>{tf.name}</h3>
                        <span className="text-[10px] text-[var(--color-fg-subtle)]">{tf.files.length}ファイル</span>
                      </div>
                      {isSelected && (
                        <>
                          <div className="border-t border-[var(--color-accent-soft)] px-5 py-3">
                            {tf.files.map(f => (
                              <button key={f.path}
                                onClick={(e) => { e.stopPropagation(); setPreviewFileId(f.path); }}
                                className="block text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] hover:underline py-0.5"
                              >📄 {f.name}</button>
                            ))}
                          </div>
                          <div className="px-5 py-4">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleGenerate(); }}
                              disabled={generating || !hasMasterSheet}
                              className="w-full rounded-lg bg-[var(--color-fg)] py-3 text-sm font-bold text-white hover:opacity-90 disabled:bg-gray-300"
                            >
                              {generating ? "生成中..." : "この書式で書類を生成"}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
                {templateFolders.length === 0 && (
                  <p className="text-sm text-[var(--color-fg-subtle)] py-4 text-center">テンプレートフォルダにフォルダがありません</p>
                )}
              </div>
                </>
              )}
            </div>
          )}

          </div>
        </div>

      </div>

      {viewingDoc && (
        <FilePreview
          docxBase64={viewingDoc.docxBase64}
          fileName={viewingDoc.fileName}
          onClose={() => setViewingDoc(null)}
        />
      )}
      {!viewingDoc && previewFileId && (
        <FilePreview
          filePath={previewFileId}
          fileName={previewFileId.split(/[\\/]/).pop() || ""}
          onClose={() => setPreviewFileId(null)}
        />
      )}
    </div>
  );
}
