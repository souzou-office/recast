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
      <div className="flex h-full items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">サイドバーから会社を選択してください</p>
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
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="mx-auto max-w-5xl px-6 py-6">
        {/* ヘッダー */}
        <div className="mb-5">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-gray-900">{company.name}</h2>
              {result && (
                <div className="mt-1">
                  <span className="inline-block rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                    {result.caseType}
                  </span>
                  <p className="text-sm text-gray-600 mt-1">{result.summary}</p>
                </div>
              )}
            </div>
            <button
              onClick={runCheck}
              disabled={loading || activeJobs.length === 0}
              className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white
                         hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
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
              <p className="text-sm text-gray-500">指示書と基本情報を照合中...</p>
            </div>
          </div>
        )}

        {!loading && !result && (
          <div className="rounded-xl border-2 border-dashed border-gray-300 p-12 text-center bg-white">
            <p className="text-4xl mb-4">&#128269;</p>
            <p className="text-gray-500 mb-2">
              {activeJobs.length === 0
                ? "サイドバーで案件フォルダを有効にしてください"
                : "「指示書を読み取り」で案件の確認事項を一覧表示します"}
            </p>
            {activeJobs.length > 0 && (
              <p className="text-xs text-gray-400">
                対象案件: {activeJobs.map(s => s.name).join(", ")}
              </p>
            )}
          </div>
        )}

        {!loading && result && (
          <div className="space-y-4">
            {/* スケジュール */}
            {result.schedule.length > 0 && (
              <div className="rounded-xl bg-white shadow-sm border border-gray-200 overflow-hidden">
                <div className="bg-orange-50 border-b border-orange-200 px-4 py-2.5">
                  <h3 className="text-sm font-semibold text-orange-700">スケジュール</h3>
                </div>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">イベント</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 w-40">日付</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">備考</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.schedule.map((s, i) => (
                      <tr key={i} className="border-b border-gray-100 last:border-0">
                        <td className="px-4 py-2.5 text-sm text-gray-800">{s.event}</td>
                        <td className="px-4 py-2.5 text-sm font-medium text-gray-900">{s.date}</td>
                        <td className="px-4 py-2.5 text-sm text-gray-600">{s.note || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* 確認事項（カテゴリ別） */}
            {groupedItems && Object.entries(groupedItems).map(([category, items]) => (
              <div key={category} className="rounded-xl bg-white shadow-sm border border-gray-200 overflow-hidden">
                <div className="bg-gray-50 border-b border-gray-200 px-4 py-2.5">
                  <h3 className="text-sm font-semibold text-gray-700">{category}</h3>
                </div>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50/50">
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 w-48">確認項目</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 w-24">確認元</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">結果</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 w-40">注意事項</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={i} className="border-b border-gray-100 last:border-0">
                        <td className="px-4 py-3 text-sm font-medium text-gray-800 align-top">{item.item}</td>
                        <td className="px-4 py-3 align-top">
                          <span className="inline-block rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                            {item.source}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-800 align-top whitespace-pre-wrap">{item.result}</td>
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
