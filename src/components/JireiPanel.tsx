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
  const [phase, setPhase] = useState<"idle" | "questions" | "done">("idle");
  const [autoFilled, setAutoFilled] = useState<Record<string, string>>({});
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
    async (jireiId: string, currentAnswers: Record<string, string>) => {
      if (!company) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/jirei", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId: company.id, jireiId, answers: currentAnswers }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "エラーが発生しました");
          return;
        }
        setAutoFilled(data.autoFilled || {});
        if (data.phase === "questions") {
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
    [company]
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

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--color-fg-muted)]">
        サイドバーから会社を選択してください
      </div>
    );
  }

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
        </div>

        {/* 事由ボタン */}
        <div className="grid grid-cols-2 gap-2">
          {jireiList.map((j) => (
            <button
              key={j.id}
              onClick={() => handleSelectJirei(j.id)}
              disabled={loading}
              className={`rounded-2xl border p-3 text-left transition-colors ${
                selectedId === j.id
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                  : "border-[var(--color-border)] bg-[var(--color-panel)] hover:border-[var(--color-accent)]"
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon name="FileText" size={14} />
                <span className="text-[13px] font-medium">{j.name}</span>
              </div>
              {j.description && (
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-fg-muted)] line-clamp-2">
                  {j.description}
                </p>
              )}
            </button>
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

        {/* 資料から読めた値 */}
        {selectedId && (phase === "questions" || phase === "done") && Object.keys(autoFilled).length > 0 && (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg)]">
              <Icon name="CheckCircle2" size={13} className="text-green-600" />
              資料から読めた値（入力不要）
            </div>
            <table className="mt-2 w-full text-[12px]">
              <tbody>
                {Object.entries(autoFilled).map(([label, value]) => (
                  <tr key={label} className="border-t border-[var(--color-border)]">
                    <td className="py-1 pr-2 text-[var(--color-fg-muted)] whitespace-nowrap align-top w-[130px] break-words">
                      {label}
                    </td>
                    <td className="py-1 text-[var(--color-fg)] whitespace-pre-wrap break-words">
                      {value}
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
            <button
              onClick={reset}
              className="w-full rounded-xl border border-[var(--color-border)] px-4 py-2 text-[12px] text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
            >
              最初からやり直す
            </button>
          </div>
        )}
      </div>

      {/* 右: 余白（プレビューは全画面オーバーレイで開く） */}
      <div className="flex-1 overflow-hidden">
        <div className="flex h-full items-center justify-center text-[13px] text-[var(--color-fg-muted)]">
          {phase === "done" ? "書類名をクリックすると全画面でプレビューします" : ""}
        </div>
      </div>

      {/* 全画面プレビュー（Esc または × で閉じる） */}
      {previewDoc && (
        <div
          className="fixed inset-0 z-50 bg-black/50 p-4 md:p-8"
          onClick={() => setPreviewDoc(null)}
        >
          <div
            className="flex h-full w-full overflow-hidden rounded-2xl bg-[var(--color-panel)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <FilePreview
              docxBase64={previewDoc.base64}
              fileName={previewDoc.fileName}
              onClose={() => setPreviewDoc(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
