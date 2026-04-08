"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatThread, ThreadMessage, ActionCard, Company } from "@/types";
import ActionCardRenderer from "./cards/ActionCardRenderer";

interface Props {
  company: Company | null;
  threadId: string | null;
  onThreadUpdate: () => void;
}

export default function ChatWorkflow({ company, threadId, onThreadUpdate }: Props) {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // スレッド読み込み
  useEffect(() => {
    if (!threadId || !company) { setThread(null); return; }
    fetch(`/api/chat-threads/${threadId}?companyId=${encodeURIComponent(company.id)}`)
      .then(r => r.json())
      .then(data => setThread(data.thread || null))
      .catch(() => setThread(null));
  }, [threadId, company?.id]);

  // 自動スクロール
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [thread?.messages.length]);

  // メッセージ追加（ローカル + サーバー保存）
  const addMessage = useCallback(async (msg: ThreadMessage) => {
    if (!thread || !company) return;
    setThread(prev => prev ? { ...prev, messages: [...prev.messages, msg] } : prev);
    await fetch(`/api/chat-threads/${thread.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId: company.id, message: msg }),
    });
  }, [thread, company]);

  // テキスト送信
  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading || !thread || !company) return;
    setInput("");

    const userMsg: ThreadMessage = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    await addMessage(userMsg);

    // AI応答
    setLoading(true);
    const assistantMsg: ThreadMessage = {
      id: `msg_${Date.now() + 1}`,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };
    setThread(prev => prev ? { ...prev, messages: [...prev.messages, assistantMsg] } : prev);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...(thread.messages || []), userMsg].map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";

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
            fullText += data.text;
            setThread(prev => {
              if (!prev) return prev;
              const msgs = [...prev.messages];
              const last = msgs[msgs.length - 1];
              if (last.role === "assistant") msgs[msgs.length - 1] = { ...last, content: fullText };
              return { ...prev, messages: msgs };
            });
          }
        }
      }

      // 最終メッセージを保存
      assistantMsg.content = fullText;
      await fetch(`/api/chat-threads/${thread.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id, message: assistantMsg }),
      });
      onThreadUpdate();
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  // カード操作ハンドラ
  const handleCardAction = useCallback(async (messageId: string, cardIndex: number, cardData: Partial<ActionCard>) => {
    if (!thread || !company) return;
    await fetch(`/api/chat-threads/${thread.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: company.id,
        updateCard: { messageId, cardIndex, cardData },
      }),
    });
    // ローカル更新
    setThread(prev => {
      if (!prev) return prev;
      const msgs = [...prev.messages];
      const msg = msgs.find(m => m.id === messageId);
      if (msg?.cards?.[cardIndex]) {
        msg.cards[cardIndex] = { ...msg.cards[cardIndex], ...cardData } as ActionCard;
      }
      return { ...prev, messages: msgs };
    });
  }, [thread, company]);

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">サイドバーから会社を選択してください</p>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="text-3xl mb-3">💬</p>
          <p className="text-sm text-gray-500">チャットを選択するか、新規作成してください</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* メッセージ一覧 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {thread.messages.map((msg, i) => (
            <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-white border border-gray-200 text-gray-800"
              }`}>
                {msg.role === "assistant" ? (
                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    {loading && i === thread.messages.length - 1 && !msg.content && (
                      <span className="animate-pulse">●●●</span>
                    )}
                  </div>
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                )}
                {/* アクションカード */}
                {msg.cards?.map((card, ci) => (
                  <div key={ci} className="mt-3">
                    <ActionCardRenderer
                      card={card}
                      onAction={(data) => handleCardAction(msg.id, ci, data)}
                      company={company}
                      thread={thread}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 入力欄 */}
      <div className="border-t border-gray-200 bg-white p-4">
        <div className="max-w-3xl mx-auto flex items-end gap-3">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px"; }}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="メッセージを入力...（Shift+Enterで改行）"
            disabled={loading}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50"
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            送信
          </button>
        </div>
      </div>
    </div>
  );
}
