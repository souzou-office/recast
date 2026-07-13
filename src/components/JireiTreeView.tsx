"use client";

// 事由の「木」のレビュー画面 — レーン型レイアウト。
//
//   [聞くこと] | [分岐の選択肢A] [選択肢B] | [共通（どの分岐でも）]
//                 └ 書類カード（穴は中の一覧。出所ごとにグループ化・件数付き）
//
// 旧: 穴1個=1ノードの横方向ツリー → 箱と罫線が横に散らばって読めなかった。
// 新: 書類は縦に積み、穴は書類カード内で出所グループにまとめる。
//     「出所なし（赤）＝レビュー対象」だけ常時展開して炙り出す。
//
// 出所の色: 緑 = 資料から自動 / 橙 = 質問で聞く / 青 = 株主ごと等の一覧 /
//           灰 = 固定値 / 赤 = 出所なし（レビューが必要）

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";

interface TreeNode {
  label: string;
  kind: "jirei" | "branch" | "choice" | "doc" | "hole";
  source?: "fact" | "answer" | "const" | "list" | "unknown";
  detail?: string;
  badge?: string;
  cond?: string; // 出る条件（主分岐レーンで表しきれない分。日本語）
  children?: TreeNode[];
}

interface QuestionOverview {
  label: string;
  kind: string;
  when?: string;
}

const SOURCE_ORDER = ["unknown", "answer", "fact", "list", "const"] as const;
type SourceKind = (typeof SOURCE_ORDER)[number];

const SOURCE_LABEL: Record<SourceKind, string> = {
  unknown: "出所なし",
  answer: "質問で聞く",
  fact: "資料から自動",
  list: "一覧から展開",
  const: "固定値",
};

const DOT: Record<SourceKind, string> = {
  unknown: "bg-red-500",
  answer: "bg-amber-500",
  fact: "bg-green-500",
  list: "bg-sky-500",
  const: "bg-gray-400",
};

const GROUP_TEXT: Record<SourceKind, string> = {
  unknown: "text-red-800",
  answer: "text-amber-800",
  fact: "text-green-800",
  list: "text-sky-800",
  const: "text-[var(--color-fg-muted)]",
};

function groupHoles(holes: TreeNode[]): { source: SourceKind; items: TreeNode[] }[] {
  return SOURCE_ORDER.map((s) => ({
    source: s,
    items: holes.filter((h) => (h.source || "unknown") === s),
  })).filter((g) => g.items.length > 0);
}

function HoleRow({ hole }: { hole: TreeNode }) {
  return (
    <div className="flex items-baseline gap-1.5 py-0.5 text-[11.5px] leading-snug">
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 self-start rounded-full ${DOT[(hole.source || "unknown") as SourceKind]}`} />
      <span className="shrink-0 font-medium text-[var(--color-fg)]">{hole.label}</span>
      {hole.detail && <span className="min-w-0 text-[var(--color-fg-muted)]">← {hole.detail}</span>}
    </div>
  );
}

function DocCard({ doc, expandAll }: { doc: TreeNode; expandAll: boolean }) {
  const groups = groupHoles(doc.children || []);
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-3">
      <div className="flex items-start gap-1.5 text-[12.5px] font-semibold text-[var(--color-fg)]">
        <Icon name={doc.label.endsWith(".xlsx") ? "Sheet" : "FileText"} size={13} className="mt-0.5 shrink-0 text-[var(--color-accent-fg)]" />
        <span className="min-w-0 break-all">{doc.label.replace(/\.(docx|xlsx)$/i, "")}</span>
      </div>
      {doc.badge && (
        <span className="mt-1 inline-block rounded-full bg-[var(--color-accent)] px-2 py-0.5 text-[10px] text-white">
          {doc.badge}
        </span>
      )}
      {doc.cond && (
        <p className="mt-1 rounded-md border border-purple-200 bg-purple-50 px-2 py-1 text-[10.5px] leading-snug text-purple-900">
          出る条件: {doc.cond}
        </p>
      )}
      {groups.length === 0 && (
        <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">穴なし（固定文のみ or テンプレ未配置）</p>
      )}
      <div className="mt-1.5 space-y-1">
        {groups.map((g) =>
          g.source === "unknown" ? (
            // 出所なし = レビュー対象。折りたたまず常時見せる
            <div key={g.source} className="rounded-lg border border-red-300 bg-red-50 px-2 py-1.5">
              <p className="flex items-center gap-1 text-[11px] font-semibold text-red-800">
                <Icon name="TriangleAlert" size={11} />
                出所なし {g.items.length}件 — レビュー対象
              </p>
              {g.items.map((h, i) => (
                <HoleRow key={i} hole={h} />
              ))}
            </div>
          ) : (
            <details key={`${g.source}-${expandAll}`} open={expandAll || g.source === "answer"} className="group rounded-lg border border-[var(--color-border)] px-2 py-1">
              <summary className={`flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold ${GROUP_TEXT[g.source]}`}>
                <Icon name="ChevronRight" size={10} className="shrink-0 transition-transform group-open:rotate-90" />
                <span className={`h-2 w-2 rounded-full ${DOT[g.source]}`} />
                {SOURCE_LABEL[g.source]} {g.items.length}件
              </summary>
              <div className="mt-0.5 border-t border-[var(--color-border)] pt-1">
                {g.items.map((h, i) => (
                  <HoleRow key={i} hole={h} />
                ))}
              </div>
            </details>
          )
        )}
      </div>
    </div>
  );
}

const Q_KIND: Record<string, { label: string; cls: string }> = {
  choice: { label: "判断", cls: "bg-purple-100 text-purple-800 border-purple-300" },
  date: { label: "日付", cls: "bg-amber-50 text-amber-800 border-amber-300" },
  text: { label: "入力", cls: "bg-[var(--color-hover)] text-[var(--color-fg-muted)] border-[var(--color-border)]" },
};

export default function JireiTreeView({ jireiId, onClose }: { jireiId: string; onClose: () => void }) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [questions, setQuestions] = useState<QuestionOverview[]>([]);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expandAll, setExpandAll] = useState(false);

  useEffect(() => {
    fetch(`/api/jirei/tree?id=${encodeURIComponent(jireiId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.tree) {
          setTree(d.tree);
          setQuestions(d.questions || []);
          setDescription(d.description || "");
        } else setError(d.error || "木を読み込めませんでした");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "通信エラー"));
  }, [jireiId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 木 → レーン（分岐の選択肢ごと + 共通）
  const lanes = useMemo(() => {
    if (!tree) return [];
    const out: { title: string; sub?: string; kind: "choice" | "common" | "flat"; docs: TreeNode[] }[] = [];
    const kids = tree.children || [];
    const branch = kids.find((k) => k.kind === "branch");
    if (branch) {
      for (const choice of branch.children || []) {
        out.push({ title: choice.label, sub: branch.label, kind: "choice", docs: choice.children || [] });
      }
      const common = kids.find((k) => k.kind === "choice" && k !== branch);
      if (common) out.push({ title: common.label, kind: "common", docs: common.children || [] });
    } else {
      out.push({ title: "書類一式", kind: "flat", docs: kids });
    }
    return out;
  }, [tree]);

  // サマリ（書類数・穴の出所内訳）
  const summary = useMemo(() => {
    const counts: Record<SourceKind, number> = { unknown: 0, answer: 0, fact: 0, list: 0, const: 0 };
    let docs = 0;
    for (const lane of lanes) {
      for (const d of lane.docs) {
        docs++;
        for (const h of d.children || []) counts[(h.source || "unknown") as SourceKind]++;
      }
    }
    return { docs, counts, holes: Object.values(counts).reduce((a, b) => a + b, 0) };
  }, [lanes]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 p-4 md:p-8" onClick={onClose}>
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-[var(--color-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー: 事由名 + サマリ + 凡例 */}
        <div className="border-b border-[var(--color-border)] px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="text-[14px] font-semibold text-[var(--color-fg)]">{tree?.label || "事由の木"}</span>
            <span className="text-[11px] text-[var(--color-fg-muted)]">何を聞いて、何が出て、どこから埋まるか</span>
            <button
              onClick={() => setExpandAll((v) => !v)}
              className="ml-auto rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
            >
              {expandAll ? "折りたたむ" : "全部展開"}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg px-2 py-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
            >
              ×
            </button>
          </div>
          {tree && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--color-fg-muted)]">
              <span className="font-medium text-[var(--color-fg)]">
                書類{summary.docs}種・穴{summary.holes}個
              </span>
              {SOURCE_ORDER.filter((s) => s !== "unknown").map(
                (s) =>
                  summary.counts[s] > 0 && (
                    <span key={s} className="inline-flex items-center gap-1">
                      <span className={`h-2 w-2 rounded-full ${DOT[s]}`} />
                      {SOURCE_LABEL[s]} {summary.counts[s]}
                    </span>
                  )
              )}
              {summary.counts.unknown > 0 ? (
                <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                  <span className={`h-2 w-2 rounded-full ${DOT.unknown}`} />
                  出所なし {summary.counts.unknown}件 — レビュー対象
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 font-medium text-green-700">
                  <Icon name="CircleCheck" size={11} />
                  出所なしゼロ
                </span>
              )}
            </div>
          )}
        </div>

        {/* 本体: レーン（聞くこと | 選択肢ごとの書類 | 共通） */}
        <div className="flex-1 overflow-auto p-5">
          {error && <p className="text-[13px] text-red-700">{error}</p>}
          {!tree && !error && <p className="animate-pulse text-[13px] text-[var(--color-fg-muted)]">読込中...</p>}
          {tree && (
            <div className="flex items-start gap-5">
              {/* 聞くことレーン */}
              <div className="w-[290px] shrink-0 space-y-2">
                <div className="rounded-xl bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-semibold text-white">
                  聞くこと（{questions.length}問）
                </div>
                {questions.map((q, i) => {
                  const k = Q_KIND[q.kind] || Q_KIND.text;
                  return (
                    <div key={i} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2">
                      <div className="flex items-start gap-1.5">
                        <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0 text-[10px] font-medium ${k.cls}`}>
                          {k.label}
                        </span>
                        <span className="min-w-0 text-[11.5px] leading-snug text-[var(--color-fg)]">{q.label}</span>
                      </div>
                      {q.when && (
                        <p className="mt-0.5 pl-1 text-[10.5px] text-[var(--color-fg-muted)]">└ {q.when}</p>
                      )}
                    </div>
                  );
                })}
                {description && (
                  <p className="rounded-xl border border-dashed border-[var(--color-border)] p-2.5 text-[10.5px] leading-relaxed text-[var(--color-fg-muted)]">
                    {description}
                  </p>
                )}
              </div>

              {/* 書類レーン（分岐の選択肢ごと / 共通） */}
              {lanes.map((lane, i) => (
                <div key={i} className="w-[330px] shrink-0 space-y-2">
                  <div
                    className={`rounded-xl px-3 py-1.5 text-[12px] font-semibold ${
                      lane.kind === "choice"
                        ? "border border-purple-300 bg-purple-100 text-purple-900"
                        : "border border-[var(--color-border)] bg-[var(--color-hover)] text-[var(--color-fg)]"
                    }`}
                  >
                    {lane.sub && (
                      <span className="flex items-center gap-1 text-[10px] font-medium opacity-70">
                        <Icon name="GitBranch" size={10} />
                        {lane.sub}
                      </span>
                    )}
                    {lane.title}
                    <span className="ml-1.5 text-[10.5px] font-normal opacity-70">書類{lane.docs.length}種</span>
                  </div>
                  {lane.docs.length === 0 && (
                    <p className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-2.5 text-[11px] text-amber-800">
                      この枝の書類は未登録（ガードで案内されます）
                    </p>
                  )}
                  {lane.docs.map((d, j) => (
                    <DocCard key={j} doc={d} expandAll={expandAll} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-fg-muted)]">
          編集は data\jirei\{jireiId}.json（そのまま伝えてくれれば直します）
        </div>
      </div>
    </div>
  );
}
