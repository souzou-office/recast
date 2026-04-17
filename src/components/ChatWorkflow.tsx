"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatThread, ThreadMessage, ActionCard, Company, ClarificationCard } from "@/types";
import ActionCardRenderer from "./cards/ActionCardRenderer";
import FilePreview from "./FilePreview";

interface Props {
  company: Company | null;
  threadId: string | null;
  onThreadUpdate: () => void;
}

export default function ChatWorkflow({ company, threadId, onThreadUpdate }: Props) {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ filePath?: string; docxBase64?: string; fileName: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingTemplatePath = useRef<string | null>(null);

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

  // カード操作ハンドラ→action API→次のカード表示
  const handleCardAction = useCallback(async (messageId: string, cardIndex: number, cardData: Partial<ActionCard>) => {
    if (!thread || !company) return;
    setLoading(true);

    // カードタイプに応じたアクション名を決定
    const msg = thread.messages.find(m => m.id === messageId);
    const card = msg?.cards?.[cardIndex];
    let action = "";
    if (card?.type === "folder-select") action = "folder-selected";
    else if (card?.type === "file-select") action = "files-confirmed";
    else if (card?.type === "template-select") action = "template-selected";
    else if (card?.type === "check-prompt") action = "check-accepted";
    else if (card?.type === "clarification") {
      // 確認質問に回答 → 回答を反映してもう一度 clarify を呼ぶ
      // 新たな確認事項があれば次のカードを出す、無ければ書類生成に進む
      const updatedCard = { ...card, ...cardData, answered: true } as ClarificationCard;
      // スレッド状態を明示的に組み立てる（setStateコールバックに依存しない）
      const updatedMessages = thread.messages.map(m => {
        if (m.id !== messageId) return m;
        const newCards = (m.cards || []).map((c, i) => i === cardIndex ? (updatedCard as ActionCard) : c);
        return { ...m, cards: newCards };
      });
      const updatedThread: ChatThread = { ...thread, messages: updatedMessages };
      setThread(updatedThread);
      // 永続化
      await fetch(`/api/chat-threads/${thread.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id, messages: updatedThread.messages }),
      });

      // templatePath を取得
      let templatePath = pendingTemplatePath.current;
      if (!templatePath) {
        for (const m of updatedThread.messages) {
          for (const c of m.cards || []) {
            if (c.type === "template-select" && c.selectedPath) templatePath = c.selectedPath;
          }
        }
      }
      if (!templatePath) {
        setLoading(false);
        return;
      }

      // 全ての clarification カードから Q&A を収集
      const previousQA: { question: string; answer: string }[] = [];
      for (const m of updatedThread.messages) {
        for (const c of m.cards || []) {
          if (c.type !== "clarification") continue;
          for (const q of c.questions) {
            let ans = "";
            if (q.selectedOptionId === "_manual") ans = q.manualInput || "";
            else if (q.selectedOptionId) {
              const opt = q.options.find(o => o.id === q.selectedOptionId);
              ans = opt?.label || "";
            }
            if (ans) previousQA.push({ question: `【${q.placeholder}】${q.question}`, answer: ans });
          }
        }
      }

      // もう一度 clarify を呼ぶ
      const clarifyRes = await fetch("/api/document-templates/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          templateFolderPath: templatePath,
          previousQA,
          folderPath: updatedThread.folderPath,
          disabledFiles: updatedThread.disabledFiles,
        }),
      });
      const clarifyData = await clarifyRes.json();

      if (clarifyData.questions && clarifyData.questions.length > 0) {
        // まだ確認事項がある → 次のカードを追加
        const nextMsg: ThreadMessage = {
          id: `msg_${Date.now()}`,
          role: "assistant",
          content: `さらに${clarifyData.questions.length}点確認があります`,
          cards: [{ type: "clarification", questions: clarifyData.questions }],
          timestamp: new Date().toISOString(),
        };
        setThread(prev => prev ? { ...prev, messages: [...prev.messages, nextMsg] } : prev);
        await fetch(`/api/chat-threads/${thread.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId: company.id, message: nextMsg }),
        });
        pendingTemplatePath.current = templatePath;
        setLoading(false);
        return;
      }

      // 確認事項なし → 書類生成へ
      await generateDocuments(updatedThread, templatePath, cardData as Partial<ActionCard>);
      pendingTemplatePath.current = null;
      return;
    }

    if (action) {
      const res = await fetch(`/api/chat-threads/${thread.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          action,
          messageId,
          cardIndex,
          data: cardData,
        }),
      });
      if (res.ok) {
        const result = await res.json();
        setThread(result.thread);
        setLoading(false);
        // サイドバー一覧を更新（displayName変更を反映するため）
        onThreadUpdate();

        // テンプレート選択後→案件整理+書類生成をSSEで実行
        if (action === "template-selected" && "selectedPath" in cardData && cardData.selectedPath) {
          await runWorkflow(result.thread, cardData.selectedPath as string);
        }
        // チェック実行
        if (action === "check-accepted") {
          await runCheck(result.thread);
        }
      } else {
        setLoading(false);
      }
    } else {
      // 通常のカード更新
      await fetch(`/api/chat-threads/${thread.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id, updateCard: { messageId, cardIndex, cardData } }),
      });
      setThread(prev => {
        if (!prev) return prev;
        const msgs = [...prev.messages];
        const m = msgs.find(m => m.id === messageId);
        if (m?.cards?.[cardIndex]) m.cards[cardIndex] = { ...m.cards[cardIndex], ...cardData } as ActionCard;
        return { ...prev, messages: msgs };
      });
      setLoading(false);
    }
  }, [thread, company]);

  // 案件整理+書類生成を実行
  const runWorkflow = async (currentThread: ChatThread, templatePath: string) => {
    if (!company) return;
    setLoading(true);

    // 1. 案件整理（SSE）
    const organizeMsg: ThreadMessage = {
      id: `msg_${Date.now()}`,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };
    setThread(prev => prev ? { ...prev, messages: [...prev.messages, organizeMsg] } : prev);

    try {
      const res = await fetch("/api/templates/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          folderPath: currentThread.folderPath,
          disabledFiles: currentThread.disabledFiles,
          templateFolderPath: templatePath,
        }),
      });
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
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
            if (data.type === "meta" && data.sourceFiles) {
              metaSourceFiles = data.sourceFiles;
            } else if (data.type === "text") {
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

        // 出典リンクを生成
        if (metaSourceFiles.length > 0 && fullText) {
          try {
            const linkRes = await fetch("/api/templates/link-sources", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: fullText, sourceFiles: metaSourceFiles }),
            });
            if (linkRes.ok) {
              const { links } = await linkRes.json();
              // 出典情報をメッセージに含める（見出し横にファイル名）
              let enrichedText = fullText;
              for (const [heading, files] of Object.entries(links)) {
                const fileLinks = (files as { id: string; name: string }[]).map(f => `📄${f.name}`).join(" ");
                if (fileLinks) {
                  enrichedText = enrichedText.replace(
                    new RegExp(`(## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`),
                    `$1 ${fileLinks}`
                  );
                }
              }
              fullText = enrichedText;
            }
          } catch { /* ignore */ }
        }

        // 案件整理結果を保存
        organizeMsg.content = fullText;
        await fetch(`/api/chat-threads/${currentThread.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId: company.id, message: organizeMsg }),
        });
      }

      // 案件整理が終わった直後のスレッドで書類生成できるよう、ここで最新内容を含むスレッドを作る
      // （currentThread 引数は organizeMsg 追加前のスナップショットなので stale になる）
      const freshThread: ChatThread = {
        ...currentThread,
        messages: [...currentThread.messages, organizeMsg],
      };
      // 2. 確認質問（clarify）
      const clarifyRes = await fetch("/api/document-templates/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          templateFolderPath: templatePath,
          folderPath: currentThread.folderPath,
          disabledFiles: currentThread.disabledFiles,
        }),
      });
      const clarifyData = await clarifyRes.json();

      if (clarifyData.questions && clarifyData.questions.length > 0) {
        // 質問がある→カード表示して一旦停止（回答後にcontinueWorkflowで再開）
        const clarifyMsg: ThreadMessage = {
          id: `msg_${Date.now() + 1}`,
          role: "assistant",
          content: `${clarifyData.questions.length}点確認があります`,
          cards: [{
            type: "clarification",
            questions: clarifyData.questions,
          }],
          timestamp: new Date().toISOString(),
        };
        setThread(prev => prev ? { ...prev, messages: [...prev.messages, clarifyMsg] } : prev);
        await fetch(`/api/chat-threads/${currentThread.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId: company.id, message: clarifyMsg }),
        });
        // templatePathを保存して後でcontinue
        pendingTemplatePath.current = templatePath;
        console.log("[ChatWorkflow] pendingTemplatePath SET:", templatePath);
        setLoading(false);
        return;
      }

      // 3. 質問なし→直接書類生成（organizeMsg を含む freshThread を渡す）
      await generateDocuments(freshThread, templatePath);
    } catch { /* ignore */ }
    finally { setLoading(false); onThreadUpdate(); }
  };

  // 書類生成
  const generateDocuments = async (currentThread: ChatThread, templatePath: string, clarificationData?: Partial<ActionCard>) => {
    if (!company) return;
    setLoading(true);
    console.log("[ChatWorkflow] generateDocuments called, templatePath:", templatePath);

    // スレッド内の案件整理結果を探す
    const organizeContent = currentThread.messages.find(m => m.role === "assistant" && m.content.length > 200)?.content || "";

    // 確認質問の回答を収集（placeholder名→確定値のマップ）
    const confirmedAnswers: Record<string, string> = {};
    for (const m of currentThread.messages) {
      for (const c of m.cards || []) {
        if (c.type !== "clarification") continue;
        for (const q of c.questions) {
          let ans = "";
          if (q.selectedOptionId === "_manual") ans = q.manualInput || "";
          else if (q.selectedOptionId) {
            const opt = q.options.find(o => o.id === q.selectedOptionId);
            ans = opt?.label || "";
          }
          if (ans) confirmedAnswers[q.placeholder] = ans;
        }
      }
    }

    const produceRes = await fetch("/api/document-templates/produce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: company.id,
        templateFolderPath: templatePath,
        masterContent: organizeContent,
        confirmedAnswers,
        folderPath: currentThread.folderPath,
        disabledFiles: currentThread.disabledFiles,
      }),
    });
    const produceData = await produceRes.json();
    console.log("[ChatWorkflow] produce response:", produceData.error || `${produceData.documents?.length || 0} docs`);

    if (produceData.documents && produceData.documents.length > 0) {
      const resultMsg: ThreadMessage = {
        id: `msg_${Date.now() + 2}`,
        role: "assistant",
        content: "書類を生成しました",
        cards: [{
          type: "document-result",
          documents: produceData.documents,
        }],
        timestamp: new Date().toISOString(),
      };
      setThread(prev => prev ? { ...prev, messages: [...prev.messages, resultMsg] } : prev);
      await fetch(`/api/chat-threads/${currentThread.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id, message: resultMsg, generatedDocuments: produceData.documents }),
      });

      // 自動でチェック実行
      await runCheck(currentThread);
    } else if (produceData.error) {
      const errorMsg: ThreadMessage = {
        id: `msg_${Date.now() + 2}`,
        role: "assistant",
        content: `書類生成エラー: ${produceData.error}`,
        timestamp: new Date().toISOString(),
      };
      setThread(prev => prev ? { ...prev, messages: [...prev.messages, errorMsg] } : prev);
    }

    setLoading(false);
    onThreadUpdate();
  };

  // チェック実行
  const runCheck = async (currentThread: ChatThread) => {
    if (!company) return;
    setLoading(true);

    const checkMsg: ThreadMessage = {
      id: `msg_${Date.now()}`,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };
    setThread(prev => prev ? { ...prev, messages: [...prev.messages, checkMsg] } : prev);

    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          threadId: currentThread.id,
          folderPath: currentThread.folderPath,
          disabledFiles: currentThread.disabledFiles,
        }),
      });
      const reader = res.body?.getReader();
      if (reader) {
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
            const match = line.match(/^data: (.+)$/m);
            if (!match) continue;
            const data = JSON.parse(match[1]);
            if (data.type === "text") {
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

        // チェック結果を保存
        checkMsg.content = fullText;
        checkMsg.cards = [{ type: "check-result", content: fullText }];
        await fetch(`/api/chat-threads/${currentThread.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId: company.id, message: checkMsg, checkResult: fullText }),
        });
      }
    } catch { /* ignore */ }
    finally { setLoading(false); onThreadUpdate(); }
  };

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
    <div className="flex h-full">
      {/* 左: チャット */}
      <div className={`flex flex-col ${previewFile ? "flex-1 min-w-0" : "w-full"}`}>
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
                      <div className="flex items-center gap-2 text-gray-400">
                        <span className="animate-spin text-sm">⏳</span>
                        <span className="text-xs animate-pulse">考え中...</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                )}
                {/* アクションカード */}
                {msg.cards?.map((card, ci) => {
                  // フォルダ選択カードへ戻るハンドラを用意
                  const goBack = () => {
                    for (const m of thread.messages) {
                      const idx = (m.cards || []).findIndex(c => c.type === "folder-select");
                      if (idx >= 0) {
                        handleCardAction(m.id, idx, { selectedPath: undefined } as Partial<ActionCard>);
                        return;
                      }
                    }
                  };
                  return (
                    <div key={ci} className="mt-3">
                      <ActionCardRenderer
                        card={card}
                        onAction={(data) => handleCardAction(msg.id, ci, data)}
                        company={company}
                        thread={thread}
                        onPreview={setPreviewFile}
                        onGoBackToFolder={goBack}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {/* 考え中表示 */}
          {loading && (
            <div className="flex justify-start">
              <div className="rounded-2xl px-4 py-3 bg-white border border-gray-200">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0.15s]" />
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0.3s]" />
                  </div>
                  <span className="text-xs text-gray-400">処理中...</span>
                </div>
              </div>
            </div>
          )}
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

      {/* 右: プレビュー */}
      {previewFile && (
        <FilePreview
          filePath={previewFile.filePath}
          docxBase64={previewFile.docxBase64}
          fileName={previewFile.fileName}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}
