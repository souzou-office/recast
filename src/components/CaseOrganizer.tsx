"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Company, ChatMessage } from "@/types";
import { v4 as uuidv4 } from "uuid";
import TemplateSelectModal from "./chat/TemplateSelectModal";
import ChatInput from "./chat/ChatInput";
import MessageBubble from "./chat/MessageBubble";

interface Props {
  company: Company | null;
}

export default function CaseOrganizer({ company }: Props) {
  const [result, setResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [sourceFiles, setSourceFiles] = useState<{ id: string; name: string; mimeType: string }[]>([]);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [result]);

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
    setShowTemplateModal(false);
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
          <div className="flex items-center gap-2">
            {displayResult && !isLoading && (
              <button
                onClick={async () => {
                  if (!confirm("案件整理の結果を削除しますか？")) return;
                  setResult("");
                  setChatMessages([]);
                  // マスターシートも削除
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
            <button
              onClick={() => setShowTemplateModal(true)}
              disabled={isLoading}
              className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
            >
              {isLoading ? "整理中..." : displayResult ? "再整理" : "案件を整理"}
            </button>
          </div>
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
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
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
              <div className="text-center text-gray-400">
                <p className="text-3xl mb-2">📋</p>
                <p className="text-sm">「案件を整理」ボタンでテンプレートを選択し<br />案件資料から情報を抽出・整理します</p>
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

      {/* テンプレート選択モーダル */}
      {showTemplateModal && (
        <TemplateSelectModal
          onExecute={handleExecute}
          onClose={() => setShowTemplateModal(false)}
        />
      )}
    </div>
  );
}
