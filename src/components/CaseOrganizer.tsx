"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Company, ChatMessage } from "@/types";
import { v4 as uuidv4 } from "uuid";
import ChatInput from "./chat/ChatInput";
import MessageBubble from "./chat/MessageBubble";

interface CheckTemplate {
  id: string;
  name: string;
  items: string[];
}

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return "📄";
  if (["doc", "docx"].includes(ext)) return "📝";
  if (["xls", "xlsx"].includes(ext)) return "📊";
  if (["jpg", "jpeg", "png", "gif"].includes(ext)) return "🖼";
  return "📎";
}

interface Props {
  company: Company | null;
  executeTemplateId?: string | null;
  onExecuteComplete?: () => void;
  onSuggestFolders?: (folderIds: string[]) => void;
}

export default function CaseOrganizer({ company, executeTemplateId, onExecuteComplete, onSuggestFolders }: Props) {
  const [result, setResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sourceFiles, setSourceFiles] = useState<{ id: string; name: string; mimeType: string }[]>([]);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [sourceLinks, setSourceLinks] = useState<Record<string, { id: string; name: string }[]>>({});
  const [templates, setTemplates] = useState<CheckTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [inferring, setInferring] = useState(false);
  const [suggestedFolders, setSuggestedFolders] = useState<Set<string>>(new Set());
  const [checkedFolders, setCheckedFolders] = useState<Set<string>>(new Set());
  const [showFolderSelection, setShowFolderSelection] = useState(false);
  const [folderData, setFolderData] = useState<Record<string, { files: { name: string; path: string }[]; subfolders: { name: string; path: string }[] }>>({});
  const [expandedPreviews, setExpandedPreviews] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // テンプレート一覧を読み込み
  useEffect(() => {
    fetch("/api/templates").then(r => r.json()).then(d => {
      setTemplates(Array.isArray(d) ? d : []);
    }).catch(() => {});
  }, []);

  // テンプレート選択→フォルダ推論
  const handleSelectTemplate = async (template: CheckTemplate) => {
    setSelectedTemplateId(template.id);
    setShowFolderSelection(false);
    setSuggestedFolders(new Set());
    if (!company) return;

    const allFolders = company.subfolders.filter(s => s.role !== "none");
    if (allFolders.length === 0) return;

    setInferring(true);
    try {
      const res = await fetch("/api/templates/suggest-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateName: template.name,
          templateItems: template.items,
          folderNames: allFolders.map(s => ({ id: s.id, name: s.name })),
        }),
      });
      const data = await res.json();
      const suggested = new Set<string>(data.suggested || []);
      // 共通フォルダは常にON
      for (const sub of company.subfolders) {
        if (sub.role === "common") suggested.add(sub.id);
      }
      setSuggestedFolders(suggested);
      setCheckedFolders(new Set(suggested));
      setShowFolderSelection(true);
      // 会社ルートを読み込み、1階層目を展開
      loadFolderData(company.id);
      const allExpanded = new Set<string>([company.id]);
      setExpandedPreviews(allExpanded);
      // サイドバーも更新
      if (onSuggestFolders) onSuggestFolders(Array.from(suggested));
    } catch { /* ignore */ }
    setInferring(false);
  };

  const loadFolderData = async (folderPath: string) => {
    if (folderData[folderPath]) return;
    try {
      const res = await fetch("/api/workspace/list-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: folderPath }),
      });
      const data = await res.json();
      setFolderData(prev => ({
        ...prev,
        [folderPath]: { files: data.files || [], subfolders: data.subfolders || [] },
      }));
    } catch { /* ignore */ }
  };

  const toggleFolderCheck = (folderId: string) => {
    setCheckedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      // サイドバーも同期
      if (onSuggestFolders) onSuggestFolders(Array.from(next));
      return next;
    });
  };

  // 会社フォルダ全体をブラウズできるツリー
  const renderBrowseTree = (folderPath: string, depth: number): React.ReactNode => {
    const data = folderData[folderPath];
    if (!data) return <p className="text-[10px] text-gray-400 py-2 pl-4">読み込み中...</p>;

    return (
      <ul className={depth > 0 ? "ml-4 border-l border-gray-100" : ""}>
        {data.subfolders.map(sf => {
          const isOpen = expandedPreviews.has(sf.path);
          const isChecked = checkedFolders.has(sf.path);
          const isSuggested = suggestedFolders.has(sf.path);
          return (
            <li key={sf.path} className={isChecked ? "bg-blue-50/40" : ""}>
              <div className="flex items-center gap-1 px-2 py-1 hover:bg-gray-50">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleFolderCheck(sf.path)}
                  className="w-3.5 h-3.5 shrink-0"
                />
                <button
                  onClick={() => {
                    const next = new Set(expandedPreviews);
                    if (next.has(sf.path)) next.delete(sf.path);
                    else { next.add(sf.path); loadFolderData(sf.path); }
                    setExpandedPreviews(next);
                  }}
                  className="flex-1 flex items-center gap-1 text-xs text-left text-gray-700 hover:text-gray-900"
                >
                  <span className="text-[11px]">{isOpen ? "📂" : "📁"}</span>
                  <span className={isChecked ? "font-medium" : ""}>{sf.name}</span>
                </button>
                {isSuggested && (
                  <span className="text-[8px] bg-blue-100 text-blue-600 rounded px-1 py-0.5 shrink-0">AI推奨</span>
                )}
              </div>
              {isOpen && renderBrowseTree(sf.path, depth + 1)}
            </li>
          );
        })}
        {data.files.map(f => (
          <li key={f.path} className="flex items-center gap-1 px-2 py-0.5 pl-8">
            <span className="text-[10px]">{fileIcon(f.name)}</span>
            <span className="text-[11px] text-gray-500 truncate">{f.name}</span>
          </li>
        ))}
      </ul>
    );
  };

  const renderFolderTree = (path: string, depth: number): React.ReactNode => {
    const data = folderData[path];
    if (!data) return <p className="text-[10px] text-gray-400 py-1 pl-4 ml-4">読み込み中...</p>;

    return (
      <div className={`border-t border-gray-100 py-1 ${depth === 1 ? "ml-8 px-2" : "ml-4"}`}>
        {data.subfolders.map(sf => {
          const sfOpen = expandedPreviews.has(sf.path);
          return (
            <div key={sf.path}>
              <button
                onClick={() => {
                  const next = new Set(expandedPreviews);
                  if (next.has(sf.path)) next.delete(sf.path);
                  else { next.add(sf.path); loadFolderData(sf.path); }
                  setExpandedPreviews(next);
                }}
                className="w-full flex items-center gap-1 text-xs text-gray-600 hover:text-gray-800 py-0.5 text-left"
              >
                <span className="text-[10px]">{sfOpen ? "📂" : "📁"}</span>
                <span className="truncate">{sf.name}</span>
              </button>
              {sfOpen && renderFolderTree(sf.path, depth + 1)}
            </div>
          );
        })}
        {data.files.map(f => (
          <p key={f.path} className="text-[11px] text-gray-500 py-0.5 pl-4 truncate flex items-center gap-1">
            <span className="text-[10px]">{fileIcon(f.name)}</span>
            {f.name}
          </p>
        ))}
        {data.files.length === 0 && data.subfolders.length === 0 && (
          <p className="text-[10px] text-gray-400 py-1 pl-4">空</p>
        )}
      </div>
    );
  };

  const handleExecuteWithFolders = () => {
    if (!selectedTemplateId) return;
    // checkedFoldersをactiveに反映してから実行
    handleExecute(selectedTemplateId);
    setShowFolderSelection(false);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [result, chatMessages]);

  // サイドバーからのテンプレート実行
  useEffect(() => {
    if (executeTemplateId) {
      handleExecute(executeTemplateId);
      onExecuteComplete?.();
    }
  }, [executeTemplateId]);

  const handleChatSend = useCallback(async (content: string) => {
    const userMsg: ChatMessage = { id: uuidv4(), role: "user", content, timestamp: Date.now() };
    setChatMessages(prev => [...prev, userMsg]);
    setChatLoading(true);

    const assistantMsg: ChatMessage = { id: uuidv4(), role: "assistant", content: "", timestamp: Date.now() };
    setChatMessages(prev => [...prev, assistantMsg]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...chatMessages, userMsg].map(m => ({ role: m.role, content: m.content })) }),
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
          if (line === "data: [DONE]") continue;
          const match = line.match(/^data: (.+)$/m);
          if (!match) continue;
          const data = JSON.parse(match[1]);
          if (data.text) {
            setChatMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last.role === "assistant") updated[updated.length - 1] = { ...last, content: last.content + data.text };
              return updated;
            });
          }
        }
      }
    } catch { /* ignore */ }
    finally { setChatLoading(false); }
  }, [chatMessages]);

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">サイドバーから会社を選択してください</p>
      </div>
    );
  }

  // 保存済みマスターシートがあればそれを表示
  const savedResult = company.masterSheet?.content || "";
  const displayResult = result || savedResult;

  const handleExecute = async (templateId: string) => {
    setIsLoading(true);
    setResult("");
    setSourceFiles([]);
    setTemplateName("");

    try {
      const res = await fetch("/api/templates/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId }),
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
      let metaTemplateId = "";
      let metaTemplateName = "";

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
            metaTemplateId = data.templateId || "";
            metaTemplateName = data.templateName || "";
            setTemplateName(metaTemplateName);
            if (data.sourceFiles) setSourceFiles(data.sourceFiles);
          } else if (data.type === "text") {
            setResult(prev => prev + data.text);
          }
        }
      }

      setIsLoading(false);

      // Haikuで各セクションとファイルの紐付け
      if (sourceFiles.length > 0) {
        const finalResult = await new Promise<string>(resolve => {
          setResult(prev => { resolve(prev); return prev; });
        });
        try {
          const linkRes = await fetch("/api/templates/link-sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: finalResult, sourceFiles }),
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
        try {
          await fetch("/api/templates/save-master", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              companyId: company.id,
              templateId: metaTemplateId,
              templateName: metaTemplateName,
              content: finalResult,
              sourceFiles,
            }),
          });
        } catch { /* ignore */ }
      }
    } catch {
      setIsLoading(false);
      setResult("エラーが発生しました");
    }
  };

  return (
    <div className="flex h-full">
      {/* 左: 結果表示 */}
      <div className={`flex flex-col ${previewFileId ? "w-1/2" : "w-full"} transition-all`}>
        {/* ヘッダー */}
        <div className="border-b border-gray-200 px-6 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-gray-900">{company.name}</h2>
            {templateName && <span className="text-[10px] text-gray-400">{templateName}</span>}
          </div>
          {displayResult && !isLoading && (
            <button
              onClick={async () => {
                if (!confirm("案件整理の結果を削除しますか？")) return;
                setResult("");
                setChatMessages([]);
                if (company) {
                  await fetch("/api/workspace", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "deleteMasterSheet", companyId: company.id }),
                  });
                }
              }}
              className="text-[10px] text-red-400 hover:text-red-600 transition-colors"
            >
              削除
            </button>
          )}
        </div>

        {/* 結果 */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6">
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
              {(sourceFiles.length > 0 || company.masterSheet?.sourceFiles) && !isLoading && (
                <div className="mt-4 border-t border-gray-100 pt-3">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">参照元資料</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(sourceFiles.length > 0 ? sourceFiles : company.masterSheet?.sourceFiles || []).map((f, i) => (
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
              <div className="w-full max-w-2xl px-8">
                <h2 className="text-lg font-bold text-gray-800 mb-6">案件を整理する</h2>
                {templates.length === 0 ? (
                  <p className="text-sm text-gray-400">設定からテンプレートを追加してください</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {templates.map(t => {
                      const isSelected = selectedTemplateId === t.id;
                      return (
                        <div
                          key={t.id}
                          className={`rounded-xl border-2 transition-all cursor-pointer ${
                            isSelected
                              ? "border-blue-500 bg-blue-50 shadow-md col-span-full"
                              : "border-gray-200 hover:border-blue-300 hover:shadow-sm"
                          }`}
                          onClick={() => setSelectedTemplateId(isSelected ? null : t.id)}
                        >
                          <div className="px-5 py-4 flex items-center justify-between">
                            <h3 className={`text-lg font-bold ${isSelected ? "text-blue-700" : "text-gray-800"}`}>
                              {t.name}
                            </h3>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${
                              isSelected ? "bg-blue-200 text-blue-700" : "bg-gray-100 text-gray-500"
                            }`}>
                              {t.items.length}項目
                            </span>
                          </div>
                          {isSelected && (
                            <>
                              <div className="border-t border-blue-200 px-5 py-3">
                                <ul className="space-y-1">
                                  {t.items.map((item, i) => (
                                    <li key={i} className="text-sm text-gray-700 flex gap-2">
                                      <span className="text-gray-400 shrink-0">{i + 1}.</span>
                                      {item}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                              <div className="px-5 py-4">
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleExecute(t.id); }}
                                  disabled={isLoading}
                                  className="w-full rounded-lg bg-blue-600 py-3 text-sm font-bold text-white hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
                                >
                                  {isLoading ? "実行中..." : "この内容で案件を整理"}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="text-xs text-gray-400 mt-6 text-center">サイドバーで使用するフォルダを選択してから実行してください</p>
              </div>
            </div>
          )}
          {/* チャットメッセージ */}
          {chatMessages.length > 0 && (
            <div className="mt-4 border-t border-gray-200 pt-4">
              {chatMessages.map((msg, i) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  streaming={chatLoading && i === chatMessages.length - 1 && msg.role === "assistant"}
                />
              ))}
            </div>
          )}
        </div>

        {/* チャット入力欄 */}
        <ChatInput
          onSend={handleChatSend}
          disabled={chatLoading || isLoading}
        />
      </div>

      {/* 右: ファイルプレビュー */}
      {previewFileId && (
        <div className="flex w-1/2 flex-col border-l border-gray-200">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
            <span className="text-xs text-gray-600 truncate">
              {(sourceFiles.length > 0 ? sourceFiles : company.masterSheet?.sourceFiles || []).find(f => f.id === previewFileId)?.name}
            </span>
            <div className="flex items-center gap-2">
              <a href={`https://drive.google.com/file/d/${previewFileId}/view`} target="_blank" rel="noopener noreferrer"
                className="text-[10px] text-blue-500 hover:text-blue-700">別タブで開く</a>
              <button onClick={() => setPreviewFileId(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
            </div>
          </div>
          <iframe src={`https://drive.google.com/file/d/${previewFileId}/preview`} className="flex-1 w-full" allow="autoplay" />
        </div>
      )}

    </div>
  );
}
