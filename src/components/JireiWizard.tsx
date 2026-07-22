"use client";

// 申請ウィザード — ★1ページ1質問のページ遷移型★（Typeform 式）。
//
// 設計（UX議論で確定）:
//   - 画面に出るのは「いまの質問」だけ。答えると次のページに切り替わる（上に積まない）
//   - 判断・確認 = 選択式ボタン（木の選択肢がそのまま枝。解釈ゼロ・AIゼロ・決定論）
//   - 値の入力 = 入力欄。同じ分岐に属する連続した値（書面決議の日付4つ等）は1ページにまとめる
//   - プレフィルは choice には自動適用しない（おすすめ注記のみ。確定は人のクリック = 提案止まり）
//   - 「← 戻る」で前の質問に戻って直せる（波状の組み替えはエンジンが処理）
//   - 台本（何を聞くか・いつ聞くか・生成してよいか）は木。この画面は見せ方だけ
// v1.5 で「聞き手」（自由文の解釈・まとめ答え・脱線対応）をこの上に足す予定。

import { useMemo, useRef, useState } from "react";
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

// 連続する値質問（同じ分岐条件）を1ページにまとめる。判断（choice）は常に単独ページ。
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
  derived = {},
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
  derived?: Record<string, { value: string; basis: string }>;
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
  // 値ページの下書き（入力途中の値。次へ で answers に反映）
  const [draft, setDraft] = useState<Record<string, string>>({});
  // 見ているページ。null = いま答えるべきページ（未回答の先頭）に追従
  const [viewIdx, setViewIdx] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 機械導出で埋まった質問（ユーザーが上書きしていないもの）= 聞かない。ページにも出さない。
  const isDerived = (id: string) => !!derived[id] && !(answers[id] || "").trim();
  const derivedQs = questions.filter((q) => isDerived(q.id));
  const turns = useMemo(
    () => buildTurns(questions.filter((q) => !isDerived(q.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [questions, derived, answers]
  );
  const isAnswered = (t: Turn) => t.qs.every((q) => (answers[q.id] || "").trim() !== "");
  const currentIdx = turns.findIndex((t) => !isAnswered(t));
  const allDone = currentIdx === -1 && turns.length > 0;
  const answeredCount = turns.filter(isAnswered).length;

  // 表示するページを決める（戻る中は過去ページ、通常は未回答の先頭 or 最終確認）
  const followIdx = allDone ? turns.length : currentIdx; // 「いまのページ」の位置（allDone なら最終確認）
  const effectiveIdx = viewIdx === null ? followIdx : Math.max(0, Math.min(viewIdx, turns.length));
  const showFinal = effectiveIdx >= turns.length && allDone;
  const turn = !showFinal && effectiveIdx >= 0 && effectiveIdx < turns.length ? turns[effectiveIdx] : null;
  const viewingPast = turn ? isAnswered(turn) : false;

  const goBack = () => setViewIdx(Math.max(0, effectiveIdx - 1));
  const goForward = () => {
    const next = effectiveIdx + 1;
    setViewIdx(next >= followIdx ? null : next);
  };

  const answerAndAdvance = (patch: Record<string, string>) => {
    setViewIdx(null); // 回答したら「いまのページ」に追従へ戻る（波状の組み替えに任せる）
    onAnswer(patch, true);
  };

  const inputFor = (q: WizardQuestion, value: string, set: (v: string) => void) =>
    q.kind === "text" ? (
      <textarea
        value={value}
        onChange={(e) => set(e.target.value)}
        rows={3}
        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-[13.5px] focus:outline-none focus:border-[var(--color-accent)]"
      />
    ) : (
      <input
        type="text"
        value={value}
        onChange={(e) => set(e.target.value)}
        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-[13.5px] focus:outline-none focus:border-[var(--color-accent)]"
      />
    );

  // ============ 受付ページ（必要な資料。最初に「何が要るか」を言う） ============
  if (stage === "sources") {
    return (
      <div>
        <div className="space-y-3">
          <div className="jirei-page-in rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-panel)] p-5 space-y-3">
            <div>
              <p className="text-[14.5px] font-semibold text-[var(--color-fg)]">
                {jireiName}には、次の資料が必要です
              </p>
              <p className="mt-0.5 text-[12px] text-[var(--color-fg-muted)]">
                揃っているものは自動で見つけました。不足分は届いたときに追加すれば大丈夫です（この画面は閉じても消えません）
              </p>
            </div>
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

          <p className="pt-1 text-center">
            <button onClick={onSwitchView} className="text-[11.5px] text-[var(--color-fg-muted)] hover:underline">
              一覧形式で表示する
            </button>
          </p>
        </div>
      </div>
    );
  }

  // ============ 質問ページ（1ページ1質問。答えると次のページへ遷移） ============
  return (
    <div>
      <div className="space-y-3">
        {/* 進行ヘッダー: 戻る / 進捗 / （戻り中）進む */}
        <div className="flex items-center gap-3 text-[12px] text-[var(--color-fg-muted)]">
          <button
            onClick={goBack}
            disabled={effectiveIdx <= 0}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2.5 py-1 hover:bg-[var(--color-hover)] disabled:opacity-30"
          >
            <Icon name="ChevronLeft" size={12} />
            戻る
          </button>
          <span>
            {answeredCount}問回答済み
            {turn && !viewingPast && `・${effectiveIdx + 1}問目`}
            {viewingPast && `・${effectiveIdx + 1}問目を見直し中`}
            {showFinal && "・最終確認"}
          </span>
          {viewingPast && (
            <button
              onClick={goForward}
              className="ml-auto inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2.5 py-1 hover:bg-[var(--color-hover)]"
            >
              変更せず進む
              <Icon name="ChevronRight" size={12} />
            </button>
          )}
        </div>

        {/* 資料から読み取り済み（1行の折りたたみ。邪魔しない） */}
        {Object.keys(autoFilled).length > 0 && (
          <details className="group rounded-xl border border-green-200 bg-green-50 px-3 py-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11.5px] font-medium text-green-900">
              <Icon name="ChevronRight" size={10} className="transition-transform group-open:rotate-90" />
              <Icon name="CheckCircle2" size={11} />
              資料から読み取り済み（{Object.keys(autoFilled).length}件）— これらは聞きません
              {sourceMeta && (
                <span className="ml-1 font-normal text-green-800/70">
                  {sourceMeta.cached ? "前回の読み取りを再利用" : ""}
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

        {/* こちらで埋めた値（機械導出。委任日・管轄など「客に聞くことじゃない」値） */}
        {derivedQs.length > 0 && (
          <details className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-accent-soft)] px-3 py-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11.5px] font-medium text-[var(--color-accent-fg)]">
              <Icon name="ChevronRight" size={10} className="transition-transform group-open:rotate-90" />
              <Icon name="Wand2" size={11} />
              こちらで埋めた値（{derivedQs.length}件）— 聞くまでもない値は自動で入れています
            </summary>
            <table className="mt-1.5 w-full text-[11.5px]">
              <tbody>
                {derivedQs.map((q) => (
                  <tr key={q.id} className="border-t border-[var(--color-border)]">
                    <td className="w-[150px] py-1 pr-2 align-top text-[var(--color-fg-muted)]">
                      {q.label.replace(/[（(].*$/, "").replace(/は？.*$/, "")}
                    </td>
                    <td className="whitespace-pre-wrap break-words py-1 text-[var(--color-fg)]">
                      {derived[q.id].value}
                      <span className="mt-0.5 block text-[10.5px] text-[var(--color-fg-muted)]">
                        根拠: {derived[q.id].basis} — 直す場合は一覧形式で
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}

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

        {/* ============ いまのページ（1問だけ） ============ */}
        {turn && turn.kind === "choice" && (
          <div key={turn.key} className="jirei-page-in rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-panel)] p-5 space-y-3">
            <p className="text-[15px] font-medium leading-relaxed text-[var(--color-fg)]">{turn.qs[0].label}</p>
            {prefillAnswers[turn.qs[0].id] && !(answers[turn.qs[0].id] || "").trim() && (
              <p className="rounded-lg border-l-2 border-[var(--color-accent)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12px] text-[var(--color-fg-muted)]">
                資料には「{prefillAnswers[turn.qs[0].id]}」とあります
                {prefillSources[turn.qs[0].id] ? `（出典: ${prefillSources[turn.qs[0].id]}）` : ""} — おすすめです
              </p>
            )}
            <div className="space-y-2">
              {(turn.qs[0].choices || []).map((c) => {
                const selected = answers[turn.qs[0].id] === c;
                const recommended = prefillAnswers[turn.qs[0].id] === c && !(answers[turn.qs[0].id] || "").trim();
                return (
                  <button
                    key={c}
                    onClick={() => answerAndAdvance({ [turn.qs[0].id]: c })}
                    disabled={loading}
                    className={`flex w-full items-start gap-2.5 rounded-xl border p-3.5 text-left text-[13.5px] transition-colors disabled:opacity-50 ${
                      selected
                        ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium"
                        : recommended
                          ? "border-[var(--color-accent)] bg-[var(--color-bg)] hover:bg-[var(--color-accent-soft)]"
                          : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent)]"
                    }`}
                  >
                    <span
                      className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 ${
                        selected ? "border-[var(--color-accent)] bg-[var(--color-accent)]" : "border-[var(--color-border)]"
                      }`}
                    />
                    <span className="min-w-0">
                      {c}
                      {recommended && <span className="ml-2 text-[11px] text-[var(--color-accent-fg)]">おすすめ</span>}
                      {selected && <span className="ml-2 text-[11px] text-[var(--color-accent-fg)]">選択中</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {turn && turn.kind === "inputs" && (
          <div key={turn.key} className="jirei-page-in rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-panel)] p-5 space-y-3">
            {turn.qs.length > 1 && (
              <p className="text-[15px] font-medium text-[var(--color-fg)]">次の{turn.qs.length}つを教えてください</p>
            )}
            {turn.qs.map((q) => (
              <div key={q.id}>
                <label className="mb-1 block text-[13px] font-medium text-[var(--color-fg)]">{q.label}</label>
                {inputFor(q, draft[q.id] ?? answers[q.id] ?? "", (v) => setDraft((d) => ({ ...d, [q.id]: v })))}
                {extractSources[q.id] && (answers[q.id] || "").trim() && (
                  <p className="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">資料「{extractSources[q.id]}」から読み取り済み — 違っていたら直してください</p>
                )}
              </div>
            ))}
            <button
              onClick={() => {
                const patch: Record<string, string> = {};
                turn.qs.forEach((q) => (patch[q.id] = (draft[q.id] ?? answers[q.id] ?? "").trim()));
                answerAndAdvance(patch);
              }}
              disabled={!turn.qs.every((q) => (draft[q.id] ?? answers[q.id] ?? "").trim() !== "") || loading}
              className="rounded-xl bg-[var(--color-accent)] px-6 py-2.5 text-[13.5px] font-medium text-white disabled:opacity-40"
            >
              {viewingPast ? "更新して進む" : "次へ"}
            </button>
          </div>
        )}

        {/* ============ 最終ページ: 生成 ============ */}
        {showFinal && (
          <div className="jirei-page-in rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-panel)] p-5 space-y-2">
            <p className="text-[15px] font-medium text-[var(--color-fg)]">必要なことは揃いました</p>
            <p className="text-[12px] text-[var(--color-fg-muted)]">
              「戻る」で回答を見直せます。よければ書類を生成します（決定論・AIは書きません）。
            </p>
            <button
              onClick={onGenerate}
              disabled={loading}
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 text-[14px] font-medium text-white disabled:opacity-40"
            >
              {loading ? "生成しています..." : "書類を生成する"}
            </button>
          </div>
        )}

        {loading && !showFinal && (
          <p className="flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
            <Icon name="Loader2" size={13} className="animate-spin" />
            次のページを組み立てています...
          </p>
        )}

        <p className="pt-1 text-center">
          <button onClick={onSwitchView} className="text-[11.5px] text-[var(--color-fg-muted)] hover:underline">
            一覧形式で入力する（慣れている方向け）
          </button>
        </p>
      </div>
    </div>
  );
}
