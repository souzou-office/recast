"use client";

// 事由の「木」をロジックツリー（抽象 → 具体、左 → 右）として描画する。
//
//   事由 ─┬─ 分岐質問 ─┬─ 選択肢A ─┬─ 書類 ─┬─ 穴（出所で色分け）
//         │            └─ 選択肢B  └─ 書類   └─ 穴
//         └─ 共通書類 …
//
// 出所の色: 緑 = 資料から自動 / 橙 = 質問で聞く / 青 = 株主ごと等の一覧 /
//           灰 = 固定値 / 赤 = 出所なし（レビューが必要）

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";

interface TreeNode {
  label: string;
  kind: "jirei" | "branch" | "choice" | "doc" | "hole";
  source?: "fact" | "answer" | "const" | "list" | "unknown";
  detail?: string;
  badge?: string;
  children?: TreeNode[];
}

const HOLE_STYLE: Record<string, string> = {
  fact: "border-green-300 bg-green-50 text-green-900",
  answer: "border-amber-300 bg-amber-50 text-amber-900",
  list: "border-sky-300 bg-sky-50 text-sky-900",
  const: "border-[var(--color-border)] bg-[var(--color-hover)] text-[var(--color-fg-muted)]",
  unknown: "border-red-300 bg-red-50 text-red-800",
};

const SOURCE_LABEL: Record<string, string> = {
  fact: "資料から自動",
  answer: "質問で聞く",
  list: "一覧から展開",
  const: "固定値",
  unknown: "出所なし",
};

function NodeBox({ node }: { node: TreeNode }) {
  if (node.kind === "hole") {
    return (
      <div
        className={`rounded-lg border px-2.5 py-1 text-[11px] leading-snug ${HOLE_STYLE[node.source || "unknown"]}`}
        title={node.detail}
      >
        <span className="font-medium">{node.label}</span>
        {node.detail && <span className="opacity-70">　←　{node.detail}</span>}
      </div>
    );
  }
  if (node.kind === "doc") {
    return (
      <div className="rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-fg)]">
        <span className="inline-flex items-center gap-1.5">
          <Icon name={node.label.endsWith(".xlsx") ? "Sheet" : "FileText"} size={12} />
          {node.label.replace(/\.(docx|xlsx)$/i, "")}
        </span>
        {node.badge && (
          <span className="ml-2 rounded-full bg-[var(--color-accent)] px-2 py-0.5 text-[10px] text-white">
            {node.badge}
          </span>
        )}
      </div>
    );
  }
  if (node.kind === "choice") {
    return (
      <div className="rounded-xl border border-purple-300 bg-purple-50 px-3 py-1.5 text-[12px] font-medium text-purple-900">
        {node.label}
      </div>
    );
  }
  if (node.kind === "branch") {
    return (
      <div className="rounded-xl border border-purple-400 bg-purple-100 px-3 py-1.5 text-[12px] font-semibold text-purple-900">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="GitBranch" size={12} />
          {node.label}
        </span>
      </div>
    );
  }
  // jirei（根）
  return (
    <div className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-[13px] font-semibold text-white">
      {node.label}
    </div>
  );
}

// 横方向ツリー: 自分の箱 + 右側に子を縦に並べ、罫線でつなぐ
function TreeBranch({ node }: { node: TreeNode }) {
  const hasChildren = (node.children?.length ?? 0) > 0;
  return (
    <div className="flex items-center">
      <div className="shrink-0">
        <NodeBox node={node} />
      </div>
      {hasChildren && (
        <div className="flex flex-col justify-center">
          {node.children!.map((c, i) => {
            const first = i === 0;
            const last = i === node.children!.length - 1;
            const single = node.children!.length === 1;
            return (
              <div key={i} className="flex items-center">
                {/* コネクタ: 縦レール + 横枝 */}
                <div className="flex h-full flex-col self-stretch">
                  <div
                    className={`w-4 flex-1 ${!first || single ? "border-l" : ""} ${single ? "border-l-0" : ""} border-[var(--color-border)]`}
                  />
                  <div
                    className={`w-4 flex-1 ${!last || single ? "border-l" : ""} ${single ? "border-l-0" : ""} border-[var(--color-border)]`}
                  />
                </div>
                <div className="w-4 shrink-0 border-t border-[var(--color-border)]" />
                <div className="py-1">
                  <TreeBranch node={c} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function JireiTreeView({ jireiId, onClose }: { jireiId: string; onClose: () => void }) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/jirei/tree?id=${encodeURIComponent(jireiId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.tree) setTree(d.tree);
        else setError(d.error || "木を読み込めませんでした");
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

  return (
    <div className="fixed inset-0 z-50 bg-black/50 p-4 md:p-8" onClick={onClose}>
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-[var(--color-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
          <span className="text-[13px] font-medium text-[var(--color-fg)]">
            事由の木 — 何を聞いて、何が出て、どこから埋まるか
          </span>
          <div className="flex items-center gap-3 text-[11px] text-[var(--color-fg-muted)]">
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm border border-green-300 bg-green-50" />
              資料から自動
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm border border-amber-300 bg-amber-50" />
              質問で聞く
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm border border-sky-300 bg-sky-50" />
              株主ごと等
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm border border-red-300 bg-red-50" />
              出所なし
            </span>
            <button
              onClick={onClose}
              className="ml-2 rounded-lg px-2 py-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
            >
              ×
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-6">
          {error && <p className="text-[13px] text-red-700">{error}</p>}
          {!tree && !error && (
            <p className="animate-pulse text-[13px] text-[var(--color-fg-muted)]">読込中...</p>
          )}
          {tree && <TreeBranch node={tree} />}
        </div>
        <div className="border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-fg-muted)]">
          {SOURCE_LABEL.fact}＝基本情報（登記データ）から。編集は data\jirei\{jireiId}.json（そのまま伝えてくれれば直します）
        </div>
      </div>
    </div>
  );
}
