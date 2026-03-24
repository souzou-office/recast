"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type { ChatMessage } from "@/types";
import MessageBubble from "./MessageBubble";
import ChatInput from "./ChatInput";
import TemplateSelectModal from "./TemplateSelectModal";

interface Props {
  companyId?: string | null;
  onLoadingChange?: (loading: boolean) => void;
}

export default function ChatWindow({ companyId, onLoadingChange }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [sourceLinks, setSourceLinks] = useState<Record<string, { id: string; name: string }[]>>({});
  const [showMasterJson, setShowMasterJson] = useState(false);
  const [masterJson, setMasterJson] = useState<string>("");
  const [masterJsonDirty, setMasterJsonDirty] = useState(false);

  useEffect(() => { onLoadingChange?.(isLoading); }, [isLoading, onLoadingChange]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 会社が変わったら履歴を読み込み
  useEffect(() => {
    if (!companyId) { setMessages([]); setSourceLinks({}); return; }
    const load = async () => {
      try {
        const res = await fetch(`/api/chat-history?companyId=${companyId}`);
        if (res.ok) {
          const { messages: saved } = await res.json();
          setMessages(saved);
          // 最後のメッセージのsourceLinksを復元
          const lastWithLinks = [...saved].reverse().find((m: ChatMessage) => m.sourceLinks);
          setSourceLinks(lastWithLinks?.sourceLinks || {});
        }
      } catch { /* ignore */ }
    };
    load();
    setPreviewFileId(null);
  }, [companyId]);

  // メッセージが変わったら保存（ローディング中は除く）
  useEffect(() => {
    if (!companyId || messages.length === 0 || isLoading) return;
    const save = async () => {
      try {
        await fetch("/api/chat-history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId, messages }),
        });
      } catch { /* ignore */ }
    };
    save();
  }, [messages, companyId, isLoading]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const handleSend = useCallback(async (content: string) => {
    const userMessage: ChatMessage = {
      id: uuidv4(),
      role: "user",
      content,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    const assistantMessage: ChatMessage = {
      id: uuidv4(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, assistantMessage]);

    try {
      const apiMessages = [...messages, userMessage].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });

      if (!response.ok) {
        throw new Error("APIエラーが発生しました");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("ストリームを取得できません");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              throw new Error(parsed.error);
            }
            if (parsed.text) {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === "assistant") {
                  updated[updated.length - 1] = {
                    ...last,
                    content: last.content + parsed.text,
                  };
                }
                return updated;
              });
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
    } catch (error) {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            content:
              error instanceof Error
                ? `エラー: ${error.message}`
                : "エラーが発生しました",
          };
        }
        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  }, [messages]);

  const handleExecuteTemplate = useCallback(async (templateId: string) => {
    setIsLoading(true);

    const userMessage: ChatMessage = {
      id: uuidv4(),
      role: "user",
      content: "案件を整理",
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMessage]);

    const assistantMessage: ChatMessage = {
      id: uuidv4(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, assistantMessage]);

    try {
      const res = await fetch("/api/templates/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId, companyId: null }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "実行に失敗しました");
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("ストリーム取得に失敗");

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
            if (data.sourceFiles) {
              setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === "assistant") {
                  updated[updated.length - 1] = { ...last, sourceFiles: data.sourceFiles };
                }
                return updated;
              });
            }
          } else if (data.type === "text") {
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last.role === "assistant") {
                updated[updated.length - 1] = {
                  ...last,
                  content: last.content + data.text,
                };
              }
              return updated;
            });
          }
        }
      }

      setIsLoading(false);

      // Haikuで各セクションとファイルの紐付け
      const lastMsg = messages[messages.length - 1] || { content: "", sourceFiles: [] };
      // 最新のメッセージを取得するため state から直接取る
      const currentMessages = await new Promise<ChatMessage[]>(resolve => {
        setMessages(prev => { resolve(prev); return prev; });
      });
      const finalMsg = currentMessages[currentMessages.length - 1];
      if (finalMsg?.sourceFiles && finalMsg.sourceFiles.length > 0 && finalMsg.content) {
        try {
          const linkRes = await fetch("/api/templates/link-sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: finalMsg.content, sourceFiles: finalMsg.sourceFiles }),
          });
          if (linkRes.ok) {
            const { links } = await linkRes.json();
            setSourceLinks(links);
            // sourceLinksをメッセージに保存
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last.role === "assistant") {
                updated[updated.length - 1] = { ...last, sourceLinks: links };
              }
              return updated;
            });
          }
        } catch { /* ignore */ }

        // マスターシートとして保存
        if (companyId && finalMsg.content) {
          try {
            await fetch("/api/templates/save-master", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                companyId,
                templateId: metaTemplateId,
                templateName: metaTemplateName,
                content: finalMsg.content,
                sourceFiles: finalMsg.sourceFiles,
              }),
            });
          } catch { /* ignore */ }
        }
      }
    } catch (error) {
      setIsLoading(false);
      setMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            content: error instanceof Error ? `エラー: ${error.message}` : "エラーが発生しました",
          };
        }
        return updated;
      });
    }
  }, []);

  // プレビュー用のファイル情報
  const allSourceFiles = messages.flatMap(m => m.sourceFiles || []);

  return (
    <div className="flex h-full">
      {/* 左側: チャット */}
      <div className={`flex flex-col ${previewFileId ? "w-1/2" : "w-full"} transition-all`}>
        {/* ツールバー */}
        {messages.length > 0 && !isLoading && (
          <div className="flex justify-end gap-3 px-4 pt-2">
            {companyId && companyId !== "__search__" && (
              <button
                onClick={async () => {
                  if (showMasterJson) {
                    setShowMasterJson(false);
                    return;
                  }
                  const res = await fetch(`/api/workspace/master-sheet?companyId=${companyId}`);
                  if (res.ok) {
                    const { masterSheet } = await res.json();
                    if (masterSheet?.structured) {
                      setMasterJson(JSON.stringify(masterSheet.structured, null, 2));
                      setMasterJsonDirty(false);
                      setShowMasterJson(true);
                    } else {
                      alert("マスターシートのJSONがありません。案件整理を実行してください。");
                    }
                  }
                }}
                className={`text-[10px] transition-colors ${
                  showMasterJson ? "text-blue-600 font-medium" : "text-gray-400 hover:text-gray-600"
                }`}
              >
                {showMasterJson ? "チャット表示" : "JSON表示"}
              </button>
            )}
            <button
              onClick={async () => {
                if (!confirm("チャット履歴を削除しますか？")) return;
                setMessages([]);
                setSourceLinks({});
                setPreviewFileId(null);
                if (companyId) {
                  await fetch(`/api/chat-history?companyId=${companyId}`, { method: "DELETE" });
                }
              }}
              className="text-[10px] text-red-400 hover:text-red-600 transition-colors"
            >
              履歴を削除
            </button>
          </div>
        )}
        {/* JSONエディタ or メッセージエリア */}
        {showMasterJson ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto p-4">
              <textarea
                value={masterJson}
                onChange={e => { setMasterJson(e.target.value); setMasterJsonDirty(true); }}
                className="w-full h-full min-h-[400px] rounded-lg bg-gray-900 text-gray-200 text-xs font-mono p-4 border-0 focus:outline-none resize-none leading-relaxed"
                spellCheck={false}
              />
            </div>
            {masterJsonDirty && (
              <div className="flex justify-end gap-2 px-4 py-2 border-t border-gray-200">
                <button
                  onClick={() => { setMasterJsonDirty(false); setShowMasterJson(false); }}
                  className="rounded-lg px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100"
                >
                  キャンセル
                </button>
                <button
                  onClick={async () => {
                    try {
                      const parsed = JSON.parse(masterJson);
                      await fetch("/api/workspace/master-sheet", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ companyId, type: "masterSheet", structured: parsed }),
                      });
                      setMasterJsonDirty(false);
                    } catch {
                      alert("JSONの形式が正しくありません");
                    }
                  }}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700"
                >
                  保存
                </button>
              </div>
            )}
          </div>
        ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center text-gray-400">
                <img src="/logo.png" alt="recast" className="mx-auto mb-2 h-10" />
                <p className="text-sm">
                  {companyId === "__search__" ? (
                    <>全社の基本情報を横断検索できます<br />例：「決算期が9月の会社は？」</>
                  ) : (
                    <>サイドバーからフォルダを追加して、<br />資料について質問してみましょう</>
                  )}
                </p>
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                streaming={isLoading && i === messages.length - 1 && msg.role === "assistant"}
                sourceLinks={msg.sourceFiles ? sourceLinks : undefined}
                onPreviewFile={(fileId) => setPreviewFileId(previewFileId === fileId ? null : fileId)}
                activePreviewId={previewFileId}
              />
            ))
          )}
          {isLoading &&
            messages[messages.length - 1]?.content === "" && (
              <div className="flex justify-start mb-4">
                <div className="bg-gray-100 rounded-2xl px-4 py-3">
                  <div className="flex gap-1">
                    <span className="animate-bounce text-gray-400">●</span>
                    <span className="animate-bounce text-gray-400 [animation-delay:0.15s]">●</span>
                    <span className="animate-bounce text-gray-400 [animation-delay:0.3s]">●</span>
                  </div>
                </div>
              </div>
            )}

        </div>
        )}

        {/* 入力エリア */}
        <ChatInput
          onSend={handleSend}
          onOpenTemplateModal={companyId !== "__search__" ? () => setShowTemplateModal(true) : undefined}
          disabled={isLoading}
        />
      </div>

      {/* 右側: ファイルプレビュー */}
      {previewFileId && (
        <div className="flex w-1/2 flex-col border-l border-gray-200">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
            <span className="text-xs text-gray-600 truncate">
              {allSourceFiles.find(f => f.id === previewFileId)?.name}
            </span>
            <div className="flex items-center gap-2">
              <a
                href={`https://drive.google.com/file/d/${previewFileId}/view`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-blue-500 hover:text-blue-700"
              >
                別タブで開く
              </a>
              <button
                onClick={() => setPreviewFileId(null)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
              >
                ×
              </button>
            </div>
          </div>
          <iframe
            src={`https://drive.google.com/file/d/${previewFileId}/preview`}
            className="flex-1 w-full"
            allow="autoplay"
          />
        </div>
      )}

      {/* テンプレート選択モーダル */}
      {showTemplateModal && (
        <TemplateSelectModal
          onExecute={(templateId) => {
            setShowTemplateModal(false);
            handleExecuteTemplate(templateId);
          }}
          onClose={() => setShowTemplateModal(false)}
        />
      )}
    </div>
  );
}
