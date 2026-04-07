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
      <div className="flex h-full items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">サイドバーから会社を選択してください</p>
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
        body: JSON.stringify({ companyId: company.id, templateFolderPath: selectedTemplate.path }),
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
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "deleteGeneratedDocument", companyId: company.id, index }),
    });
    if (viewingDoc === savedDocs[index]) setViewingDoc(null);
    onUpdate?.();
  };

  if (!templateBasePath) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-gray-400">
          <p className="text-3xl mb-2">📝</p>
          <p className="text-sm">設定で書類テンプレートフォルダを指定してください</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className={`flex flex-col overflow-hidden ${previewFileId ? "w-1/2" : "w-full"} transition-all`}>
        <div className="border-b border-gray-200 px-6 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-gray-900">{company.name}</h2>
            <span className={`rounded px-2 py-0.5 text-[10px] ${hasMasterSheet ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
              案件整理 {hasMasterSheet ? "✓" : "未生成"}
            </span>
          </div>
          {viewingDoc && (
            <button
              onClick={() => setViewingDoc(null)}
              className="text-xs text-blue-500 hover:text-blue-700"
            >
              一覧に戻る
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-6 flex justify-center">
          <div className="w-full max-w-4xl">

          {/* ドキュメントプレビュー（右側に表示するため空） */}
          {viewingDoc ? (
            <div className="flex h-full items-center justify-center text-gray-400">
              <p className="text-sm">← 右側にプレビュー表示中</p>
            </div>
          ) : result ? (
            <>
              {generating ? (
                <div className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                  {result}<span className="animate-pulse">▍</span>
                </div>
              ) : (
                <div className="prose prose-sm max-w-none text-gray-800
                                prose-headings:text-gray-900 prose-headings:font-semibold
                                prose-h2:text-base prose-h2:mt-3 prose-h2:mb-1">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{result}</ReactMarkdown>
                </div>
              )}
            </>
          ) : (
            <div>
              <h2 className="text-lg font-bold text-gray-800 mb-4">書類を生成する</h2>

              {/* 保存済みドキュメント */}
              {savedDocs.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-xs font-semibold text-gray-500 mb-2">生成済み書類</h3>
                  <div className="space-y-1">
                    {savedDocs.map((doc, i) => (
                      <div key={i} className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-2">
                        <button
                          onClick={() => setViewingDoc(doc)}
                          className="flex-1 text-left"
                        >
                          <span className="text-sm text-gray-800 font-medium">{doc.templateName}</span>
                          <span className="text-[10px] text-gray-400 ml-2">{new Date(doc.createdAt).toLocaleString("ja-JP")}</span>
                        </button>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => downloadDocx(doc.docxBase64, doc.fileName)}
                            className="text-[10px] text-blue-500 hover:text-blue-700"
                          >
                            DL
                          </button>
                          <button
                            onClick={() => handleDeleteDoc(i)}
                            className="text-[10px] text-red-400 hover:text-red-600"
                          >
                            削除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* テンプレート選択 */}
              {!hasMasterSheet && (
                <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mb-4">
                  案件整理を先に実行してください。
                </p>
              )}
              <h3 className="text-xs font-semibold text-gray-500 mb-2">テンプレートから生成</h3>
              <div className="grid grid-cols-1 gap-3">
                {templateFolders.map(tf => {
                  const isSelected = selectedTemplate?.path === tf.path;
                  return (
                    <div
                      key={tf.path}
                      className={`rounded-xl border-2 cursor-pointer transition-all ${
                        isSelected ? "border-blue-500 bg-blue-50 shadow-sm" : "border-gray-200 hover:border-blue-300"
                      }`}
                      onClick={() => setSelectedTemplate(isSelected ? null : tf)}
                    >
                      <div className="px-5 py-4 flex items-center justify-between">
                        <h3 className={`text-base font-bold ${isSelected ? "text-blue-700" : "text-gray-800"}`}>{tf.name}</h3>
                        <span className="text-[10px] text-gray-400">{tf.files.length}ファイル</span>
                      </div>
                      {isSelected && (
                        <>
                          <div className="border-t border-blue-200 px-5 py-3">
                            {tf.files.map(f => (
                              <button key={f.path}
                                onClick={(e) => { e.stopPropagation(); setPreviewFileId(f.path); }}
                                className="block text-xs text-blue-600 hover:text-blue-800 hover:underline py-0.5"
                              >📄 {f.name}</button>
                            ))}
                          </div>
                          <div className="px-5 py-4">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleGenerate(); }}
                              disabled={generating || !hasMasterSheet}
                              className="w-full rounded-lg bg-blue-600 py-3 text-sm font-bold text-white hover:bg-blue-700 disabled:bg-gray-300"
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
                  <p className="text-sm text-gray-400 py-4 text-center">テンプレートフォルダにフォルダがありません</p>
                )}
              </div>
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
