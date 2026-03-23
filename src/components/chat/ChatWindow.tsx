"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type { ChatMessage } from "@/types";
import MessageBubble from "./MessageBubble";
import ChatInput from "./ChatInput";
import TemplateSelectModal from "./TemplateSelectModal";

interface Props {
  onLoadingChange?: (loading: boolean) => void;
}

export default function ChatWindow({ onLoadingChange }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);

  useEffect(() => { onLoadingChange?.(isLoading); }, [isLoading, onLoadingChange]);
  const scrollRef = useRef<HTMLDivElement>(null);

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

          if (data.type === "meta" && data.sourceFiles) {
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last.role === "assistant") {
                updated[updated.length - 1] = { ...last, sourceFiles: data.sourceFiles };
              }
              return updated;
            });
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

  // sourceFilesを持つメッセージから全ファイルを集める
  const allSourceFiles = messages.flatMap(m => m.sourceFiles || []);
  const hasSourceFiles = allSourceFiles.length > 0;

  return (
    <div className="flex h-full">
      {/* 左側: チャット */}
      <div className={`flex flex-col ${previewFileId ? "w-1/2" : "w-full"} transition-all`}>
        {/* メッセージエリア */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center text-gray-400">
                <img src="/logo.png" alt="recast" className="mx-auto mb-2 h-10" />
                <p className="text-sm">
                  サイドバーからフォルダを追加して、
                  <br />
                  資料について質問してみましょう
                </p>
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                streaming={isLoading && i === messages.length - 1 && msg.role === "assistant"}
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

          {/* 参照元資料リンク */}
          {hasSourceFiles && !isLoading && (
            <div className="mt-4 border-t border-gray-100 pt-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">参照元資料</p>
              <div className="flex flex-wrap gap-1.5">
                {allSourceFiles.map((f, i) => (
                  <button
                    key={`${f.id}-${i}`}
                    onClick={() => setPreviewFileId(previewFileId === f.id ? null : f.id)}
                    className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                      previewFileId === f.id
                        ? "bg-blue-100 text-blue-700"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    {f.mimeType.includes("pdf") ? "📄 " :
                     f.mimeType.includes("word") || f.mimeType.includes("document") ? "📝 " :
                     f.mimeType.includes("sheet") || f.mimeType.includes("excel") ? "📊 " : "📎 "}
                    {f.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 入力エリア */}
        <ChatInput
          onSend={handleSend}
          onOpenTemplateModal={() => setShowTemplateModal(true)}
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
