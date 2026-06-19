"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { WarnHighlightMarkdown } from "./ui/WarnHighlightMarkdown";
import type { ChatThread, ThreadMessage, ActionCard, Company, ClarificationCard } from "@/types";
import ActionCardRenderer from "./cards/ActionCardRenderer";
import FilePreview from "./FilePreview";
import { Icon } from "./ui/Icon";

interface Props {
  company: Company | null;
  threadId: string | null;
  onThreadUpdate: () => void;
}

export default function ChatWorkflow({ company, threadId, onThreadUpdate }: Props) {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // 校正モード (proofread) 実行中のメッセージ ID。同時に複数 card で動くことは想定しない。
  // プレビューはタブ式: 開いた書類をタブとして並べて、クリックで切替
  type PreviewTab = {
    filePath?: string;
    docxBase64?: string;
    fileName: string;
    filledSlots?: import("@/types").FilledSlot[];
    templatePath?: string;
    issues?: import("@/types").CheckIssue[];
    docName?: string;
  };
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([]);
  const [activeTabIdx, setActiveTabIdx] = useState(0);
  // 既存コードとの互換 wrapper (setPreviewFile 呼ばれたら同名タブを切替 or 追加)
  // 関数版 (prev => next) はアクティブタブの内容を更新する用途
  const setPreviewFile = (
    tabOrUpdater: PreviewTab | null | ((prev: PreviewTab | null) => PreviewTab | null)
  ) => {
    if (typeof tabOrUpdater === "function") {
      setPreviewTabs((prev) => {
        const current = prev[activeTabIdx] || null;
        const next = tabOrUpdater(current);
        if (next === null) {
          // アクティブタブだけ削除
          const filtered = prev.filter((_, i) => i !== activeTabIdx);
          if (activeTabIdx >= filtered.length) setActiveTabIdx(Math.max(0, filtered.length - 1));
          return filtered;
        }
        const updated = [...prev];
        updated[activeTabIdx] = next;
        return updated;
      });
      return;
    }
    if (tabOrUpdater === null) {
      setPreviewTabs([]);
      setActiveTabIdx(0);
      return;
    }
    setPreviewTabs((prev) => {
      const existIdx = prev.findIndex((t) => t.fileName === tabOrUpdater.fileName);
      if (existIdx >= 0) {
        const updated = [...prev];
        updated[existIdx] = tabOrUpdater;
        setActiveTabIdx(existIdx);
        return updated;
      }
      const next = [...prev, tabOrUpdater];
      setActiveTabIdx(next.length - 1);
      return next;
    });
  };
  // 関数からも previewFile 的に参照したい時用
  const previewFile = previewTabs[activeTabIdx] || null;

  // 全書類を一括でタブとして開く (active = 最初の書類)。
  // DocumentResultCard の「全プレビュー」ボタンが使う。
  // setPreviewFile (旧 wrapper) は append のたびに active を最後に動かすので、
  // ループで呼ぶと最後の書類がアクティブになる問題があった → これで解決。
  const openAllPreviewTabs = (files: PreviewTab[]) => {
    if (files.length === 0) return;
    setPreviewTabs(files);
    setActiveTabIdx(0);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingTemplatePath = useRef<string | null>(null);

  // スレッド読み込み
  useEffect(() => {
    if (!threadId || !company) { setThread(null); return; }
    fetch(`/api/chat-threads/${threadId}?companyId=${encodeURIComponent(company.id)}`)
      .then(r => r.json())
      .then(data => {
        const loaded: ChatThread | null = data.thread || null;
        if (!loaded) { setThread(null); return; }
        // 既に checkResult が thread に保存されているが、document-result カードに未反映の時は
        // ここで JSON をパースしてマージする（再 verify は不要）
        const checkText = loaded.checkResult;
        if (checkText && typeof checkText === "string" && checkText.includes("documents")) {
          try {
            const m = checkText.match(/```json\s*([\s\S]*?)```/) || checkText.match(/(\{[\s\S]*\})/);
            if (m) {
              const parsed = JSON.parse(m[1] || m[0]) as { summary?: string; documents?: Array<{ docName: string; status?: string; issues?: Array<{ severity?: string; aspect?: string; problem?: string; expected?: string; slotId?: number; candidates?: { value: string; source: string }[] }> }> };
              if (parsed.documents) {
                for (let i = loaded.messages.length - 1; i >= 0; i--) {
                  const cards = loaded.messages[i].cards;
                  if (!cards) continue;
                  const docIdx = cards.findIndex(c => c.type === "document-result");
                  if (docIdx < 0) continue;
                  const docCard = cards[docIdx];
                  if (docCard.type !== "document-result") break;
                  // 既にマージ済みなら何もしない
                  if (docCard.documents.some(d => d.checkStatus !== undefined)) break;
                  const updatedDocs = docCard.documents.map(doc => {
                    const baseFromFile = doc.fileName.replace(/\.[^.]+$/, "");
                    const match = parsed.documents!.find(d => {
                      if (!d.docName) return false;
                      const dn = d.docName.replace(/\.[^.]+$/, "");
                      return (
                        d.docName === doc.name || d.docName === doc.fileName ||
                        dn === doc.name || dn === baseFromFile ||
                        dn.endsWith(doc.name) || doc.name.endsWith(dn) || baseFromFile.endsWith(dn)
                      );
                    });
                    if (!match) return doc;
                    const issues = (match.issues || []).map(iss => ({
                      severity: (iss.severity === "error" || iss.severity === "warn" || iss.severity === "info" ? iss.severity : "warn") as "error" | "warn" | "info",
                      aspect: iss.aspect || "",
                      problem: iss.problem || "",
                      expected: iss.expected,
                      slotId: typeof iss.slotId === "number" ? iss.slotId : undefined,
                      candidates: Array.isArray(iss.candidates) ? iss.candidates.filter(c => c && typeof c.value === "string") : undefined,
                    }));
                    const status: "ok" | "warn" | "error" =
                      match.status === "error" || issues.some(i => i.severity === "error") ? "error" :
                      match.status === "warn" || issues.length > 0 ? "warn" : "ok";
                    return { ...doc, checkStatus: status, issues };
                  });
                  const updatedCard = { ...docCard, documents: updatedDocs, checkSummary: parsed.summary || "" };
                  loaded.messages[i] = { ...loaded.messages[i], cards: cards.map((c, idx) => idx === docIdx ? updatedCard : c) };
                  break;
                }
              }
            }
          } catch { /* ignore */ }
        }
        setThread(loaded);
      })
      .catch(() => setThread(null));
  }, [threadId, company?.id]);

  // スレッドや会社が変わったらプレビューを閉じる
  // （前のセッションの書類が右ペインに残ったままだと混乱の元）
  useEffect(() => {
    setPreviewFile(null);
  }, [threadId, company?.id]);

  // 空スレッドに初期カード（フォルダ選択）を遅延生成して追加する。
  // POST /api/chat-threads が軽量化されて messages が空で返ってくるので、ここで補完。
  useEffect(() => {
    if (!thread || !company) return;
    if (thread.messages.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/chat-threads/${thread.id}/initial`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId: company.id }),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && data.thread) setThread(data.thread);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [thread?.id, thread?.messages.length, company?.id]);

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
          companyId: company.id,
          threadId: thread.id,
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
    else if (card?.type === "template-review" && (cardData as { acknowledged?: boolean }).acknowledged) {
      // [このまま実行] 押下 → カードを acknowledged にして保留中のワークフローを継続
      const updatedCard = { ...card, acknowledged: true };
      const updatedMessages = thread.messages.map(m => {
        if (m.id !== messageId) return m;
        const newCards = (m.cards || []).map((c, i) => i === cardIndex ? (updatedCard as ActionCard) : c);
        return { ...m, cards: newCards };
      });
      const updatedThread: ChatThread = { ...thread, messages: updatedMessages };
      setThread(updatedThread);
      await fetch(`/api/chat-threads/${thread.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id, messages: updatedThread.messages }),
      });
      await runWorkflow(updatedThread, card.folderPath);
      setLoading(false);
      return;
    }
    else if (card?.type === "clarification") {
      // 確認質問に回答 → 回答を反映。
      // - kind="procedural" (Phase 2-A 質問への回答) → 再 clarify なし、即 analyze → produce
      // - 省略 or "substantive" (Phase 1) → clarify を再呼び出し → 終わったら analyze-questions → analyze → produce
      const isProcedural = card.kind === "procedural";
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
            // 「その他注意点」(general_note) は任意回答。空白で submit した場合も
            // 「答え終わった」扱いにして previousQA に含める。さもないと clarify route の
            // alreadyHasGeneralNote 判定が常に false になり、毎回再質問されてしまう。
            const isGeneralNote = q.id === "general_note" || q.placeholder === "案件全体の注意点";
            if (ans) {
              previousQA.push({ question: `【${q.placeholder}】${q.question}`, answer: ans });
            } else if (isGeneralNote && c.answered) {
              previousQA.push({ question: `【${q.placeholder}】${q.question}`, answer: "（特になし）" });
            }
          }
        }
      }

      // procedural の質問への回答完了 → 再 clarify はせず、即 analyze → produce へ。
      // (analyze-questions ルートは1回で全質問を出す前提。追加質問は出さない。)
      if (isProcedural) {
        const afterAnalyze = await runAnalyze(updatedThread, templatePath);
        await generateDocuments(afterAnalyze, templatePath, cardData as Partial<ActionCard>);
        pendingTemplatePath.current = null;
        return;
      }

      // substantive (Phase 1) の回答完了 → さらに質問があるか clarify ルートで判定
      const clarifyRes = await fetch("/api/document-templates/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          threadId: thread.id,
          templateFolderPath: templatePath,
          previousQA,
          folderPath: updatedThread.folderPath,
          disabledFiles: updatedThread.disabledFiles,
        }),
      });
      const clarifyData = await clarifyRes.json();

      if (clarifyData.questions && clarifyData.questions.length > 0) {
        // まだ実体的な確認事項がある → 次のカードを追加
        const nextMsg: ThreadMessage = {
          id: `msg_${Date.now()}`,
          role: "assistant",
          content: `さらに${clarifyData.questions.length}点確認があります`,
          cards: [{
            type: "clarification",
            questions: clarifyData.questions,
          }],
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

      // Phase 1 clarify (substantive) が完了 → Phase 2-A 質問抽出 → 質問あれば停止、
      // 無ければ analyze → produce へ続行
      const questionsResult = await runAnalyzeQuestions(updatedThread, templatePath);
      if (questionsResult.hasQuestions) {
        setLoading(false);
        return;
      }
      const afterAnalyze = await runAnalyze(questionsResult.thread, templatePath);
      await generateDocuments(afterAnalyze, templatePath, cardData as Partial<ActionCard>);
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
          const templatePath = cardData.selectedPath as string;
          // テンプレの解釈ラベルを確認。未生成のファイルがあれば AI に生成させて、
          // 新規生成があればレビューカードを挟む（初回だけ）。
          let shouldAutoProceed = true;
          try {
            const ensureRes = await fetch("/api/template-labels/ensure", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ folderPath: templatePath }),
            });
            if (ensureRes.ok) {
              const data = await ensureRes.json();
              if (data.newlyGenerated > 0) {
                const reviewMsg: ThreadMessage = {
                  id: `msg_${Date.now()}`,
                  role: "assistant",
                  content: "テンプレート解釈を生成しました。",
                  cards: [{
                    type: "template-review",
                    folderPath: templatePath,
                    templateName: templatePath.split(/[\\/]/).pop() || templatePath,
                    totalFiles: data.totalFiles,
                    newlyGenerated: data.newlyGenerated,
                    files: (data.files || []).map((f: { name: string; slotCount: number; wasNew: boolean }) => ({
                      name: f.name, slotCount: f.slotCount, wasNew: f.wasNew,
                    })),
                  }],
                  timestamp: new Date().toISOString(),
                };
                setThread(prev => prev ? { ...prev, messages: [...prev.messages, reviewMsg] } : prev);
                await fetch(`/api/chat-threads/${result.thread.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ companyId: company.id, message: reviewMsg }),
                });
                shouldAutoProceed = false;
              }
            }
          } catch { /* ensure 失敗時は従来どおり実行 */ }

          if (shouldAutoProceed) {
            await runWorkflow(result.thread, templatePath);
          }
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

    // 基本情報が無ければ案件整理を始めず、先に基本情報の作成を促す。
    // 案件整理は会社の基本情報(定款・登記・株主構成など)を前提に行うため。
    const hasProfile = !!(company.profile && (company.profile.summary || company.profile.structured));
    if (!hasProfile) {
      const guardMsg: ThreadMessage = {
        id: `msg_${Date.now()}_noprofile`,
        role: "assistant",
        content:
          "⚠️ **先に「基本情報」を作成してください**\n\n" +
          "案件整理は、会社の基本情報（定款・登記・株主構成など）を前提に行います。" +
          "この会社にはまだ基本情報がありません。\n\n" +
          "上部の「**基本情報**」タブで基本情報を作成してから、もう一度お試しください。",
        timestamp: new Date().toISOString(),
      };
      setThread(prev => (prev ? { ...prev, messages: [...prev.messages, guardMsg] } : prev));
      return;
    }

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
          threadId: currentThread.id,
        }),
      });
      const reader = res.body?.getReader();
      // Phase 1 (案件整理) の AI 推論文を <details> で「最初から折り畳み」表示。
      // stage 情報で「今何してるか」を summary に出す (文字数より意味的)。
      const wrapOrganizeReasoning = (text: string, stage: string): string => {
        const summary = {
          starting: `🚀 案件整理を開始中...`,
          organizing: `📋 案件整理中... (案件資料を読んで内容理解中)`,
          "linking-sources": `🔗 出典リンク生成中...`,
          complete: `✓ 案件整理完了 (クリックで展開)`,
        }[stage] || `📋 案件整理中...`;
        return `<details>\n<summary>${summary}</summary>\n\n${text}\n\n</details>`;
      };
      if (reader) {
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        let currentStage = "starting";
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
            } else if (data.type === "stage") {
              currentStage = data.stage;
              const wrapped = wrapOrganizeReasoning(fullText, currentStage);
              setThread(prev => {
                if (!prev) return prev;
                const msgs = [...prev.messages];
                const last = msgs[msgs.length - 1];
                if (last.role === "assistant") msgs[msgs.length - 1] = { ...last, content: wrapped };
                return { ...prev, messages: msgs };
              });
            } else if (data.type === "text") {
              fullText += data.text;
              const wrapped = wrapOrganizeReasoning(fullText, currentStage);
              setThread(prev => {
                if (!prev) return prev;
                const msgs = [...prev.messages];
                const last = msgs[msgs.length - 1];
                if (last.role === "assistant") msgs[msgs.length - 1] = { ...last, content: wrapped };
                return { ...prev, messages: msgs };
              });
            }
          }
        }

        // 出典リンクを生成 (この間 summary を "linking-sources" に切り替え)
        if (metaSourceFiles.length > 0 && fullText) {
          setThread(prev => {
            if (!prev) return prev;
            const msgs = [...prev.messages];
            const last = msgs[msgs.length - 1];
            if (last.role === "assistant") msgs[msgs.length - 1] = { ...last, content: wrapOrganizeReasoning(fullText, "linking-sources") };
            return { ...prev, messages: msgs };
          });
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
                const fileLinks = (files as { id: string; name: string }[]).map(f => f.name).join(" / ");
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
        // - 画面表示用 (message.content): <details> 折り畳み付きで保存 (リロードしても折り畳み維持)
        // - clarify / chat API 用 (masterSheet.content): 折り畳みタグ無しの素 md
        //   (LLM が details タグを読まないようにするため)
        const wrappedFinal = wrapOrganizeReasoning(fullText, "complete");
        organizeMsg.content = wrappedFinal;
        await fetch(`/api/chat-threads/${currentThread.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: company.id,
            message: organizeMsg,
            masterSheet: { content: fullText },
          }),
        });
      }

      // 案件整理が終わった直後のスレッドで書類生成できるよう、ここで最新内容を含むスレッドを作る
      // （currentThread 引数は organizeMsg 追加前のスナップショットなので stale になる）
      const freshThread: ChatThread = {
        ...currentThread,
        messages: [...currentThread.messages, organizeMsg],
      };

      // 2. 確認質問（clarify）
      // 会話履歴から AI が自分で organize の「⚠ 要確認事項」を覚えているので
      // knownMissing 安全網は不要（旧設計の遺物。重複質問の原因だった）
      const clarifyRes = await fetch("/api/document-templates/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          threadId: currentThread.id,
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

      // 3. 質問なし → Phase 2-A (テンプレ見て質問抽出) → 質問あれば停止、無ければ analyze → 書類生成
      const questionsResult = await runAnalyzeQuestions(freshThread, templatePath);
      if (questionsResult.hasQuestions) {
        setLoading(false);
        return;
      }
      const afterAnalyze = await runAnalyze(questionsResult.thread, templatePath);
      await generateDocuments(afterAnalyze, templatePath);
    } catch { /* ignore */ }
    finally { setLoading(false); onThreadUpdate(); }
  };

  // Phase 2: テンプレ突き合わせ分析 (書類生成の前に挟む)
  // 既に Phase 1 (案件整理) と clarify が完了している状態で呼ぶ。
  // 結果は assistant メッセージとして md でストリーミング表示し、終わったら次の generateDocuments に進む。
  const runAnalyze = async (currentThread: ChatThread, templatePath: string): Promise<ChatThread> => {
    if (!company) return currentThread;
    const analyzeMsg: ThreadMessage = {
      id: `msg_${Date.now()}_analyze`,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };
    setThread(prev => prev ? { ...prev, messages: [...prev.messages, analyzeMsg] } : prev);

    // Phase 1 clarify の Q&A を集めて analyze に渡す。
    // 会話履歴 (aiMessages) には AI 側の質問しか残らないので、ユーザーの回答は明示的に渡す必要がある。
    const previousQA: { question: string; answer: string }[] = [];
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
          if (ans) {
            previousQA.push({ question: `【${q.placeholder}】${q.question}`, answer: ans });
          }
        }
      }
    }

    let fullText = "";
    // analyze ルートが SSE で送ってくる構造化決定 (phase2Decisions) とテンプレ構造。
    // ストリーミング完了後、人間向けの md の下に <details> で折り畳んで両方表示する。
    let receivedDecisions: import("@/types").Phase2Decisions | null = null;
    let receivedStructures: { templateFile: string; markedText: string }[] = [];
    try {
      const res = await fetch("/api/document-templates/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          threadId: currentThread.id,
          templateFolderPath: templatePath,
          previousQA,
        }),
      });
      const reader = res.body?.getReader();
      // analyze は末尾に ```json ... ``` の構造化決定ブロックを出す。これは機械が読むだけで
      // ユーザーには見せない。表示用テキストは json ブロックの直前で切る。
      const stripJsonBlock = (s: string): string => {
        const idx = s.search(/```json/);
        if (idx >= 0) return s.slice(0, idx).trimEnd();
        return s;
      };
      // AI の中間推論 md を <details> で「最初から折り畳み」表示する (Claude Extended Thinking 風)。
      // stage 情報で「今何してるか」を細かく summary に出す。
      const wrapReasoning = (text: string, stage: string): string => {
        const summary = {
          starting: `🚀 Phase 2 分析を開始中...`,
          "reading-templates": `📂 テンプレート読み込み中...`,
          reasoning: `🤔 推論中... (各書類の slot をどう埋めるか検討中)`,
          structuring: `🔧 構造化中... (Tool Use で JSON 化)`,
          validating: `✅ 検証中... (整合性チェック)`,
          complete: `✓ Phase 2 分析完了 (クリックで推論を展開)`,
        }[stage] || `🤔 Phase 2 分析中...`;
        return `<details>\n<summary>${summary}</summary>\n\n${text}\n\n</details>`;
      };
      if (reader) {
        const decoder = new TextDecoder();
        let buffer = "";
        let currentStage = "starting";
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
            if (data.type === "stage") {
              currentStage = data.stage;
              const displayText = wrapReasoning(stripJsonBlock(fullText), currentStage);
              setThread(prev => {
                if (!prev) return prev;
                const msgs = [...prev.messages];
                const last = msgs[msgs.length - 1];
                if (last.role === "assistant" && last.id === analyzeMsg.id) {
                  msgs[msgs.length - 1] = { ...last, content: displayText };
                }
                return { ...prev, messages: msgs };
              });
            } else if (data.type === "text") {
              fullText += data.text;
              const displayText = wrapReasoning(stripJsonBlock(fullText), currentStage);
              setThread(prev => {
                if (!prev) return prev;
                const msgs = [...prev.messages];
                const last = msgs[msgs.length - 1];
                if (last.role === "assistant" && last.id === analyzeMsg.id) {
                  msgs[msgs.length - 1] = { ...last, content: displayText };
                }
                return { ...prev, messages: msgs };
              });
            } else if (data.type === "decisions") {
              receivedDecisions = data.decisions || null;
            } else if (data.type === "structures") {
              receivedStructures = data.structures || [];
            }
          }
        }
      }
    } catch (e) {
      console.warn("[ChatWorkflow] analyze failed:", e instanceof Error ? e.message : e);
    }

    // 保存も JSON ブロックを除いた表示用テキストで行う (リロード時に JSON が見えないように)
    // 機械可読な決定は thread.phase2Decisions にバックエンドが保存済み
    const stripped = (() => {
      const idx = fullText.search(/```json/);
      return idx >= 0 ? fullText.slice(0, idx).trimEnd() : fullText;
    })();
    // 完了時は推論文を「折り畳み」状態で保存 (リロードしてもデフォルト closed)
    const reasoningBlock = `<details>\n<summary>🤔 Phase 2 分析完了 (クリックで推論を展開)</summary>\n\n${stripped}\n\n</details>`;
    // 折り畳みで「最終データ」と「テンプレ構造」を見せる
    const decisionsBlock = receivedDecisions
      ? `\n\n<details>\n<summary>📋 書類作成に使う最終データ (Phase 2 決定 — クリックで展開)</summary>\n\n\`\`\`json\n${JSON.stringify(receivedDecisions, null, 2)}\n\`\`\`\n\n</details>`
      : "";
    const structuresBlock = receivedStructures.length > 0
      ? `\n\n<details>\n<summary>🗂️ テンプレ構造 (★label★ = 穴埋め位置 — クリックで展開)</summary>\n\n${receivedStructures.map(s => `#### ${s.templateFile}\n\n\`\`\`\n${s.markedText}\n\`\`\``).join("\n\n")}\n\n</details>`
      : "";
    const displayText = reasoningBlock + decisionsBlock + structuresBlock;
    // 折り畳みも含めて状態に反映
    setThread(prev => {
      if (!prev) return prev;
      const msgs = [...prev.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && last.id === analyzeMsg.id) {
        msgs[msgs.length - 1] = { ...last, content: displayText };
      }
      return { ...prev, messages: msgs };
    });
    const savedMsg = { ...analyzeMsg, content: displayText };
    await fetch(`/api/chat-threads/${currentThread.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId: company.id, message: savedMsg }),
    });

    return { ...currentThread, messages: [...currentThread.messages, savedMsg] };
  };

  // Phase 2 clarify (書面ルール上の確認質問)
  // Phase 2-A: テンプレを見て「穴埋めで迷うポイント」を抽出 → 質問化。
  // analyze (Phase 2-C 穴埋め決定) の **前** に呼ぶ。質問抽出 = 業務判断や表記揺れの確認を、
  // AI が独自ルールで推測 fill する前にユーザーに聞く。
  //
  // 戻り値:
  //   - { thread, hasQuestions: true } → 質問カードを出して停止。回答後の continueWorkflow で analyze 実行
  //   - { thread, hasQuestions: false } → 質問なし。呼び出し側がそのまま analyze → produce に進む
  const runAnalyzeQuestions = async (
    currentThread: ChatThread,
    templatePath: string
  ): Promise<{ thread: ChatThread; hasQuestions: boolean }> => {
    if (!company) return { thread: currentThread, hasQuestions: false };

    // 既存の clarification カードから previousQA を集める (Phase 1 substantive の回答)
    const previousQA: { question: string; answer: string }[] = [];
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
          const isGeneralNote = q.id === "general_note" || q.placeholder === "案件全体の注意点";
          if (ans) {
            previousQA.push({ question: `【${q.placeholder}】${q.question}`, answer: ans });
          } else if (isGeneralNote && c.answered) {
            previousQA.push({ question: `【${q.placeholder}】${q.question}`, answer: "（特になし）" });
          }
        }
      }
    }

    try {
      const res = await fetch("/api/document-templates/analyze-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          threadId: currentThread.id,
          templateFolderPath: templatePath,
          previousQA,
        }),
      });
      const data = await res.json();
      if (data.questions && data.questions.length > 0) {
        const proceduralMsg: ThreadMessage = {
          id: `msg_${Date.now()}_analyze_q`,
          role: "assistant",
          content: `穴埋め前に確認したい点が${data.questions.length}点あります`,
          cards: [{
            type: "clarification",
            questions: data.questions,
            kind: "procedural",
          }],
          timestamp: new Date().toISOString(),
        };
        setThread(prev => prev ? { ...prev, messages: [...prev.messages, proceduralMsg] } : prev);
        await fetch(`/api/chat-threads/${currentThread.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId: company.id, message: proceduralMsg }),
        });
        pendingTemplatePath.current = templatePath;
        return {
          thread: { ...currentThread, messages: [...currentThread.messages, proceduralMsg] },
          hasQuestions: true,
        };
      }
    } catch (e) {
      console.warn("[ChatWorkflow] analyze-questions failed:", e instanceof Error ? e.message : e);
    }

    return { thread: currentThread, hasQuestions: false };
  };

  // 書類生成
  const generateDocuments = async (currentThread: ChatThread, templatePath: string, clarificationData?: Partial<ActionCard>) => {
    if (!company) return;
    setLoading(true);
    console.log("[ChatWorkflow] generateDocuments called, templatePath:", templatePath);

    // スレッド内の案件整理結果を探す
    const organizeContent = currentThread.messages.find(m => m.role === "assistant" && m.content.length > 200)?.content || "";

    // 確認質問の回答を収集（placeholder名→確定値のマップ）
    // confirmedAnswers: { placeholder, question, answer, options } で完全な文脈を produce に渡す。
    // 旧 Record<placeholder, answer> だと AI が「何を聞いた質問か」を見られなかった。
    const confirmedAnswers: { placeholder: string; question: string; answer: string; options: { label: string; source?: string }[] }[] = [];
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
          if (ans) {
            confirmedAnswers.push({
              placeholder: q.placeholder,
              question: q.question,
              answer: ans,
              options: q.options.map(o => ({ label: o.label, source: o.source })),
            });
          }
        }
      }
    }

    // 新パイプライン: per-doc Haiku + edit engine。
    // Phase 2 で確定した phase2Decisions は thread に保存済みなので、サーバ側でそれを読む。
    // confirmedAnswers / masterContent / organizeContent は新ルートでは未使用 (Phase 2 経由で見える)。
    const produceRes = await fetch("/api/document-templates/produce-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: company.id,
        threadId: currentThread.id,
        templateFolderPath: templatePath,
      }),
    });
    const produceData = await produceRes.json();
    console.log(`[ChatWorkflow] produce response:`, produceData.error || `${produceData.documents?.length || 0} docs`);

    if (produceData.error || !produceData.documents || produceData.documents.length === 0) {
      if (produceData.error) {
        const errorMsg: ThreadMessage = {
          id: `msg_${Date.now()}_err`,
          role: "assistant",
          content: `書類生成エラー: ${produceData.error}`,
          timestamp: new Date().toISOString(),
        };
        setThread(prev => prev ? { ...prev, messages: [...prev.messages, errorMsg] } : prev);
      }
      setLoading(false);
      onThreadUpdate();
      return;
    }

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
    // ⚠️ state にも generatedDocuments を同期保存すること。
    // しないと後の runCheck / handleBulkRegenerate が thread.generatedDocuments を読んだとき
    // 空配列になり、PATCH で server 側の generatedDocuments が wipe され、verify が
    // 「生成済み書類なし」で 400 を返す。
    setThread(prev => prev ? {
      ...prev,
      messages: [...prev.messages, resultMsg],
      generatedDocuments: produceData.documents,
    } : prev);
    // 全書類を プレビュータブとして自動オープン (ユーザーが個別にプレビュー押す手間を省く)
    const newTabs: PreviewTab[] = produceData.documents.map((doc: {
      name: string; fileName: string; docxBase64: string;
      filledSlots?: import("@/types").FilledSlot[]; templatePath?: string;
    }) => ({
      docxBase64: doc.docxBase64,
      fileName: doc.fileName,
      filledSlots: doc.filledSlots,
      templatePath: doc.templatePath,
      docName: doc.name,
    }));
    setPreviewTabs(newTabs);
    setActiveTabIdx(0);
    // 裏で active 以外のタブを並列 prefetch
    // (Word は複数プロセスを同時に動かせることを確認済み: 8 並列で 21s)
    // ユーザーがタブを切り替える頃にはキャッシュヒットで瞬時表示
    (async () => {
      const { prefetch } = await import("@/lib/preview-cache");
      await Promise.all(
        newTabs.slice(1).map(tab => prefetch({ docxBase64: tab.docxBase64, fileName: tab.fileName }))
      );
    })();
    await fetch(`/api/chat-threads/${currentThread.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId: company.id, message: resultMsg, generatedDocuments: produceData.documents }),
    });

    // 自動でチェック実行 (verify) — 指摘内容を書類カードにバッジ + issue 一覧で表示するだけで、
    // 修正は人間が手元で行う想定。runCheck 内で setLoading の出し入れと onThreadUpdate を行う。
    await runCheck(currentThread);
  };

  // チェック実行
  // 編集タブで [保存] された pendingChanges のある書類だけを一括再生成
  const handleBulkRegenerate = async (messageId: string, cardIndex: number) => {
    if (!thread || !company) return;
    const msg = thread.messages.find(m => m.id === messageId);
    const card = msg?.cards?.[cardIndex];
    if (!card || card.type !== "document-result") return;

    const targets = card.documents.filter(d => d.pendingChanges && d.templatePath && d.filledSlots);
    if (targets.length === 0) return;

    setLoading(true);
    try {
      // 各書類を順次再生成（並列にすると LibreOffice / fs ロックで衝突しがち）
      const updatedDocs = [...card.documents];
      for (const doc of targets) {
        try {
          const res = await fetch("/api/document-templates/regenerate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              templatePath: doc.templatePath,
              fileName: doc.fileName,
              filledSlots: (doc.filledSlots || []).map(s => ({ slotId: s.slotId, value: s.value })),
            }),
          });
          if (res.ok) {
            const data = await res.json();
            const idx = updatedDocs.findIndex(d => d.fileName === doc.fileName);
            if (idx >= 0) {
              // 再生成したら issues は古い情報なのでクリア（status も ok に戻す）
              // 改めて検証したい場合は「検証」ボタンで verify を再実行する
              updatedDocs[idx] = {
                ...updatedDocs[idx],
                docxBase64: data.docxBase64,
                pendingChanges: false,
                checkStatus: "ok",
                issues: [],
              };
            }
          }
        } catch { /* 1 件失敗しても他は続ける */ }
      }

      // thread に反映
      const updatedMessages = thread.messages.map(m => {
        if (m.id !== messageId) return m;
        const newCards = (m.cards || []).map((c, i) => i === cardIndex ? { ...c, documents: updatedDocs } as ActionCard : c);
        return { ...m, cards: newCards };
      });
      const updatedGenDocs = (thread.generatedDocuments || []).map(gd => {
        const u = updatedDocs.find(d => d.fileName === gd.fileName);
        return u ? { ...gd, docxBase64: u.docxBase64, pendingChanges: false } : gd;
      });
      const updatedThread: ChatThread = { ...thread, messages: updatedMessages, generatedDocuments: updatedGenDocs };
      setThread(updatedThread);
      // プレビュー開いてる書類があれば、そっちも更新
      if (previewFile) {
        const u = updatedDocs.find(d => d.fileName === previewFile.fileName);
        if (u) setPreviewFile(prev => prev ? { ...prev, docxBase64: u.docxBase64 } : prev);
      }
      await fetch(`/api/chat-threads/${thread.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          messages: updatedMessages,
          generatedDocuments: updatedGenDocs,
        }),
      });
    } finally {
      setLoading(false);
    }
  };

  // runCheck: verify を呼び、返ってきた markdown チェックリストをそのまま check-result
  // カードとして新規メッセージで表示するだけ。指摘の解決・修正は人間が手元で行う前提なので、
  // document-result カードへのマージや個別 issue の ack 機構は持たない。
  const runCheck = async (currentThread: ChatThread): Promise<void> => {
    if (!company) return;
    setLoading(true);
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
      if (!reader) return;

      // 先にプレースホルダーカードを追加して「セルフチェック中」を可視化。
      // 旧実装は全部受信し終わってから1個カード追加だったので、20-30秒間「何も起きてない」
      // ように見えていた。本体テキストを受信しながらリアルタイム更新する。
      const checkMsgId = `msg_${Date.now()}_verify`;
      const checkMsg: ThreadMessage = {
        id: checkMsgId,
        role: "assistant",
        content: "",
        cards: [{ type: "check-result", content: "_セルフチェック中..._" }],
        timestamp: new Date().toISOString(),
      };
      setThread(prev => prev ? { ...prev, messages: [...prev.messages, checkMsg] } : prev);

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
          const m = line.match(/^data: (.+)$/m);
          if (!m) continue;
          const data = JSON.parse(m[1]);
          if (data.type === "text") {
            fullText += data.text;
            // ストリーミング更新: check-result カードの content を進行中テキストで書き換え
            setThread(prev => {
              if (!prev) return prev;
              const msgs = prev.messages.map(m => {
                if (m.id !== checkMsgId) return m;
                const newCards = (m.cards || []).map(c =>
                  c.type === "check-result" ? { ...c, content: fullText } : c
                );
                return { ...m, cards: newCards };
              });
              return { ...prev, messages: msgs };
            });
          }
        }
      }

      const trimmed = fullText.trim();
      if (!trimmed) {
        // 完了時に空ならカードを削除
        setThread(prev => prev ? { ...prev, messages: prev.messages.filter(m => m.id !== checkMsgId) } : prev);
        return;
      }

      // 最終確定: trim した内容で書き換え + 永続化
      setThread(prev => {
        if (!prev) return prev;
        const msgs = prev.messages.map(m => {
          if (m.id !== checkMsgId) return m;
          const newCards = (m.cards || []).map(c =>
            c.type === "check-result" ? { ...c, content: trimmed } : c
          );
          return { ...m, cards: newCards };
        });
        return { ...prev, messages: msgs };
      });
      const finalMsg: ThreadMessage = {
        ...checkMsg,
        cards: [{ type: "check-result", content: trimmed }],
      };
      await fetch(`/api/chat-threads/${currentThread.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id, message: finalMsg, checkResult: trimmed }),
      });

      // verify が docx に officecli add comment でコメント書き込み → thread.json 更新済み。
      // フロントの previewTabs は古い docxBase64 を保持してるので、再 fetch して更新。
      // 更新先の docxBase64 を裏で prefetch → サーバ/クライアントキャッシュに格納 →
      // previewTabs を新 base64 に切替 → FilePreview がキャッシュヒットで瞬時にコメント付き画像に。
      try {
        const refreshed = await fetch(
          `/api/chat-threads/${currentThread.id}?companyId=${encodeURIComponent(company.id)}`
        ).then(r => r.json());
        // GET レスポンスは { thread: {...} } でネストされてる
        const updatedDocs: { fileName: string; docxBase64: string }[] = refreshed?.thread?.generatedDocuments || [];
        console.log(`[runCheck] post-verify refresh: ${updatedDocs.length} docs found`);
        if (updatedDocs.length > 0) {
          // 新 base64 を裏で prefetch
          const { prefetch } = await import("@/lib/preview-cache");
          await Promise.all(
            updatedDocs.map(d => prefetch({ docxBase64: d.docxBase64, fileName: d.fileName }))
          );
          // prefetch 完了 → previewTabs と thread.generatedDocuments を新 base64 で更新
          setThread(prev => prev ? { ...prev, generatedDocuments: updatedDocs as typeof prev.generatedDocuments } : prev);
          setPreviewTabs(prev => prev.map(tab => {
            const updated = updatedDocs.find(d => d.fileName === tab.fileName);
            return updated ? { ...tab, docxBase64: updated.docxBase64 } : tab;
          }));
        }
      } catch (e) {
        console.warn("[runCheck] post-verify thread refresh failed:", e);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); onThreadUpdate(); }
  };

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-hover)]">
        <p className="text-sm text-[var(--color-fg-subtle)]">サイドバーから会社を選択してください</p>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-hover)]">
        <div className="text-center">
          <Icon name="MessageSquare" size={36} className="mx-auto mb-3 text-[var(--color-fg-subtle)]" />
          <p className="text-sm text-[var(--color-fg-muted)]">チャットを選択するか、新規作成してください</p>
        </div>
      </div>
    );
  }
  // フォルダ選択カードがまだ未確定なら、accordion 展開を快適に見せるため
  // チャットエリアの幅制約を緩める（このフラグを下の return JSX で参照する）
  const hasUnconfirmedFolderSelect = thread.messages.some(m =>
    m.cards?.some(c => c.type === "folder-select" && !c.selectedPath)
  );

  return (
    <div id="main-content-area" className="flex h-full">
      {/* 左: チャット */}
      <div className={`flex flex-col ${previewFile ? "flex-1 min-w-0" : "w-full"}`}>
      {/* メッセージ一覧 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {/* 「フォルダ選択カード」がまだ確定していない間は accordion でファイル一覧を
            展開できるので、カードに余白を与えるため幅制約を緩める。確定後は通常の
            65% / 1100px に戻る */}
        <div className={`mx-auto px-10 py-10 ${
          previewFile
            ? "w-full max-w-none"
            : hasUnconfirmedFolderSelect
              ? "w-[90%] min-w-[560px] max-w-[1600px]"
              : "w-[65%] min-w-[560px] max-w-[1100px]"
        }`}>
          {/* 案件名ヘッダ */}
          <div className="mb-8">
            <h1 className="font-serif text-[26px] font-semibold tracking-tight mb-1 text-[var(--color-fg)]">
              {thread.displayName || "新規チャット"}
            </h1>
            <div className="text-[12px] text-[var(--color-fg-muted)]">
              {company.name}
              {thread.createdAt && <> · {new Date(thread.createdAt).toLocaleDateString("ja-JP")}</>}
            </div>
          </div>
          {thread.messages.length === 0 && (
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-fg-subtle)] py-6">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
              フォルダ一覧を準備中...
            </div>
          )}
          {thread.messages.map((msg, i) => {
            const goBack = () => {
              for (const m of thread.messages) {
                const idx = (m.cards || []).findIndex(c => c.type === "folder-select");
                if (idx >= 0) {
                  handleCardAction(m.id, idx, { selectedPath: undefined } as Partial<ActionCard>);
                  return;
                }
              }
            };
            if (msg.role === "user") {
              // ユーザー発言は黒背景の吹き出し（右寄せ）
              return (
                <div key={msg.id} className="flex justify-end mb-10">
                  <div className="max-w-[70%] rounded-2xl px-4 py-3 text-[14px] leading-relaxed bg-[var(--color-fg)] text-[var(--color-bg)]">
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              );
            }
            // AIメッセージ: 吹き出し廃止。アバター + フローテキスト
            return (
              <article key={msg.id} className="mb-10">
                <header className="flex items-center gap-2.5 mb-3">
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold text-white shrink-0"
                    style={{ background: "linear-gradient(135deg, #fbbf24, #d97706)" }}
                  >
                    R
                  </div>
                  <span className="font-serif text-[12px] font-medium">recast</span>
                </header>
                <div className="pl-8 text-[14px] leading-[1.75] text-[var(--color-fg)] prose-recast max-w-none">
                  <WarnHighlightMarkdown>{msg.content}</WarnHighlightMarkdown>
                  {loading && i === thread.messages.length - 1 && !msg.content && (
                    <div className="flex items-center gap-2 text-[var(--color-fg-subtle)]">
                      <Icon name="Loader2" size={14} className="animate-spin" />
                      <span className="text-xs animate-pulse">考え中...</span>
                    </div>
                  )}
                  {/* アクションカード */}
                  {msg.cards?.map((card, ci) => (
                    <div key={ci} className="mt-3 not-prose">
                      <ActionCardRenderer
                        card={card}
                        onAction={(data) => handleCardAction(msg.id, ci, data)}
                        company={company}
                        thread={thread}
                        onPreview={setPreviewFile}
                        onPreviewAll={openAllPreviewTabs}
                        onGoBackToFolder={goBack}
                        onBulkRegenerate={card.type === "document-result" ? () => handleBulkRegenerate(msg.id, ci) : undefined}
                      />
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
          {/* 考え中表示（末尾） */}
          {loading && (
            <div className="flex items-center gap-2 pl-8 text-[var(--color-fg-subtle)]">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-[var(--color-fg-subtle)] rounded-full animate-bounce" />
                <span className="w-2 h-2 bg-[var(--color-fg-subtle)] rounded-full animate-bounce [animation-delay:0.15s]" />
                <span className="w-2 h-2 bg-[var(--color-fg-subtle)] rounded-full animate-bounce [animation-delay:0.3s]" />
              </div>
              <span className="text-xs">処理中...</span>
            </div>
          )}
        </div>
      </div>

      {/* 入力欄 */}
      <div className="px-10 py-5 bg-[var(--color-bg)]">
        <div className={`mx-auto ${
          previewFile
            ? "w-full max-w-none"
            : hasUnconfirmedFolderSelect
              ? "w-[90%] min-w-[560px] max-w-[1600px]"
              : "w-[65%] min-w-[560px] max-w-[1100px]"
        }`}>
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[0_2px_8px_rgba(0,0,0,0.04)] flex items-end gap-2 px-4 py-3 focus-within:border-[var(--color-accent)]/40">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px"; }}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="メッセージを入力..."
              disabled={loading}
              rows={1}
              className="flex-1 resize-none bg-transparent text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none py-1.5 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className="w-9 h-9 rounded-xl shrink-0 flex items-center justify-center text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-fg)] disabled:bg-[var(--color-hover)] disabled:text-[var(--color-fg-subtle)]"
              aria-label="送信"
            >
              <Icon name="Send" size={14} />
            </button>
          </div>
        </div>
      </div>
      </div>

      {/* 右: プレビュー (上部ドロップダウンで書類切替、本体はフル幅) */}
      {previewTabs.length > 0 && previewFile && (
        <div className="flex flex-col w-[60%] min-w-0 border-l border-[var(--color-border-soft)] bg-[var(--color-panel)]">
          {/* ドロップダウンヘッダー: 前へ / 選択 / 次へ / 全閉じる */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border-soft)] bg-[var(--color-panel-soft)] shrink-0">
            <button
              onClick={() => setActiveTabIdx(Math.max(0, activeTabIdx - 1))}
              disabled={activeTabIdx === 0}
              className="w-6 h-6 flex items-center justify-center rounded text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-30 disabled:cursor-default shrink-0"
              title="前の書類"
            ><Icon name="ChevronLeft" size={15} /></button>

            <div className="relative flex-1 min-w-0">
              <select
                value={activeTabIdx}
                onChange={(e) => setActiveTabIdx(Number(e.target.value))}
                className="w-full appearance-none bg-[var(--color-panel)] border border-[var(--color-border-soft)] rounded-lg pl-3 pr-8 py-1.5 text-[12px] text-[var(--color-fg)] font-medium cursor-pointer hover:border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] truncate"
              >
                {previewTabs.map((tab, idx) => (
                  <option key={tab.fileName + idx} value={idx}>
                    {idx + 1}. {tab.docName || tab.fileName}
                  </option>
                ))}
              </select>
              <Icon name="ChevronsUpDown" size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-fg-subtle)] pointer-events-none" />
            </div>

            <span className="text-[11px] text-[var(--color-fg-subtle)] shrink-0 tabular-nums">{activeTabIdx + 1}/{previewTabs.length}</span>

            <button
              onClick={() => setActiveTabIdx(Math.min(previewTabs.length - 1, activeTabIdx + 1))}
              disabled={activeTabIdx >= previewTabs.length - 1}
              className="w-6 h-6 flex items-center justify-center rounded text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-30 disabled:cursor-default shrink-0"
              title="次の書類"
            ><Icon name="ChevronRight" size={15} /></button>

            <button
              onClick={() => { setPreviewTabs([]); setActiveTabIdx(0); }}
              className="text-[10px] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] shrink-0 px-1"
              title="プレビューを閉じる"
            >閉じる</button>
          </div>

          {/* アクティブ書類の内容 (フル幅) */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 flex">
        <FilePreview
          filePath={previewFile.filePath}
          docxBase64={previewFile.docxBase64}
          fileName={previewFile.fileName}
          onClose={() => {
            // 単一タブ閉じる動作: アクティブタブを削除
            setPreviewTabs((prev) => {
              const next = prev.filter((_, i) => i !== activeTabIdx);
              if (activeTabIdx >= next.length) setActiveTabIdx(Math.max(0, next.length - 1));
              return next;
            });
          }}
          filledSlots={previewFile.filledSlots}
          templatePath={previewFile.templatePath}
          companyId={company?.id}
          threadId={thread?.id}
          verifyIssues={
            previewFile.issues && previewFile.issues.length > 0 && previewFile.docName
              ? [{ docName: previewFile.docName, issues: previewFile.issues }]
              : undefined
          }
          onRegenerated={(newBase64, newSlots) => {
            // プレビュー内の docxBase64 を更新
            setPreviewFile(prev => prev ? { ...prev, docxBase64: newBase64, filledSlots: newSlots } : prev);
            // スレッド内の該当書類も更新（document-result カードの該当 doc を差し替え）
            if (!thread || !company) return;
            const updatedMessages = thread.messages.map(m => {
              if (!m.cards) return m;
              const newCards = m.cards.map(c => {
                if (c.type !== "document-result") return c;
                const newDocs = c.documents.map(d =>
                  d.fileName === previewFile.fileName
                    ? { ...d, docxBase64: newBase64, filledSlots: newSlots }
                    : d
                );
                return { ...c, documents: newDocs };
              });
              return { ...m, cards: newCards };
            });
            const updatedThread: ChatThread = { ...thread, messages: updatedMessages };
            setThread(updatedThread);
            // 永続化: thread.generatedDocuments 側も対応する書類を更新
            const updatedGenDocs = (thread.generatedDocuments || []).map(gd =>
              gd.fileName === previewFile.fileName
                ? { ...gd, docxBase64: newBase64, filledSlots: newSlots }
                : gd
            );
            fetch(`/api/chat-threads/${thread.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                companyId: company.id,
                messages: updatedMessages,
                generatedDocuments: updatedGenDocs,
              }),
            }).catch(() => { /* ignore */ });
          }}
          onSaveValues={(newSlots) => {
            // 値だけ保存（docx は再生成しない、書類カードで一括再生成する）
            if (!thread || !company) return;
            const updatedMessages = thread.messages.map(m => {
              if (!m.cards) return m;
              const newCards = m.cards.map(c => {
                if (c.type !== "document-result") return c;
                const newDocs = c.documents.map(d =>
                  d.fileName === previewFile.fileName
                    ? { ...d, filledSlots: newSlots, pendingChanges: true }
                    : d
                );
                return { ...c, documents: newDocs };
              });
              return { ...m, cards: newCards };
            });
            const updatedThread: ChatThread = { ...thread, messages: updatedMessages };
            setThread(updatedThread);
            setPreviewFile(prev => prev ? { ...prev, filledSlots: newSlots } : prev);
            const updatedGenDocs = (thread.generatedDocuments || []).map(gd =>
              gd.fileName === previewFile.fileName
                ? { ...gd, filledSlots: newSlots, pendingChanges: true }
                : gd
            );
            fetch(`/api/chat-threads/${thread.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                companyId: company.id,
                messages: updatedMessages,
                generatedDocuments: updatedGenDocs,
              }),
            }).catch(() => { /* ignore */ });
          }}
          onIssueAcknowledge={(slotId, ack) => {
            if (!thread || !company) return;
            // document-result カード内の該当書類の issues を更新
            const updatedMessages = thread.messages.map(m => {
              if (!m.cards) return m;
              const newCards = m.cards.map(c => {
                if (c.type !== "document-result") return c;
                const newDocs = c.documents.map(d => {
                  if (d.fileName !== previewFile.fileName) return d;
                  const newIssues = (d.issues || []).map(iss =>
                    iss.slotId === slotId ? { ...iss, acknowledged: ack } : iss
                  );
                  // 残りの未解決 issue 数で status を再計算
                  const unresolved = newIssues.filter(i => !i.acknowledged);
                  const newStatus: "ok" | "warn" | "error" =
                    unresolved.length === 0 ? "ok" :
                    unresolved.some(i => i.severity === "error") ? "error" : "warn";
                  return { ...d, issues: newIssues, checkStatus: newStatus };
                });
                return { ...c, documents: newDocs };
              });
              return { ...m, cards: newCards };
            });
            const updatedThread: ChatThread = { ...thread, messages: updatedMessages };
            setThread(updatedThread);
            // 永続化
            fetch(`/api/chat-threads/${thread.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ companyId: company.id, messages: updatedMessages }),
            }).catch(() => { /* ignore */ });
          }}
        />
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
