"use client";

// 事由駆動型 申請書生成パネル（タブ「申請」）— 資料先行フロー（インボックス型）。
//
// 体験（入口の反転）: 案件の資料を全部放り込む → 事由の方から名乗り出る（AI 提案・人が確定）
//   → 原本の充当と fact 読み取りは自動 → 判断と、資料に無かった値だけ聞かれる → 決定論生成。
// 事由ボタンから直接始める従来の入口もフォールバックとして残す。
// 設計: docs/資料先行フロー-設計.md

import { useState, useEffect, useCallback, useRef } from "react";
import type { Company } from "@/types";
import { Icon } from "@/components/ui/Icon";
import FilePreview from "@/components/FilePreview";
import JireiTreeView from "@/components/JireiTreeView";

interface JireiSummary {
  id: string;
  name: string;
  description: string;
}

interface JireiQuestionUI {
  id: string;
  label: string;
  kind?: string;
  choices?: string[];
}

interface ProducedDocUI {
  name: string;
  fileName: string;
  kind: "docx" | "xlsx";
  base64: string;
}

// インボックスの資料。kind は /api/jirei/suggest の中身ベース分類（原本充当の正）
interface InboxFile {
  name: string;
  base64: string;
  kind?: string;
}

interface SuggestCandidate {
  jireiId: string;
  name: string;
  description: string;
  reason: string;
  quote: string;
  caution: string;
  guards: string[];
  requiredSources: { key: string; label: string; optional?: boolean }[];
}

interface SuggestResult {
  candidates: SuggestCandidate[];
  fileKinds: Record<string, string>;
  kindLabels: Record<string, string>;
  shogo: string;
  companyMatch: { id: string; name: string } | null;
  unreadable: string[];
}

const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function readFilesAsBase64(fileList: FileList | File[]): Promise<{ name: string; base64: string }[]> {
  return Promise.all(
    Array.from(fileList).map(
      (f) =>
        new Promise<{ name: string; base64: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            resolve({ name: f.name, base64: dataUrl.split(",")[1] || "" });
          };
          reader.onerror = () => reject(new Error(`読み込み失敗: ${f.name}`));
          reader.readAsDataURL(f);
        })
    )
  );
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function downloadBase64(base64: string, fileName: string, kind: string) {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const blob = new Blob([arr], { type: MIME[kind] || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// 種別バッジの短い表示名（kindLabels の長い説明文から先頭だけ）
function shortKind(kind: string | undefined, kindLabels: Record<string, string> | undefined): string {
  if (!kind) return "";
  const label = kindLabels?.[kind] || kind;
  return label.split("（")[0];
}

export default function JireiPanel({ company }: { company: Company | null }) {
  const [jireiList, setJireiList] = useState<JireiSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "sources" | "questions" | "done">("idle");
  const [autoFilled, setAutoFilled] = useState<Record<string, string>>({});
  // 原本直読みモード: 必要書類の受付状況 / 出典 / 判断の根拠（定款の条文引用）
  const [sourceStatus, setSourceStatus] = useState<
    { label: string; optional: boolean; kind: "found" | "dropped" | "missing"; name: string | null }[]
  >([]);
  const [sourcesReady, setSourcesReady] = useState(false);
  const [sourcesConfirmed, setSourcesConfirmed] = useState(false);
  const [sourceMeta, setSourceMeta] = useState<{ files: string[]; cached: boolean } | null>(null);
  const [evidenceByLabel, setEvidenceByLabel] = useState<Record<string, string>>({});
  // ガード: 木に載っている専門家の注意書き（分岐に応じて出る）
  const [guards, setGuards] = useState<string[]>([]);
  const [questions, setQuestions] = useState<JireiQuestionUI[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [documents, setDocuments] = useState<ProducedDocUI[]>([]);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [previewDoc, setPreviewDoc] = useState<ProducedDocUI | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- インボックス（資料先行の入口。全段がこの器の資料を使い回す） ---
  const [inbox, setInbox] = useState<InboxFile[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestResult, setSuggestResult] = useState<SuggestResult | null>(null);
  const [pickedCandidate, setPickedCandidate] = useState<string | null>(null);
  const [linkedCompanyId, setLinkedCompanyId] = useState<string | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);

  // 回答プレフィル: 案件連絡から抽出した「全質問分」の答え。質問が波状に出るたび未入力欄に適用。
  // 判断（choice）には自動適用しない — 提案表示に留め、確定は人のクリック。
  const [prefill, setPrefill] = useState<{ answers: Record<string, string>; sources: Record<string, string> } | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractNote, setExtractNote] = useState<string | null>(null);
  const [extractSources, setExtractSources] = useState<Record<string, string>>({});
  const [dragOver, setDragOver] = useState<string | null>(null);
  const inboxInputRef = useRef<HTMLInputElement>(null);
  const intakeInputRef = useRef<HTMLInputElement>(null);
  const extractInputRef = useRef<HTMLInputElement>(null);

  // 事由コンパイラ（テンプレフォルダ → AI が木を生成。AI が働くのはこの登録時1回だけ）
  const [compileOpen, setCompileOpen] = useState(false);
  const [compileFolders, setCompileFolders] = useState<{ name: string; fileCount: number }[]>([]);
  const [compileFolder, setCompileFolder] = useState("");
  const [compileInstruction, setCompileInstruction] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [compileResult, setCompileResult] = useState<{ name: string; warnings: string[] } | null>(null);
  // 木の可視化（ロジックツリー表示）
  const [treeViewId, setTreeViewId] = useState<string | null>(null);
  // AI チェック（原本突合せ + 事由の当否）
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    issues: { document: string; location: string; problem: string; correct?: string; severity: string }[];
    sources: string[];
  } | null>(null);

  const effectiveCompanyId = company?.id ?? linkedCompanyId ?? undefined;

  // ============================================================
  // API 呼び出し（フェーズ計算。決定論なので同じ入力なら同じ結果）
  // ============================================================
  const callApi = useCallback(
    async (
      jireiId: string,
      currentAnswers: Record<string, string>,
      extraSources?: InboxFile[],
      confirmedOverride?: boolean
    ) => {
      setLoading(true);
      setError(null);
      const files = extraSources ?? inbox;
      const confirmed = confirmedOverride ?? sourcesConfirmed;
      try {
        const res = await fetch("/api/jirei", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: effectiveCompanyId,
            jireiId,
            answers: currentAnswers,
            sources: files.map((f) => ({ name: f.name, base64: f.base64, kind: f.kind })),
            sourcesConfirmed: confirmed,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "エラーが発生しました");
          return;
        }
        setAutoFilled(data.autoFilled || {});
        setEvidenceByLabel(data.evidenceByLabel || {});
        setGuards(data.guards || []);
        if (data.sourceMeta) setSourceMeta(data.sourceMeta);
        if (data.phase === "sources") {
          setPhase("sources");
          setSourceStatus(data.sources || []);
          setSourcesReady(!!data.ready);
        } else if (data.phase === "questions") {
          setPhase("questions");
          setQuestions(data.questions || []);
        } else {
          setPhase("done");
          setDocuments(data.documents || []);
          setUnresolved(data.unresolved || []);
          if ((data.documents || []).length > 0) setPreviewDoc(data.documents[0]);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "通信に失敗しました");
      } finally {
        setLoading(false);
      }
    },
    [effectiveCompanyId, inbox, sourcesConfirmed]
  );
  const callApiRef = useRef(callApi);
  useEffect(() => {
    callApiRef.current = callApi;
  }, [callApi]);

  // ============================================================
  // 下書きの永続化（消えない器 — 設計書 §3-1）
  // ============================================================
  useEffect(() => {
    (async () => {
      try {
        const d = await fetch("/api/jirei/inbox").then((r) => r.json());
        const draft = d.draft;
        if (draft) {
          setInbox(Array.isArray(draft.inbox) ? draft.inbox : []);
          setPasteText(draft.pasteText || "");
          setSuggestResult(draft.suggest || null);
          setAnswers(draft.answers || {});
          setExtractSources(draft.extractSources || {});
          setPrefill(draft.prefill || null);
          setLinkedCompanyId(draft.linkedCompanyId || null);
          if (draft.suggest?.candidates?.length === 1) setPickedCandidate(draft.suggest.candidates[0].jireiId);
          if (draft.selectedId) {
            setSelectedId(draft.selectedId);
            setSourcesConfirmed(!!draft.sourcesConfirmed);
            // フェーズ再計算（生成物は保存していないが、決定論なので同じ入力から再現できる）
            callApiRef.current(draft.selectedId, draft.answers || {}, draft.inbox || [], !!draft.sourcesConfirmed);
          }
        }
      } catch {
        /* 下書きが読めなくても新規で始められる */
      }
      setDraftLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!draftLoaded) return;
    const t = setTimeout(() => {
      const hasContent = inbox.length > 0 || pasteText.trim() || selectedId;
      if (!hasContent) return;
      fetch("/api/jirei/inbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft: {
            inbox,
            pasteText,
            suggest: suggestResult,
            selectedId,
            sourcesConfirmed,
            answers,
            extractSources,
            prefill,
            linkedCompanyId,
          },
        }),
      }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [draftLoaded, inbox, pasteText, suggestResult, selectedId, sourcesConfirmed, answers, extractSources, prefill, linkedCompanyId]);

  // ============================================================
  // プレフィルの波状適用: 質問が出るたび、未入力の非 choice 欄にだけ流し込む
  // ============================================================
  useEffect(() => {
    if (!prefill || questions.length === 0) return;
    setAnswers((prev) => {
      let touched = false;
      const next = { ...prev };
      for (const q of questions) {
        if (q.kind === "choice") continue; // 判断は提案止まり（自動で埋めない）
        if ((next[q.id] || "").trim()) continue;
        const v = prefill.answers[q.id];
        if (v) {
          next[q.id] = v;
          touched = true;
        }
      }
      return touched ? next : prev;
    });
    setExtractSources((prev) => {
      const next = { ...prev };
      for (const q of questions) {
        if (prefill.sources[q.id] && !next[q.id]) next[q.id] = prefill.sources[q.id];
      }
      return next;
    });
  }, [prefill, questions]);

  // ============================================================
  // インボックス操作
  // ============================================================
  const addPasteAsMemo = (): InboxFile[] => {
    if (!pasteText.trim()) return inbox;
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const memo: InboxFile = {
      name: `メモ_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`,
      base64: textToBase64(pasteText.trim()),
      kind: "renraku",
    };
    const merged = [...inbox, memo];
    setInbox(merged);
    setPasteText("");
    return merged;
  };

  // 種別分類（suggest 呼び出し）。同じ資料セットならサーバー側キャッシュで AI ゼロ。
  const classify = async (files: InboxFile[]): Promise<{ files: InboxFile[]; result: SuggestResult | null }> => {
    try {
      const res = await fetch("/api/jirei/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: files.map((f) => ({ name: f.name, base64: f.base64 })) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "資料の分類に失敗しました");
        return { files, result: null };
      }
      const withKinds = files.map((f) => ({ ...f, kind: data.fileKinds?.[f.name] || f.kind }));
      setInbox(withKinds);
      return { files: withKinds, result: data as SuggestResult };
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信に失敗しました");
      return { files, result: null };
    }
  };

  // 「事由を推定する」— 入口の反転の中心。提案はすべて人が確定してから進む。
  const runSuggest = async () => {
    const files = addPasteAsMemo();
    if (files.length === 0) {
      setError("資料をドロップするか、依頼の内容を一言貼り付けてください");
      return;
    }
    setSuggesting(true);
    setError(null);
    setSuggestResult(null);
    setPickedCandidate(null);
    try {
      const { result } = await classify(files);
      if (result) {
        setSuggestResult(result);
        if (result.candidates.length === 1) setPickedCandidate(result.candidates[0].jireiId);
      }
    } finally {
      setSuggesting(false);
    }
  };

  // 案件連絡から全質問分の答えを抽出（プレフィル。人が確認してから生成）
  const extractPrefill = async (jireiId: string, files: InboxFile[]) => {
    if (files.length === 0) return;
    setExtracting(true);
    setExtractNote(null);
    try {
      const res = await fetch("/api/jirei/extract-answers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jireiId, files: files.map((f) => ({ name: f.name, base64: f.base64 })) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setExtractNote(data.error || "資料からの読み取りに失敗しました");
        return;
      }
      setPrefill((prev) => ({
        answers: { ...(prev?.answers || {}), ...(data.answers || {}) },
        sources: { ...(prev?.sources || {}), ...(data.sources || {}) },
      }));
      const n = Object.keys(data.answers || {}).length;
      setExtractNote(n > 0 ? `${n}件の答えを資料から読み取りました。内容を確認してください` : "この資料からは答えを読み取れませんでした");
    } catch (e) {
      setExtractNote(e instanceof Error ? e.message : "抽出に失敗しました");
    } finally {
      setExtracting(false);
    }
  };

  // 提案の確定 = 事由と資料の受付をまとめて 1 クリック
  const confirmCandidate = (c: SuggestCandidate) => {
    setSelectedId(c.jireiId);
    setSourcesConfirmed(true);
    const renraku = inbox.filter((f) => f.kind === "renraku");
    if (renraku.length > 0) extractPrefill(c.jireiId, renraku);
    callApi(c.jireiId, answers, inbox, true);
  };

  // 受付フェーズでの追加ドロップ: 器に足す → 中身で分類 → 充当を再評価
  const handleIntakeAdd = async (fileList: FileList | File[]) => {
    const arr = await readFilesAsBase64(fileList);
    if (arr.length === 0) return;
    const merged = [...inbox, ...arr];
    setInbox(merged);
    setLoading(true);
    const { files } = await classify(merged);
    if (selectedId) await callApi(selectedId, answers, files, sourcesConfirmed);
    else setLoading(false);
  };

  // 質問フェーズでの追加ドロップ: 案件連絡として器に足し、答えを抽出してプレフィル
  const handleExtractAdd = async (fileList: FileList | File[]) => {
    if (!selectedId) return;
    const arr = await readFilesAsBase64(fileList);
    if (arr.length === 0) return;
    const asRenraku: InboxFile[] = arr.map((f) => ({ ...f, kind: "renraku" }));
    setInbox((prev) => [...prev, ...asRenraku]);
    await extractPrefill(selectedId, asRenraku);
  };

  // ============================================================
  // AI チェック（原本突合せ + 依頼内容との整合 = 事由の当否）
  // ============================================================
  const runVerify = async () => {
    if (!selectedId || documents.length === 0) return;
    setVerifying(true);
    setVerifyResult(null);
    setError(null);
    try {
      const originals = inbox.filter((f) => f.kind !== "renraku" && f.kind !== "sonota");
      const intent = inbox.filter((f) => f.kind === "renraku");
      const res = await fetch("/api/jirei/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: effectiveCompanyId,
          jireiId: selectedId,
          documents: documents.map((d) => ({ fileName: d.fileName, base64: d.base64 })),
          sources: originals.map((f) => ({ name: f.name, base64: f.base64 })),
          intent: intent.map((f) => ({ name: f.name, base64: f.base64 })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "チェックに失敗しました");
        return;
      }
      setVerifyResult({ issues: data.issues || [], sources: data.sources || [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信に失敗しました");
    } finally {
      setVerifying(false);
    }
  };

  // ============================================================
  // 事由コンパイラ（覚えさせる動線からも開く）
  // ============================================================
  const openCompile = async (instructionSeed?: string) => {
    setCompileOpen(true);
    setCompileResult(null);
    if (instructionSeed) setCompileInstruction(instructionSeed);
    try {
      const r = await fetch("/api/jirei/compile");
      const d = await r.json();
      setCompileFolders(d.folders || []);
    } catch {
      setCompileFolders([]);
    }
  };

  const runCompile = async () => {
    if (!compileFolder) return;
    setCompiling(true);
    setCompileResult(null);
    setError(null);
    try {
      const r = await fetch("/api/jirei/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: compileFolder, instruction: compileInstruction }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "事由化に失敗しました");
        return;
      }
      setCompileResult({ name: d.jirei?.name || compileFolder, warnings: d.warnings || [] });
      const list = await fetch("/api/jirei").then((x) => x.json());
      setJireiList(list.jirei || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信に失敗しました");
    } finally {
      setCompiling(false);
    }
  };

  useEffect(() => {
    fetch("/api/jirei")
      .then((r) => r.json())
      .then((d) => setJireiList(d.jirei || []))
      .catch(() => setJireiList([]));
  }, []);

  // 案件はそのまま、事由だけやり直す（事由ボタン直接選択・提案からの切替）
  const resetCase = () => {
    setSelectedId(null);
    setPhase("idle");
    setAutoFilled({});
    setQuestions([]);
    setDocuments([]);
    setUnresolved([]);
    setPreviewDoc(null);
    setError(null);
    setExtracting(false);
    setExtractNote(null);
    setDragOver(null);
    setSourceStatus([]);
    setSourcesReady(false);
    setSourcesConfirmed(false);
    setSourceMeta(null);
    setEvidenceByLabel({});
    setGuards([]);
    setVerifying(false);
    setVerifyResult(null);
  };

  // 全部消して最初から（下書きも破棄）
  const resetAll = () => {
    resetCase();
    setInbox([]);
    setPasteText("");
    setSuggestResult(null);
    setPickedCandidate(null);
    setPrefill(null);
    setAnswers({});
    setExtractSources({});
    setLinkedCompanyId(null);
    fetch("/api/jirei/inbox", { method: "DELETE" }).catch(() => {});
  };

  const handleSelectJirei = (id: string) => {
    resetCase();
    setSelectedId(id);
    // インボックスに案件連絡があればプレフィルも回す（直接選択でも資料は活きる）
    const renraku = inbox.filter((f) => f.kind === "renraku");
    if (renraku.length > 0) extractPrefill(id, renraku);
    callApi(id, answers, inbox);
  };

  // 全画面プレビューを Esc で閉じる
  useEffect(() => {
    if (!previewDoc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewDoc(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewDoc]);

  const handleSubmitAnswers = () => {
    if (!selectedId) return;
    callApi(selectedId, answers);
  };

  const selectedJirei = jireiList.find((j) => j.id === selectedId);

  // 質問の3区画分け: 判断（choice）/ 読み取り済み（プレフィル済み）/ 入力が必要
  const choiceQs = questions.filter((q) => q.kind === "choice" && (q.choices?.length || 0) > 0);
  const nonChoiceQs = questions.filter((q) => !(q.kind === "choice" && (q.choices?.length || 0) > 0));
  const prefilledQs = nonChoiceQs.filter((q) => (answers[q.id] || "").trim() && extractSources[q.id]);
  const askQs = nonChoiceQs.filter((q) => !((answers[q.id] || "").trim() && extractSources[q.id]));

  const questionInput = (q: JireiQuestionUI) =>
    q.kind === "text" ? (
      <textarea
        value={answers[q.id] || ""}
        onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
        rows={4}
        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[13px] focus:outline-none focus:border-[var(--color-accent)]"
      />
    ) : (
      <input
        type="text"
        value={answers[q.id] || ""}
        onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[13px] focus:outline-none focus:border-[var(--color-accent)]"
      />
    );

  return (
    <div className="flex h-full overflow-hidden">
      {/* 左: フロー */}
      <div className="w-[460px] shrink-0 overflow-y-auto border-r border-[var(--color-border)] p-5 space-y-4">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">申請</h2>
          <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
            案件の資料を放り込むと、事由の方から名乗り出ます
          </p>
        </div>

        {/* ============ 段0: インボックス（事由が決まるまで表示） ============ */}
        {!selectedId && (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 space-y-3">
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg)]">
              <Icon name="Inbox" size={14} className="text-[var(--color-accent-fg)]" />
              この案件に関するものを、全部入れてください
            </div>
            <div
              onClick={() => inboxInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver("inbox");
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={async (e) => {
                e.preventDefault();
                setDragOver(null);
                const arr = await readFilesAsBase64(e.dataTransfer.files);
                setInbox((prev) => [...prev, ...arr]);
              }}
              className={`cursor-pointer rounded-xl border border-dashed p-4 text-center text-[12px] transition-colors ${
                dragOver === "inbox"
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                  : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-accent)]"
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <Icon name="FileUp" size={13} />
                メール・登記情報・定款・名簿・メモをドロップ（後から追加できます）
              </span>
              <input
                ref={inboxInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={async (e) => {
                  if (!e.target.files) return;
                  const arr = await readFilesAsBase64(e.target.files);
                  e.target.value = "";
                  setInbox((prev) => [...prev, ...arr]);
                }}
              />
            </div>
            <div>
              <p className="mb-1 text-[11px] text-[var(--color-fg-muted)]">
                電話・口頭の依頼はここに一言（貼り付けはメモとして資料になります）
              </p>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={2}
                placeholder="例: 6/30 ◯◯社長より電話。取締役を2名追加したい。決議は書面で。"
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[12px] focus:outline-none focus:border-[var(--color-accent)]"
              />
            </div>
            {inbox.length > 0 && (
              <div className="space-y-1">
                {inbox.map((f, i) => (
                  <div
                    key={`${f.name}-${i}`}
                    className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[12px]"
                  >
                    <Icon name="FileText" size={12} className="shrink-0 text-[var(--color-fg-muted)]" />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    {f.kind && (
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          f.kind === "renraku"
                            ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]"
                            : f.kind === "sonota"
                              ? "bg-[var(--color-hover)] text-[var(--color-fg-muted)]"
                              : "bg-green-100 text-green-800"
                        }`}
                      >
                        {shortKind(f.kind, suggestResult?.kindLabels)}
                      </span>
                    )}
                    <button
                      onClick={() => setInbox((prev) => prev.filter((_, x) => x !== i))}
                      className="shrink-0 rounded p-0.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                      title="取り除く"
                    >
                      <Icon name="X" size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {suggestResult && suggestResult.unreadable.length > 0 && (
              <p className="text-[11px] text-amber-700">
                自動では読めない資料: {suggestResult.unreadable.join("、")}（値は質問で聞きます）
              </p>
            )}
            <button
              onClick={runSuggest}
              disabled={suggesting || (inbox.length === 0 && !pasteText.trim())}
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
            >
              {suggesting ? "資料を読んで事由を推定しています...（数秒）" : "事由を推定する"}
            </button>
          </div>
        )}

        {/* ============ 段1: 提案カード ============ */}
        {!selectedId && suggestResult && suggestResult.candidates.length > 0 && (
          <div className="rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-panel)] p-4 space-y-3">
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg)]">
              <Icon name="Sparkles" size={13} className="text-[var(--color-accent-fg)]" />
              {suggestResult.candidates.length === 1
                ? `この案件は「${suggestResult.candidates[0].name}」と読めます`
                : `${suggestResult.candidates.length}つの事由が考えられます — 確認して選んでください`}
            </div>
            {suggestResult.candidates.map((c) => (
              <div
                key={c.jireiId}
                onClick={() => setPickedCandidate(c.jireiId)}
                className={`relative w-full cursor-pointer rounded-xl border p-3 text-left transition-colors ${
                  pickedCandidate === c.jireiId
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                    : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
                }`}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setTreeViewId(c.jireiId);
                  }}
                  title="木を見る（何を聞いて何が出るか）"
                  className="absolute right-2 top-2 rounded-lg p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-accent-fg)]"
                >
                  <Icon name="Network" size={13} />
                </button>
                <div className="flex items-center gap-2 pr-6">
                  <span
                    className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                      pickedCandidate === c.jireiId
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)]"
                        : "border-[var(--color-border)]"
                    }`}
                  />
                  <span className="text-[13px] font-semibold">{c.name}</span>
                </div>
                {c.quote && (
                  <p className="mt-1.5 border-l-2 border-[var(--color-accent)] pl-2 text-[11.5px] text-[var(--color-fg-muted)]">
                    {c.quote}
                  </p>
                )}
                {c.reason && <p className="mt-1 text-[11.5px] text-[var(--color-fg-muted)]">{c.reason}</p>}
                {/* 前提: 名前だけ合って前提が合わない木のラバースタンプを防ぐ（確定前に読む） */}
                {(c.description || c.guards.length > 0) && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
                    <span className="font-semibold">この事由の前提: </span>
                    {c.description}
                    {c.guards.map((g, i) => (
                      <span key={i} className="block">{g}</span>
                    ))}
                  </div>
                )}
                {c.caution && (
                  <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-700">
                    <Icon name="TriangleAlert" size={11} className="mt-0.5 shrink-0" />
                    {c.caution}
                  </p>
                )}
                {/* 資料の充当（中身ベース判定の結果） */}
                <div className="mt-2 space-y-0.5 text-[11px] text-[var(--color-fg-muted)]">
                  {c.requiredSources.map((src) => {
                    const hit = inbox.find((f) => f.kind === src.key);
                    return (
                      <div key={src.key} className="flex items-center gap-1.5">
                        <span className="w-[88px] shrink-0">{src.label.split("（")[0]}</span>
                        {hit ? (
                          <span className="inline-flex items-center gap-1 text-green-700">
                            <Icon name="CircleCheck" size={11} />
                            {hit.name}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-700">
                            <Icon name="CircleAlert" size={11} />
                            {src.optional ? "任意（未提出）" : "不足 — 確定後に受付でドロップできます"}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {/* 会社の紐付け提案（確定は人） */}
            {suggestResult.companyMatch && !company && (
              <div className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 p-2.5 text-[11.5px] text-green-900">
                <Icon name="Building2" size={13} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  商号「{suggestResult.shogo}」は登録済みの会社（{suggestResult.companyMatch.name}）と一致します
                </span>
                {linkedCompanyId ? (
                  <span className="shrink-0 font-medium">✓ 紐付け済み</span>
                ) : (
                  <button
                    onClick={() => setLinkedCompanyId(suggestResult.companyMatch!.id)}
                    className="shrink-0 rounded-lg border border-green-600 px-2 py-1 font-medium hover:bg-green-100"
                  >
                    紐付ける
                  </button>
                )}
              </div>
            )}
            <button
              onClick={() => {
                const c = suggestResult.candidates.find((x) => x.jireiId === pickedCandidate);
                if (c) confirmCandidate(c);
              }}
              disabled={!pickedCandidate || loading}
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
            >
              {loading ? "資料を読み取っています..." : "この事由と資料で進む"}
            </button>
            <p className="text-center text-[11px] text-[var(--color-fg-muted)]">
              AI の提案です。勝手には進みません — 前提を確認してから確定してください
            </p>
          </div>
        )}

        {/* ============ 段1: 該当なし（a. 手動選択 / b. 覚えさせる / c. 新種） ============ */}
        {!selectedId && suggestResult && suggestResult.candidates.length === 0 && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 space-y-2 text-[12px] text-amber-900">
            <p className="flex items-start gap-2 font-medium">
              <Icon name="TriangleAlert" size={13} className="mt-0.5 shrink-0" />
              登録済みの事由には当たりませんでした
            </p>
            <p className="text-[11.5px]">
              依頼の意図が読める資料（メール・メモ）が無い場合、原本からは現状しか分かりません。
              電話の内容を一言貼り付けると当たることがあります。
            </p>
            <div className="space-y-1 pt-1 text-[11.5px]">
              <p>a. 見落としなら、下の事由一覧から直接選んでください</p>
              <p>
                b. recast がまだ覚えていない事由なら、
                <button
                  onClick={() => openCompile(pasteText || undefined)}
                  className="mx-1 rounded border border-amber-700 px-1.5 py-0.5 font-medium hover:bg-amber-100"
                >
                  テンプレフォルダから覚えさせる
                </button>
                （この案件を流しながら、次回からの資産になります）
              </p>
              <p>c. 雛形も過去例も無い新種は、1回目は Word で手作り → その完成品が次回 b の入力になります</p>
            </div>
          </div>
        )}

        {/* ============ 従来の入口（フォールバック）: 事由を直接選ぶ ============ */}
        {!selectedId && (
          <details className="group" open={jireiList.length > 0 && !suggestResult && inbox.length === 0}>
            <summary className="cursor-pointer list-none text-[12px] font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
              <span className="inline-flex items-center gap-1">
                <Icon name="ChevronRight" size={12} className="transition-transform group-open:rotate-90" />
                事由を直接選ぶ（{jireiList.length}件）
              </span>
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {jireiList.map((j) => (
                <div
                  key={j.id}
                  className="relative rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] transition-colors hover:border-[var(--color-accent)]"
                >
                  <button onClick={() => handleSelectJirei(j.id)} disabled={loading} className="w-full p-3 text-left">
                    <div className="flex items-center gap-2 pr-6">
                      <Icon name="FileText" size={14} />
                      <span className="text-[13px] font-medium">{j.name}</span>
                    </div>
                    {j.description && (
                      <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-fg-muted)] line-clamp-2">
                        {j.description}
                      </p>
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setTreeViewId(j.id);
                    }}
                    title="木を見る（何を聞いて何が出るか）"
                    className="absolute right-2 top-2 rounded-lg p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-accent-fg)]"
                  >
                    <Icon name="Network" size={13} />
                  </button>
                </div>
              ))}
              {jireiList.length === 0 && (
                <p className="col-span-2 text-[12px] text-[var(--color-fg-muted)]">
                  事由がありません（data/jirei/ に木の JSON を置いてください）
                </p>
              )}
            </div>
          </details>
        )}

        {/* 進行中の事由の見出し（確定後） */}
        {selectedId && (
          <div className="flex items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2">
            <Icon name="FileText" size={14} className="text-[var(--color-accent-fg)]" />
            <span className="text-[13px] font-semibold">{selectedJirei?.name || selectedId}</span>
            <span className="ml-1 text-[11px] text-[var(--color-fg-muted)]">資料{inbox.length}点</span>
            <button
              onClick={() => setTreeViewId(selectedId)}
              title="木を見る（何を聞いて何が出るか）"
              className="ml-auto rounded-lg p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-accent-fg)]"
            >
              <Icon name="Network" size={14} />
            </button>
            <button
              onClick={resetCase}
              className="rounded-lg px-2 py-1 text-[11px] text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
            >
              事由を選び直す
            </button>
          </div>
        )}

        {/* 事由コンパイラ: テンプレフォルダ → AI が木を生成（登録時1回だけ AI が働く） */}
        {!selectedId &&
          (!compileOpen ? (
            <button
              onClick={() => openCompile()}
              className="w-full rounded-xl border border-dashed border-[var(--color-border)] px-3 py-2 text-[12px] text-[var(--color-fg-muted)] hover:border-[var(--color-accent)] text-left"
            >
              ＋ テンプレフォルダから事由を追加（AI が木を作ります）
            </button>
          ) : (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium">テンプレフォルダから事由を追加</span>
                <button
                  onClick={() => setCompileOpen(false)}
                  className="text-[12px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                >
                  閉じる
                </button>
              </div>
              <select
                value={compileFolder}
                onChange={(e) => setCompileFolder(e.target.value)}
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[13px]"
              >
                <option value="">フォルダを選択...</option>
                {compileFolders.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}（{f.fileCount}ファイル）
                  </option>
                ))}
              </select>
              <textarea
                value={compileInstruction}
                onChange={(e) => setCompileInstruction(e.target.value)}
                rows={2}
                placeholder="どうやる案件か一言（例: 書面決議でやる / この書類は対象者ごとに1枚）"
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[12px]"
              />
              <button
                onClick={runCompile}
                disabled={!compileFolder || compiling}
                className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
              >
                {compiling ? "AI がテンプレを読んで木を作っています...（1分ほど）" : "この内容で事由にする"}
              </button>
              {compileResult && (
                <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-[12px] text-green-900 space-y-1">
                  <p>「{compileResult.name}」を追加しました。事由の推定にも載ります。</p>
                  {compileResult.warnings.length > 0 && (
                    <ul className="list-disc pl-4 text-amber-800">
                      {compileResult.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ))}

        {loading && (
          <div className="flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
            <Icon name="Loader2" size={13} className="animate-spin" />
            処理中...
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-[12px] text-red-700">{error}</div>
        )}

        {/* ============ 段2: 必要書類の受付（不足があるときだけ止まる） ============ */}
        {phase === "sources" && (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 space-y-3">
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg)]">
              <Icon name="FolderOpen" size={13} className="text-[var(--color-accent-fg)]" />
              この手続きに必要な資料
            </div>
            <div className="space-y-1.5">
              {sourceStatus.map((s) => (
                <div
                  key={s.label}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[12px] ${
                    s.kind === "missing"
                      ? "border-amber-300 bg-amber-50 text-amber-900"
                      : "border-green-200 bg-green-50 text-green-900"
                  }`}
                >
                  <Icon name={s.kind === "missing" ? "CircleAlert" : "CircleCheck"} size={14} className="shrink-0" />
                  <span className="font-medium">{s.label}</span>
                  <span className="ml-auto text-right text-[11px] opacity-80">
                    {s.kind === "found" && `${s.name}（フォルダから自動）`}
                    {s.kind === "dropped" && `${s.name}（インボックス）`}
                    {s.kind === "missing" && (s.optional ? "任意（無くても進めます）" : "届いたら下に追加してください")}
                  </span>
                </div>
              ))}
            </div>
            <div
              onClick={() => intakeInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver("intake");
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={async (e) => {
                e.preventDefault();
                setDragOver(null);
                await handleIntakeAdd(e.dataTransfer.files);
              }}
              className={`cursor-pointer rounded-xl border border-dashed p-3 text-center text-[12px] transition-colors ${
                dragOver === "intake"
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                  : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-accent)]"
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <Icon name="FileUp" size={13} />
                届いた資料をここに追加（ファイル名はそのままで大丈夫。中身で判定します）
              </span>
              <input
                ref={intakeInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={async (e) => {
                  if (!e.target.files) return;
                  const files = e.target.files;
                  e.target.value = "";
                  await handleIntakeAdd(files);
                }}
              />
            </div>
            <button
              onClick={() => {
                if (!selectedId) return;
                setSourcesConfirmed(true);
                callApi(selectedId, answers, undefined, true);
              }}
              disabled={!sourcesReady || loading}
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
            >
              {loading ? "資料を読み取っています..." : "この資料で読み取る"}
            </button>
            {!sourcesReady && (
              <p className="text-[11px] text-amber-700">
                不足分は届いてからで大丈夫です。この画面は閉じても消えません（続きから再開できます）
              </p>
            )}
          </div>
        )}

        {/* ガード: 木に載っている専門家の注意書き（選んだ分岐に応じて出る） */}
        {guards.length > 0 && (phase === "questions" || phase === "done") && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3 space-y-1">
            {guards.map((g, i) => (
              <p key={i} className="flex items-start gap-2 text-[12px] text-amber-900">
                <Icon name="TriangleAlert" size={13} className="mt-0.5 shrink-0" />
                {g}
              </p>
            ))}
          </div>
        )}

        {/* ============ 段3-1: あなたの判断（choice。プレフィルは提案止まり・確定は人） ============ */}
        {phase === "questions" && choiceQs.length > 0 && (
          <div
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 space-y-3"
            style={{ borderLeftWidth: 4, borderLeftColor: "var(--color-accent)" }}
          >
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg)]">
              <Icon name="Scale" size={13} className="text-[var(--color-accent-fg)]" />
              あなたの判断
              <span className="font-normal text-[11px] text-[var(--color-fg-muted)]">— 専門家が決めること</span>
            </div>
            {choiceQs.map((q) => (
              <div key={q.id} className="space-y-1.5">
                <p className="text-[12px] font-medium text-[var(--color-fg)]">{q.label}</p>
                {prefill?.answers[q.id] && !(answers[q.id] || "").trim() && (
                  <p className="rounded-lg border-l-2 border-[var(--color-accent)] bg-[var(--color-bg)] px-2 py-1.5 text-[11.5px] text-[var(--color-fg-muted)]">
                    資料には「{prefill.answers[q.id]}」とあります
                    {prefill.sources[q.id] ? `（出典: ${prefill.sources[q.id]}）` : ""}
                    — 提案です。クリックで確定してください
                  </p>
                )}
                {(q.choices || []).map((c) => (
                  <button
                    key={c}
                    onClick={() => {
                      // 判断の確定 = 分岐の確定。従属質問が波状に出るよう、その場で再評価する
                      const next = { ...answers, [q.id]: c };
                      setAnswers(next);
                      if (selectedId) callApi(selectedId, next);
                    }}
                    className={`flex w-full items-start gap-2 rounded-xl border p-2.5 text-left text-[12px] transition-colors ${
                      answers[q.id] === c
                        ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium"
                        : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
                    }`}
                  >
                    <span
                      className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                        answers[q.id] === c
                          ? "border-[var(--color-accent)] bg-[var(--color-accent)]"
                          : "border-[var(--color-border)]"
                      }`}
                    />
                    {c}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* ============ 段3-2: 資料から読み取り済み（見るだけ。根拠付き） ============ */}
        {selectedId &&
          (phase === "questions" || phase === "done") &&
          (Object.keys(autoFilled).length > 0 || prefilledQs.length > 0) && (
            <div
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 space-y-2"
              style={{ borderLeftWidth: 4, borderLeftColor: "#16a34a" }}
            >
              <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg)]">
                <Icon name="CheckCircle2" size={13} className="text-green-600" />
                資料から読み取り済み
                <span className="font-normal text-[11px] text-[var(--color-fg-muted)]">— 見るだけ。違っていたら直す</span>
              </div>
              {sourceMeta && (
                <p className="text-[11px] text-[var(--color-fg-muted)]">
                  出典: {sourceMeta.files.join("・")}
                  {sourceMeta.cached ? "（前回と同じ原本のため読み取り結果を再利用）" : "（いま原本を読み取りました）"}
                </p>
              )}
              {Object.keys(autoFilled).length > 0 && (
                <table className="w-full text-[12px]">
                  <tbody>
                    {Object.entries(autoFilled).map(([label, value]) => (
                      <tr key={label} className="border-t border-[var(--color-border)]">
                        <td className="py-1 pr-2 text-[var(--color-fg-muted)] whitespace-nowrap align-top w-[130px] break-words">
                          {label}
                        </td>
                        <td className="py-1 text-[var(--color-fg)] whitespace-pre-wrap break-words">
                          {value}
                          {evidenceByLabel[label] && (
                            <span className="mt-0.5 block text-[11px] text-[var(--color-fg-muted)]">
                              根拠: {evidenceByLabel[label]}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {phase === "questions" &&
                prefilledQs.map((q) => (
                  <div key={q.id}>
                    <label className="mb-1 block text-[12px] text-[var(--color-fg)]">{q.label}</label>
                    {questionInput(q)}
                    <p className="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">
                      資料「{extractSources[q.id]}」から読み取り — 編集できます
                    </p>
                  </div>
                ))}
            </div>
          )}

        {/* ============ 段3-3: 入力が必要（資料のどこにも無かった値だけ） ============ */}
        {phase === "questions" && (
          <div
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 space-y-3"
            style={{ borderLeftWidth: 4, borderLeftColor: "var(--color-border)" }}
          >
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg)]">
              <Icon name="PencilLine" size={13} className="text-amber-600" />
              入力が必要
              <span className="font-normal text-[11px] text-[var(--color-fg-muted)]">— 資料に無かった値だけ</span>
            </div>
            {/* 追加の案件資料から答えを読み取る（プレフィル。人が確認してから生成） */}
            <div
              onClick={() => !extracting && extractInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver("extract");
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                if (!extracting) handleExtractAdd(e.dataTransfer.files);
              }}
              className={`cursor-pointer rounded-xl border border-dashed p-2.5 text-center text-[12px] transition-colors ${
                dragOver === "extract"
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]"
                  : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-accent)]"
              }`}
            >
              {extracting ? (
                <span className="inline-flex items-center gap-2">
                  <Icon name="Loader2" size={13} className="animate-spin" />
                  資料を読んでいます...
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <Icon name="FileUp" size={13} />
                  答えが書いてある資料があればドロップ
                </span>
              )}
              <input
                ref={extractInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) handleExtractAdd(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            {extractNote && <p className="text-[11px] text-[var(--color-fg-muted)]">{extractNote}</p>}
            {askQs.length === 0 && (
              <p className="text-[11.5px] text-[var(--color-fg-muted)]">
                {choiceQs.some((q) => !(answers[q.id] || "").trim())
                  ? "上の判断を確定すると、残りの質問がここに出ます"
                  : "入力が必要な項目はありません"}
              </p>
            )}
            {askQs.map((q) => (
              <div key={q.id}>
                <label className="mb-1 block text-[12px] text-[var(--color-fg)]">{q.label}</label>
                {questionInput(q)}
              </div>
            ))}
            <button
              onClick={handleSubmitAnswers}
              disabled={loading || questions.some((q) => !(answers[q.id] || "").trim())}
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-white transition-opacity disabled:opacity-40"
            >
              書類を生成する
            </button>
          </div>
        )}

        {/* ============ 段4: 生成結果と検品 ============ */}
        {phase === "done" && (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 space-y-2">
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg)]">
              <Icon name="FileCheck2" size={13} className="text-green-600" />
              {selectedJirei?.name}の書類（{documents.length}件）
            </div>
            {documents.map((d) => (
              <div
                key={d.fileName}
                className={`flex items-center justify-between rounded-xl border p-2.5 ${
                  previewDoc?.fileName === d.fileName
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                    : "border-[var(--color-border)]"
                }`}
              >
                <button
                  onClick={() => setPreviewDoc(d)}
                  className="flex items-center gap-2 text-[13px] text-[var(--color-fg)] hover:text-[var(--color-accent-fg)] min-w-0"
                >
                  <Icon name={d.kind === "xlsx" ? "Sheet" : "FileText"} size={14} />
                  <span className="truncate">{d.fileName}</span>
                </button>
                <button
                  onClick={() => downloadBase64(d.base64, d.fileName, d.kind)}
                  className="shrink-0 rounded-lg p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                  title="ダウンロード"
                >
                  <Icon name="Download" size={14} />
                </button>
              </div>
            ))}
            {unresolved.length > 0 && (
              <p className="text-[11px] text-amber-700">
                値が決まらなかった穴: {unresolved.join("、")}（テンプレの文言のまま残っています）
              </p>
            )}
            {/* AI チェック（原本突合せ + 依頼内容との整合）。書き換えはしない、指摘だけ */}
            <button
              onClick={runVerify}
              disabled={verifying}
              className="w-full rounded-xl border border-[var(--color-accent)] px-4 py-2 text-[12px] font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-soft)] disabled:opacity-40"
            >
              {verifying ? "原本と突き合わせています...（30秒ほど）" : "AI チェック（原本と突合せ・¥30程度）"}
            </button>
            {verifyResult && verifyResult.issues.length === 0 && (
              <div className="rounded-xl border border-green-300 bg-green-50 p-3 text-[12px] text-green-900">
                ✓ 原本（{verifyResult.sources.join("・")}）と突き合わせて、問題は見つかりませんでした
              </div>
            )}
            {verifyResult && verifyResult.issues.length > 0 && (
              <div className="rounded-xl border border-red-300 bg-red-50 p-3 space-y-2">
                <p className="text-[12px] font-medium text-red-900">
                  {verifyResult.issues.length}件の指摘があります（原本: {verifyResult.sources.join("・")}）
                </p>
                {verifyResult.issues.map((it, i) => (
                  <div key={i} className="rounded-lg bg-white/70 p-2 text-[12px] text-red-900">
                    <span
                      className={`mr-1 rounded px-1.5 py-0.5 text-[10px] text-white ${
                        it.severity === "高" ? "bg-red-600" : it.severity === "中" ? "bg-amber-500" : "bg-gray-400"
                      }`}
                    >
                      {it.severity}
                    </span>
                    <span className="font-medium">{it.document}</span>（{it.location}）: {it.problem}
                    {it.correct && <span className="block text-[11px]">→ 正: {it.correct}</span>}
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={resetAll}
              className="w-full rounded-xl border border-[var(--color-border)] px-4 py-2 text-[12px] text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
            >
              最初からやり直す（下書きを破棄）
            </button>
          </div>
        )}

        {/* 進行中でも全部やり直せる */}
        {selectedId && phase !== "done" && (
          <button
            onClick={resetAll}
            className="w-full rounded-xl border border-[var(--color-border)] px-4 py-2 text-[12px] text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
          >
            最初からやり直す（下書きを破棄）
          </button>
        )}
      </div>

      {/* 右（本体）: プレビュー常設。左の書類リストをクリックすると、ここに表示される */}
      <div className="flex flex-1 overflow-hidden">
        {previewDoc ? (
          <FilePreview
            docxBase64={previewDoc.base64}
            fileName={previewDoc.fileName}
            onClose={() => setPreviewDoc(null)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[13px] text-[var(--color-fg-muted)]">
            {phase === "done" ? "左の書類名をクリックするとここにプレビューされます" : ""}
          </div>
        )}
      </div>

      {/* 木の可視化（全画面） */}
      {treeViewId && <JireiTreeView jireiId={treeViewId} onClose={() => setTreeViewId(null)} />}
    </div>
  );
}
