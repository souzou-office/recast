"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type { ChatMessage } from "@/types";
import MessageBubble from "./MessageBubble";
import ChatInput from "./ChatInput";
import TemplateSelectModal from "./TemplateSelectModal";

export default function ChatWindow() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
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
        body: JSON.stringify({ templateId, companyId: null }), // companyIdはサーバー側でconfigから取る
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "実行に失敗しました");
      }

      const result = await res.json();

      setIsLoading(false);
      setMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            content: result.content,
          };
        }
        return updated;
      });
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

  return (
    <div className="flex h-full flex-col">
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
      </div>

      {/* 入力エリア */}
      <ChatInput
        onSend={handleSend}
        onOpenTemplateModal={() => setShowTemplateModal(true)}
        disabled={isLoading}
      />

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
