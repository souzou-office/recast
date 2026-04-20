"use client";

import { useState } from "react";
import type { Company } from "@/types";

interface ScheduleItem {
  event: string;
  date: string;
  note?: string;
}

interface CheckItem {
  category: string;
  item: string;
  source: string;
  result: string;
  note?: string;
}

interface CheckResult {
  caseType: string;
  summary: string;
  schedule: ScheduleItem[];
  checkItems: CheckItem[];
}

interface Props {
  company: Company | null;
}

export default function CheckItems({ company }: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState("");

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-hover)]">
        <p className="text-sm text-[var(--color-fg-subtle)]">サイドバーから会社を選択してください</p>
      </div>
    );
  }

  const activeJobs = company.subfolders.filter(s => s.role === "job" && s.active);

  const runCheck = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/workspace/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id }),
      });
      if (res.ok) {
        setResult(await res.json());
      } else {
        const err = await res.json();
        setError(err.error || "生成に失敗しました");
      }
    } catch {
      setError("通信エラー");
    } finally {
      setLoading(false);
    }
  };

  // カテゴリでグループ化
  const groupedItems = result?.checkItems.reduce((acc, item) => {
    const cat = item.category || "その他";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {} as Record<string, CheckItem[]>);

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-hover)]">
      <div className="mx-auto max-w-5xl px-6 py-6">
        {/* ヘッダー */}
        <div className="mb-5">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-[var(--color-fg)]">{company.name}</h2>
              {result && (
                <div className="mt-1">
                  <span className="inline-block rounded bg-[var(--color-accent-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-accent-fg)]">
                    {result.caseType}
                  </span>
                  <p className="text-sm text-[var(--color-fg-muted)] mt-1">{result.summary}</p>
                </div>
              )}
            </div>
            <button
              onClick={runCheck}
              disabled={loading || activeJobs.length === 0}
              className="shrink-0 rounded-lg bg-[var(--color-fg)] px-4 py-2 text-sm font-medium text-white
                         hover:opacity-90 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "読み取り中..." : result ? "再読み取り" : "指示書を読み取り"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="flex justify-center gap-1 mb-3">
                <span className="animate-bounce text-blue-400">●</span>
                <span className="animate-bounce text-blue-400" style={{ animationDelay: "0.15s" }}>●</span>
                <span className="animate-bounce text-blue-400" style={{ animationDelay: "0.3s" }}>●</span>
              </div>
              <p className="text-sm text-[var(--color-fg-muted)]">指示書と基本情報を照合中...</p>
            </div>
          </div>
        )}

        {!loading && !result && (
          <div className="rounded-xl border-2 border-dashed border-[var(--color-border)] p-12 text-center bg-[var(--color-panel)]">
            <p className="text-4xl mb-4">&#128269;</p>
            <p className="text-[var(--color-fg-muted)] mb-2">
              {activeJobs.length === 0
                ? "サイドバーで案件フォルダを有効にしてください"
                : "「指示書を読み取り」で案件の確認事項を一覧表示します"}
            </p>
            {activeJobs.length > 0 && (
              <p className="text-xs text-[var(--color-fg-subtle)]">
                対象案件: {activeJobs.map(s => s.name).join(", ")}
              </p>
            )}
          </div>
        )}

        {!loading && result && (
          <div className="space-y-4">
            {/* スケジュール */}
            {result.schedule.length > 0 && (
              <div className="rounded-xl bg-[var(--color-panel)] shadow-sm border border-[var(--color-border)] overflow-hidden">
                <div className="bg-orange-50 border-b border-orange-200 px-4 py-2.5">
                  <h3 className="text-sm font-semibold text-orange-700">スケジュール</h3>
                </div>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] bg-[var(--color-hover)]">
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--color-fg-muted)]">イベント</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--color-fg-muted)] w-40">日付</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--color-fg-muted)]">備考</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.schedule.map((s, i) => (
                      <tr key={i} className="border-b border-[var(--color-border-soft)] last:border-0">
                        <td className="px-4 py-2.5 text-sm text-[var(--color-fg)]">{s.event}</td>
                        <td className="px-4 py-2.5 text-sm font-medium text-[var(--color-fg)]">{s.date}</td>
                        <td className="px-4 py-2.5 text-sm text-[var(--color-fg-muted)]">{s.note || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* 確認事項（カテゴリ別） */}
            {groupedItems && Object.entries(groupedItems).map(([category, items]) => (
              <div key={category} className="rounded-xl bg-[var(--color-panel)] shadow-sm border border-[var(--color-border)] overflow-hidden">
                <div className="bg-[var(--color-hover)] border-b border-[var(--color-border)] px-4 py-2.5">
                  <h3 className="text-sm font-semibold text-[var(--color-fg)]">{category}</h3>
                </div>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] bg-[var(--color-hover)]/50">
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--color-fg-muted)] w-48">確認項目</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--color-fg-muted)] w-24">確認元</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--color-fg-muted)]">結果</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--color-fg-muted)] w-40">注意事項</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={i} className="border-b border-[var(--color-border-soft)] last:border-0">
                        <td className="px-4 py-3 text-sm font-medium text-[var(--color-fg)] align-top">{item.item}</td>
                        <td className="px-4 py-3 align-top">
                          <span className="inline-block rounded bg-[var(--color-hover)] px-1.5 py-0.5 text-xs text-[var(--color-fg-muted)]">
                            {item.source}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-[var(--color-fg)] align-top whitespace-pre-wrap">{item.result}</td>
                        <td className="px-4 py-3 text-xs text-orange-600 align-top">{item.note || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
