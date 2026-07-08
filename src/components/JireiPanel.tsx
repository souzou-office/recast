"use client";

// 事由駆動型 申請書生成パネル（新タブ「申請」）。
//
// 体験: [目的変更] 等の事由ボタンを押す → 資料から読めた値が表示され、
//        読めなかった分だけ質問が出る → 答える → 書類一式が生成される。
// ユーザーはテンプレを選ばない・フォームに転記しない。「何が起きたか」を選ぶだけ。

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

export default function JireiPanel({ company }: { company: Company | null }) {
  const [jireiList, setJireiList] = useState<JireiSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "sources" | "questions" | "done">("idle");
  const [autoFilled, setAutoFilled] = useState<Record<string, string>>({});
  // 原本直読みモード: 必要書類の受付状況 / ドロップ済み原本 / 出典 / 判断の根拠（定款の条文引用）
  const [sourceStatus, setSourceStatus] = useState<
    { label: string; optional: boolean; kind: "found" | "dropped" | "missing"; name: string | null }[]
  >([]);
  const [sourcesReady, setSourcesReady] = useState(false);
  const [sourcesConfirmed, setSourcesConfirmed] = useState(false);
  const [sourceFiles, setSourceFiles] = useState<{ name: string; base64: string }[]>([]);
  const [sourceMeta, setSourceMeta] = useState<{ files: string[]; cached: boolean } | null>(null);
  const [evidenceByLabel, setEvidenceByLabel] = useState<Record<string, string>>({});
  const [questions, setQuestions] = useState<JireiQuestionUI[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [documents, setDocuments] = useState<ProducedDocUI[]>([]);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [previewDoc, setPreviewDoc] = useState<ProducedDocUI | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 資料ドロップ → 質問の答えを AI 抽出（結果は人が確認してから生成）
  const [extracting, setExtracting] = useState(false);
  const [extractNote, setExtractNote] = useState<string | null>(null);
  const [extractSources, setExtractSources] = useState<Record<string, string>>({});
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 事由コンパイラ（テンプレフォルダ → AI が木を生成。AI が働くのはこの登録時1回だけ）
  const [compileOpen, setCompileOpen] = useState(false);
  const [compileFolders, setCompileFolders] = useState<{ name: string; fileCount: number }[]>([]);
  const [compileFolder, setCompileFolder] = useState("");
  const [compileInstruction, setCompileInstruction] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [compileResult, setCompileResult] = useState<{ name: string; warnings: string[] } | null>(null);
  // 木の可視化（ロジックツリー表示）
  const [treeViewId, setTreeViewId] = useState<string | null>(null);
  // AI チェック（原本突合せ）
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    issues: { document: string; location: string; problem: string; correct?: string; severity: string }[];
    sources: string[];
  } | null>(null);

  const runVerify = async () => {
    if (!selectedId || documents.length === 0) return;
    setVerifying(true);
    setVerifyResult(null);
    setError(null);
    try {
      const res = await fetch("/api/jirei/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: company?.id,
          jireiId: selectedId,
          documents: documents.map((d) => ({ fileName: d.fileName, base64: d.base64 })),
          sources: sourceFiles,
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

  const openCompile = async () => {
    setCompileOpen(true);
    setCompileResult(null);
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
      // 一覧を再取得（新しい事由ボタンが増える）
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

  const reset = () => {
    setSelectedId(null);
    setPhase("idle");
    setAutoFilled({});
    setQuestions([]);
    setAnswers({});
    setDocuments([]);
    setUnresolved([]);
    setPreviewDoc(null);
    setError(null);
    setExtracting(false);
    setExtractNote(null);
    setExtractSources({});
    setDragOver(false);
    setSourceStatus([]);
    setSourcesReady(false);
    setSourcesConfirmed(false);
    setSourceFiles([]);
    setSourceMeta(null);
    setEvidenceByLabel({});
    setVerifying(false);
    setVerifyResult(null);
  };

  // ドロップ/選択されたファイルをクライアントで読み (base64)、質問の答えを抽出してプレフィル。
  // 既にユーザーが入力済みの欄は上書きしない。
  const handleFilesForExtract = useCallback(
    async (fileList: FileList | File[]) => {
      if (!selectedId) return;
      const files = Array.from(fileList);
      if (files.length === 0) return;
      setExtracting(true);
      setExtractNote(null);
      setError(null);
      try {
        const payload = await Promise.all(
          files.map(
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
        const res = await fetch("/api/jirei/extract-answers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jireiId: selectedId, files: payload }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "抽出に失敗しました");
          return;
        }
        const extracted: Record<string, string> = data.answers || {};
        const filled: string[] = [];
        const kept: string[] = [];
        const next = { ...answers };
        for (const q of questions) {
          const v = extracted[q.id];
          if (!v) continue;
          if ((answers[q.id] || "").trim()) {
            kept.push(q.label);
          } else {
            next[q.id] = v;
            filled.push(q.label);
          }
        }
        setAnswers(next);
        setExtractSources((prev) => ({ ...prev, ...(data.sources || {}) }));
        const parts: string[] = [];
        if (filled.length > 0) parts.push(`${filled.length}件を資料から読み取りました。内容を確認してください`);
        if (kept.length > 0) parts.push(`入力済みの${kept.length}件はそのままにしました`);
        const notFound: string[] = data.notFound || [];
        if (filled.length === 0 && kept.length === 0 && notFound.length > 0) {
          parts.push("この資料からは答えを読み取れませんでした");
        }
        setExtractNote(parts.join("。") || null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "抽出に失敗しました");
      } finally {
        setExtracting(false);
      }
    },
    [selectedId, questions, answers]
  );

  const callApi = useCallback(
    async (
      jireiId: string,
      currentAnswers: Record<string, string>,
      extraSources?: { name: string; base64: string }[],
      confirmedOverride?: boolean
    ) => {
      setLoading(true);
      setError(null);
      const sources = extraSources ?? sourceFiles;
      const confirmed = confirmedOverride ?? sourcesConfirmed;
      try {
        const res = await fetch("/api/jirei", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: company?.id,
            jireiId,
            answers: currentAnswers,
            sources,
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
        if (data.sourceMeta) setSourceMeta(data.sourceMeta);
        if (data.phase === "sources") {
          // 必要書類の受付（実務の順番: まず資料を揃えて確認してから進む）
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
    [company, sourceFiles, sourcesConfirmed]
  );

  const handleSelectJirei = (id: string) => {
    reset();
    setSelectedId(id);
    callApi(id, {});
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

  // 会社レス運用: 会社を選ばなくても、必要書類の受付に原本をドロップすれば作成できる

  const selectedJirei = jireiList.find((j) => j.id === selectedId);

  return (
    <div className="flex h-full overflow-hidden">
      {/* 左: フロー */}
      <div className="w-[440px] shrink-0 overflow-y-auto border-r border-[var(--color-border)] p-5 space-y-4">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">申請</h2>
          <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
            何が起きたかを選ぶと、必要書類が自動で組み上がります
          </p>
          {!company && (
            <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
              会社未選択でも使えます（必要書類の受付に原本をドロップしてください）
            </p>
          )}
        </div>

        {/* 事由ボタン */}
        <div className="grid grid-cols-2 gap-2">
          {jireiList.map((j) => (
            <div
              key={j.id}
              className={`relative rounded-2xl border transition-colors ${
                selectedId === j.id
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                  : "border-[var(--color-border)] bg-[var(--color-panel)] hover:border-[var(--color-accent)]"
              }`}
            >
              <button
                onClick={() => handleSelectJirei(j.id)}
                disabled={loading}
                className="w-full p-3 text-left"
              >
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

        {/* 事由コンパイラ: テンプレフォルダ → AI が木を生成（登録時1回だけ AI が働く） */}
        {!compileOpen ? (
          <button
            onClick={openCompile}
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
              placeholder="追加の指示があれば（例: この書類は対象者ごとに1枚 / この日付は毎回聞いて）"
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
                <p>「{compileResult.name}」を追加しました。上のボタンから試せます。</p>
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
        )}

        {loading && (
          <div className="flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
            <Icon name="Loader2" size={13} className="animate-spin" />
            処理中...
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-[12px] text-red-700">
            {error}
          </div>
        )}

        {/* 必要書類の受付（原本直読みモード）— 実務どおり、まず資料を揃えてから進む */}
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
                  <Icon
                    name={s.kind === "missing" ? "CircleAlert" : "CircleCheck"}
                    size={14}
                    className="shrink-0"
                  />
                  <span className="font-medium">{s.label}</span>
                  <span className="ml-auto text-right text-[11px] opacity-80">
                    {s.kind === "found" && `${s.name}（フォルダから自動）`}
                    {s.kind === "dropped" && `${s.name}（ドロップ）`}
                    {s.kind === "missing" && (s.optional ? "任意（無くても進めます）" : "見つかりません")}
                  </span>
                </div>
              ))}
            </div>
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={async (e) => {
                e.preventDefault();
                setDragOver(false);
                const arr = await readFilesAsBase64(e.dataTransfer.files);
                const merged = [...sourceFiles, ...arr];
                setSourceFiles(merged);
                if (selectedId) callApi(selectedId, answers, merged);
              }}
              className={`cursor-pointer rounded-xl border border-dashed p-3 text-center text-[12px] transition-colors ${
                dragOver
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                  : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-accent)]"
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <Icon name="FileUp" size={13} />
                取り寄せた最新の資料をドロップ（同じ種類の資料は差し替わります）
              </span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={async (e) => {
                  if (!e.target.files) return;
                  const arr = await readFilesAsBase64(e.target.files);
                  e.target.value = "";
                  const merged = [...sourceFiles, ...arr];
                  setSourceFiles(merged);
                  if (selectedId) callApi(selectedId, answers, merged);
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
                不足している資料をドロップするか、共通フォルダに入れてから事由を選び直してください
              </p>
            )}
          </div>
        )}

        {/* 資料から読めた値 */}
        {selectedId && (phase === "questions" || phase === "done") && Object.keys(autoFilled).length > 0 && (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg)]">
              <Icon name="CheckCircle2" size={13} className="text-green-600" />
              資料から読めた値（入力不要）
            </div>
            {sourceMeta && (
              <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
                出典: {sourceMeta.files.join("・")}
                {sourceMeta.cached ? "（前回と同じ原本のため読み取り結果を再利用）" : "（いま原本を読み取りました）"}
              </p>
            )}
            <table className="mt-2 w-full text-[12px]">
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
          </div>
        )}

        {/* 質問フォーム（資料で決まらなかった所だけ） */}
        {phase === "questions" && (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 space-y-3">
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg)]">
              <Icon name="MessageCircleQuestion" size={13} className="text-amber-600" />
              確認が必要な項目
            </div>
            {/* 資料ドロップ: 答えが書いてあるファイルから AI がプレフィル（人が確認して生成） */}
            <div
              onClick={() => !extracting && fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (!extracting) handleFilesForExtract(e.dataTransfer.files);
              }}
              className={`cursor-pointer rounded-xl border border-dashed p-3 text-center text-[12px] transition-colors ${
                dragOver
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
                  答えが書いてある資料をドロップ（クリックで選択）
                </span>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) handleFilesForExtract(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            {extractNote && (
              <p className="text-[11px] text-[var(--color-fg-muted)]">{extractNote}</p>
            )}
            {questions.map((q) => (
              <div key={q.id}>
                <label className="block text-[12px] text-[var(--color-fg)] mb-1">{q.label}</label>
                {q.kind === "choice" && q.choices ? (
                  <select
                    value={answers[q.id] || ""}
                    onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                    className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[13px] focus:outline-none focus:border-[var(--color-accent)]"
                  >
                    <option value="">選択してください</option>
                    {q.choices.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                ) : q.kind === "text" ? (
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
                )}
                {extractSources[q.id] && (answers[q.id] || "").trim() && (
                  <p className="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">
                    資料「{extractSources[q.id]}」から読み取り
                  </p>
                )}
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

        {/* 生成結果 */}
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
            {/* AI チェック（原本突合せ）。書き換えはしない、指摘だけ */}
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
              onClick={reset}
              className="w-full rounded-xl border border-[var(--color-border)] px-4 py-2 text-[12px] text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
            >
              最初からやり直す
            </button>
          </div>
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
