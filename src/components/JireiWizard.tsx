"use client";

// 会話型ウィザード（申請タブの質問フェーズ）— 一問一答のチャットボット形式。
//
// 設計（UX議論で確定）:
//   - 判断・確認 = 選択式ボタン（木の選択肢がそのまま枝。解釈ゼロ・AIゼロ・決定論）
//   - 値の入力 = 入力欄。同じ分岐に属する連続した値（書面決議の日付4つ等）は1ターンにまとめる
//   - プレフィルは choice には自動適用しない（おすすめ注記のみ。確定は人のクリック = 提案止まり）
//   - 答えた内容は上にログとして積まれ、クリックで直せる（波状の組み替えはエンジンが処理）
//   - 台本（何を聞くか・いつ聞くか・生成してよいか）は木。この画面は見せ方だけ
// v1.5 で「聞き手」（自由文の解釈・まとめ答え・脱線対応）をこの上に足す予定。

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";

export interface WizardQuestion {
  id: string;
  label: string;
  kind?: string;
  choices?: string[];
  when?: unknown;
}

interface Turn {
  key: string;
  kind: "choice" | "inputs";
  qs: WizardQuestion[];
}

// 連続する値質問（同じ分岐条件）を1ターンにまとめる。判断（choice）は常に単独ターン。
function buildTurns(questions: WizardQuestion[]): Turn[] {
  const turns: Turn[] = [];
  for (const q of questions) {
    if (q.kind === "choice" && (q.choices?.length || 0) > 0) {
      turns.push({ key: q.id, kind: "choice", qs: [q] });
      continue;
    }
    const prev = turns[turns.length - 1];
    const whenKey = JSON.stringify(q.when ?? null);
    if (
      prev &&
      prev.kind === "inputs" &&
      prev.qs.length < 5 &&
      JSON.stringify(prev.qs[0].when ?? null) === whenKey
    ) {
      prev.qs.push(q);
      prev.key = prev.qs.map((x) => x.id).join("+");
    } else {
      turns.push({ key: q.id, kind: "inputs", qs: [q] });
    }
  }
  return turns;
}

export interface WizardSourceStatus {
  label: string;
  optional: boolean;
  kind: "found" | "dropped" | "missing";
  name: string | null;
}

export default function JireiWizard({
  jireiName,
  stage,
  questions,
  answers,
  onAnswer,
  prefillAnswers,
  prefillSources,
  extractSources,
  autoFilled,
  evidenceByLabel,
  sourceMeta,
  guards,
  loading,
  onGenerate,
  onSwitchView,
  sourceStatus = [],
  sourcesReady = false,
  inboxFiles = [],
  onAddSources,
  onConfirmSources,
}: {
  jireiName: string;
  stage: "sources" | "questions";
  questions: WizardQuestion[];
  answers: Record<string, string>;
  onAnswer: (patch: Record<string, string>, reevaluate: boolean) => void;
  prefillAnswers: Record<string, string>;
  prefillSources: Record<string, string>;
  extractSources: Record<string, string>;
  autoFilled: Record<string, string>;
  evidenceByLabel: Record<string, string>;
  sourceMeta: { files: string[]; cached: boolean } | null;
  guards: string[];
  loading: boolean;
  onGenerate: () => void;
  onSwitchView: () => void;
  sourceStatus?: WizardSourceStatus[];
  sourcesReady?: boolean;
  inboxFiles?: { name: string; kindLabel?: string }[];
  onAddSources?: (files: FileList | File[]) => void;
  onConfirmSources?: () => void;
}) {
  const [editingTurn, setEditingTurn] = useState<string | null>(null);
  // 値ターンの下書き（入力途中の値。次へ で answers に反映）
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dragOver, setDragOver] = useState(false);
  const currentRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const turns = useMemo(() => buildTurns(questions), [questions]);
  const answered = (t: Turn) => t.qs.every((q) => (answers[q.id] || "").trim() !== "");
  const currentIdx = turns.findIndex((t) => !answered(t));
  const allDone = currentIdx === -1 && turns.length > 0;

  // 現在ターンが変わったらスクロール
  const currentKey = currentIdx >= 0 ? turns[currentIdx].key : "done";
  useEffect(() => {
    const t = setTimeout(() => currentRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
    return () => clearTimeout(t);
  }, [currentKey]);

  const inputFor = (q: WizardQuestion, value: string, set: (v: string) => void) =>
    q.kind === "text" ? (
      <textarea
        value={value}
        onChange={(e) => set(e.target.value)}
        rows={3}
        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[13px] focus:outline-none focus:border-[var(--color-accent)]"
      />
    ) : (
      <input
        type="text"
        value={value}
        onChange={(e) => set(e.target.value)}
        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[13px] focus:outline-none focus:border-[var(--color-accent)]"
      />
    );

  // ---- 回答済みターン（ログ）----
  // ※ コンポーネント（<X/>）ではなく関数呼び出しで描画する。レンダーごとに新しい
  //   コンポーネント型を作ると React が毎回再マウントし、入力のフォーカスが1文字ごとに飛ぶ。
  const renderAnsweredTurn = (t: Turn) => {
    const open = editingTurn === t.key;
    return (
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2.5">
        {t.qs.map((q) => (
          <div key={q.id} className="flex items-baseline gap-2 py-0.5 text-[12.5px]">
            <span className="min-w-0 shrink-0 max-w-[45%] truncate text-[var(--color-fg-muted)]" title={q.label}>
              {q.label.split("？")[0]}
            </span>
            <span className="min-w-0 flex-1 break-words font-medium text-[var(--color-fg)]">
              {(answers[q.id] || "").split("\n")[0]}
              {(answers[q.id] || "").includes("\n") && "…"}
            </span>
            {extractSources[q.id] && (
              <span className="shrink-0 rounded bg-[var(--color-accent-soft)] px-1.5 text-[10px] text-[var(--color-accent-fg)]" title={`資料「${extractSources[q.id]}」から読み取り`}>
                資料から
              </span>
            )}
          </div>
        ))}
        {!open ? (
          <button
            onClick={() => {
              setEditingTurn(t.key);
              const d: Record<string, string> = {};
              t.qs.forEach((q) => (d[q.id] = answers[q.id] || ""));
              setDraft(d);
            }}
            className="mt-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-accent-fg)] hover:underline"
          >
            直す
          </button>
        ) : (
          <div className="mt-2 space-y-2 border-t border-[var(--color-border)] pt-2">
            {t.kind === "choice" ? (
              (t.qs[0].choices || []).map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setEditingTurn(null);
                    onAnswer({ [t.qs[0].id]: c }, true);
                  }}
                  className={`flex w-full items-center gap-2 rounded-xl border p-2.5 text-left text-[12.5px] ${
                    answers[t.qs[0].id] === c
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium"
                      : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
                  }`}
                >
                  {c}
                </button>
              ))
            ) : (
              <>
                {t.qs.map((q) => (
                  <div key={q.id}>
                    <label className="mb-1 block text-[12px]">{q.label}</label>
                    {inputFor(q, draft[q.id] || "", (v) => setDraft((d) => ({ ...d, [q.id]: v })))}
                  </div>
                ))}
                <button
                  onClick={() => {
                    setEditingTurn(null);
                    onAnswer(draft, true);
                  }}
                  className="rounded-xl bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-white"
                >
                  更新
                </button>
              </>
            )}
            <button
              onClick={() => setEditingTurn(null)}
              className="ml-2 text-[11px] text-[var(--color-fg-muted)] hover:underline"
            >
              閉じる
            </button>
          </div>
        )}
      </div>
    );
  };

  // ---- 現在のターン（同じく関数呼び出しで描画） ----
  const renderCurrentTurn = (t: Turn) => {
    if (t.kind === "choice") {
      const q = t.qs[0];
      const hint = prefillAnswers[q.id];
      return (
        <div className="rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-panel)] p-4 space-y-2">
          <p className="text-[13.5px] font-medium leading-relaxed text-[var(--color-fg)]">{q.label}</p>
          {hint && (
            <p className="rounded-lg border-l-2 border-[var(--color-accent)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12px] text-[var(--color-fg-muted)]">
              資料には「{hint}」とあります{prefillSources[q.id] ? `（出典: ${prefillSources[q.id]}）` : ""} — おすすめです。クリックで確定してください
            </p>
          )}
          <div className="space-y-1.5">
            {(q.choices || []).map((c) => (
              <button
                key={c}
                onClick={() => onAnswer({ [q.id]: c }, true)}
                disabled={loading}
                className={`flex w-full items-start gap-2 rounded-xl border p-3 text-left text-[13px] transition-colors disabled:opacity-50 ${
                  hint === c
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] hover:brightness-95"
                    : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent)]"
                }`}
              >
                <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-[var(--color-border)]" />
                <span className="min-w-0">
                  {c}
                  {hint === c && <span className="ml-2 text-[10.5px] text-[var(--color-accent-fg)]">おすすめ</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      );
    }
    // 値の入力（グループで1ターン）
    const ready = t.qs.every((q) => (draft[q.id] ?? answers[q.id] ?? "").trim() !== "");
    return (
      <div className="rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-panel)] p-4 space-y-3">
        {t.qs.length > 1 && (
          <p className="text-[13.5px] font-medium text-[var(--color-fg)]">次の{t.qs.length}つを教えてください</p>
        )}
        {t.qs.map((q) => (
          <div key={q.id}>
            <label className="mb-1 block text-[12.5px] font-medium text-[var(--color-fg)]">{q.label}</label>
            {inputFor(q, draft[q.id] ?? answers[q.id] ?? "", (v) => setDraft((d) => ({ ...d, [q.id]: v })))}
          </div>
        ))}
        <button
          onClick={() => {
            const patch: Record<string, string> = {};
            t.qs.forEach((q) => (patch[q.id] = (draft[q.id] ?? answers[q.id] ?? "").trim()));
            onAnswer(patch, true);
          }}
          disabled={!ready || loading}
          className="rounded-xl bg-[var(--color-accent)] px-5 py-2 text-[13px] font-medium text-white disabled:opacity-40"
        >
          次へ
        </button>
      </div>
    );
  };

  // ============ 段2: 必要な資料（会話の最初のターン。最初に「何が要るか」を言う） ============
  if (stage === "sources") {
    return (
      <div className="h-full w-full overflow-y-auto">
        <div className="mx-auto max-w-[640px] px-6 py-8 space-y-3">
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
            <p className="text-[13.5px] font-semibold text-[var(--color-fg)]">
              {jireiName}には、次の資料が必要です
            </p>
            <p className="mt-0.5 text-[12px] text-[var(--color-fg-muted)]">
              揃っているものは自動で見つけました。不足分は届いたときに追加すれば大丈夫です（この画面は閉じても消えません）
            </p>
          </div>

          <div ref={currentRef} className="rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-panel)] p-4 space-y-3">
            <div className="space-y-1.5">
              {sourceStatus.map((s) => (
                <div
                  key={s.label}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[12.5px] ${
                    s.kind === "missing"
                      ? "border-amber-300 bg-amber-50 text-amber-900"
                      : "border-green-200 bg-green-50 text-green-900"
                  }`}
                >
                  <Icon name={s.kind === "missing" ? "CircleAlert" : "CircleCheck"} size={14} className="shrink-0" />
                  <span className="font-medium">{s.label}</span>
                  <span className="ml-auto min-w-0 truncate text-right text-[11px] opacity-80">
                    {s.kind === "found" && `${s.name}（フォルダから自動発見）`}
                    {s.kind === "dropped" && `${s.name}`}
                    {s.kind === "missing" && (s.optional ? "任意（無くても進めます）" : "不足 — 下に追加してください")}
                  </span>
                </div>
              ))}
            </div>

            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                onAddSources?.(e.dataTransfer.files);
              }}
              className={`cursor-pointer rounded-xl border border-dashed p-4 text-center text-[12.5px] transition-colors ${
                dragOver
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                  : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-accent)]"
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <Icon name="FileUp" size={13} />
                届いた資料をここに追加（クリックで選択も可。ファイル名はそのままでOK — 中身で判定します）
              </span>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (!e.target.files) return;
                  const files = Array.from(e.target.files);
                  e.target.value = "";
                  onAddSources?.(files);
                }}
              />
            </div>

            {/* 受け取った資料（入れたのに無視された、を作らない） */}
            {inboxFiles.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-[var(--color-fg-muted)]">受け取った資料（{inboxFiles.length}点）</p>
                {inboxFiles.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-[11.5px]">
                    <Icon name="FileText" size={11} className="shrink-0 text-[var(--color-fg-muted)]" />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    {f.kindLabel && (
                      <span className="shrink-0 rounded bg-[var(--color-hover)] px-1.5 text-[10px] text-[var(--color-fg-muted)]">
                        {f.kindLabel}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => onConfirmSources?.()}
              disabled={!sourcesReady || loading}
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-[13px] font-medium text-white disabled:opacity-40"
            >
              {loading ? "資料を確認しています..." : "この資料で読み取って、聞き取りを始める"}
            </button>
          </div>

          <p className="pt-2 text-center">
            <button onClick={onSwitchView} className="text-[11.5px] text-[var(--color-fg-muted)] hover:underline">
              一覧形式で表示する
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto max-w-[640px] px-6 py-8 space-y-3">
        {/* 導入: 事由と読み取りサマリ */}
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
          <p className="text-[13.5px] font-semibold text-[var(--color-fg)]">{jireiName}の聞き取りを始めます</p>
          <p className="mt-0.5 text-[12px] text-[var(--color-fg-muted)]">
            資料から読み取れたものは埋めてあります。判断と、資料に無かった値だけお聞きします。
          </p>
          {Object.keys(autoFilled).length > 0 && (
            <details className="group mt-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-green-900">
                <Icon name="ChevronRight" size={11} className="transition-transform group-open:rotate-90" />
                <Icon name="CheckCircle2" size={12} />
                資料から読み取り済み（{Object.keys(autoFilled).length}件）
                {sourceMeta && (
                  <span className="ml-1 font-normal text-green-800/70">
                    {sourceMeta.cached ? "前回の読み取りを再利用" : "いま読み取りました"}
                  </span>
                )}
              </summary>
              <table className="mt-1.5 w-full text-[11.5px]">
                <tbody>
                  {Object.entries(autoFilled).map(([label, value]) => (
                    <tr key={label} className="border-t border-green-200/60">
                      <td className="w-[130px] py-1 pr-2 align-top text-green-800/80">{label}</td>
                      <td className="whitespace-pre-wrap break-words py-1 text-green-950">
                        {value}
                        {evidenceByLabel[label] && (
                          <span className="mt-0.5 block text-[10.5px] text-green-800/70">根拠: {evidenceByLabel[label]}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>

        {/* 回答済みのログ */}
        {turns.filter(answered).map((t) => (
          <div key={t.key}>{renderAnsweredTurn(t)}</div>
        ))}

        {/* ガード（いま有効な注意書き） */}
        {guards.length > 0 && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-2.5 space-y-1">
            {guards.map((g, i) => (
              <p key={i} className="flex items-start gap-2 text-[12px] text-amber-900">
                <Icon name="TriangleAlert" size={13} className="mt-0.5 shrink-0" />
                {g}
              </p>
            ))}
          </div>
        )}

        {/* 現在のターン or 生成 */}
        {currentIdx >= 0 && (
          <div ref={currentRef}>
            {renderCurrentTurn(turns[currentIdx])}
            {loading && (
              <p className="mt-2 flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
                <Icon name="Loader2" size={13} className="animate-spin" />
                次の質問を組み立てています...
              </p>
            )}
          </div>
        )}
        {allDone && (
          <div ref={currentRef} className="rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-panel)] p-4 space-y-2">
            <p className="text-[13.5px] font-medium text-[var(--color-fg)]">必要なことは揃いました</p>
            <p className="text-[12px] text-[var(--color-fg-muted)]">
              上のログはクリックで直せます。よければ書類を生成します（決定論・AIは書きません）。
            </p>
            <button
              onClick={onGenerate}
              disabled={loading}
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-[13.5px] font-medium text-white disabled:opacity-40"
            >
              {loading ? "生成しています..." : "書類を生成する"}
            </button>
          </div>
        )}

        {/* フッター: 一覧モードへ */}
        <p className="pt-2 text-center">
          <button onClick={onSwitchView} className="text-[11.5px] text-[var(--color-fg-muted)] hover:underline">
            一覧形式で入力する（慣れている方向け）
          </button>
        </p>
      </div>
    </div>
  );
}
