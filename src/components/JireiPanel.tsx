"use client";

// 事由駆動型 申請書生成パネル（新タブ「申請」）。
//
// 体験: [目的変更] 等の事由ボタンを押す → 資料から読めた値が表示され、
//        読めなかった分だけ質問が出る → 答える → 書類一式が生成される。
// ユーザーはテンプレを選ばない・フォームに転記しない。「何が起きたか」を選ぶだけ。

import { useState, useEffect, useCallback } from "react";
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
  };

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
            {questions.map((q) => (
              <div key={q.id}>
                <label className="block text-[12px] text-[var(--color-fg)] mb-1">{q.label}</label>
                {q.kind === "text" ? (
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

      {/* 右: プレビュー */}
      <div className="flex-1 overflow-hidden">
        {previewDoc ? (
          <FilePreview
            docxBase64={previewDoc.base64}
            fileName={previewDoc.fileName}
            onClose={() => setPreviewDoc(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-[var(--color-fg-muted)]">
            {phase === "done" ? "書類を選ぶとプレビューが表示されます" : ""}
          </div>
        )}
      </div>
    </div>
  );
}
