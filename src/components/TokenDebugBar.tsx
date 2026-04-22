"use client";

import { useEffect, useState, useCallback } from "react";

interface TokenLogEntry {
  timestamp: string;
  endpoint: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
}

interface Totals {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cost: number;
  calls: number;
}

interface ByEndpoint {
  [endpoint: string]: {
    calls: number;
    input: number;
    output: number;
    cache_write: number;
    cache_read: number;
    cost: number;
  };
}

interface TokenData {
  totals: Totals;
  byEndpoint: ByEndpoint;
  entries: TokenLogEntry[];
}

const fmt = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

const fmtUsd = (n: number): string => `$${n.toFixed(4)}`;
const fmtJpy = (usd: number): string => `¥${Math.round(usd * 155).toLocaleString()}`;

export default function TokenDebugBar() {
  const [data, setData] = useState<TokenData | null>(null);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/debug/tokens", { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      setData(json);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (hidden) return;
    fetchData();
    const id = setInterval(fetchData, 3000);
    return () => clearInterval(id);
  }, [fetchData, hidden]);

  const handleClear = async () => {
    await fetch("/api/debug/tokens", { method: "DELETE" });
    fetchData();
  };

  if (hidden) {
    return (
      <button
        onClick={() => setHidden(false)}
        className="fixed bottom-2 right-2 z-50 rounded-md bg-gray-900 px-2 py-1 text-[10px] font-mono text-white opacity-60 hover:opacity-100"
      >
        $ tokens
      </button>
    );
  }

  const totals = data?.totals;
  const byEndpoint = data?.byEndpoint || {};
  const entries = data?.entries || [];

  const sortedEndpoints = Object.entries(byEndpoint).sort((a, b) => b[1].cost - a[1].cost);

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-gray-700 bg-gray-900 text-gray-100 font-mono text-[11px] shadow-lg">
      {/* ヘッダー行（常に表示） */}
      <div className="flex items-center gap-3 px-3 py-1.5">
        <button
          onClick={() => setOpen(v => !v)}
          className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] hover:bg-gray-700"
          title={open ? "折りたたむ" : "展開"}
        >
          {open ? "▼" : "▲"}
        </button>
        <span className="shrink-0 text-gray-400">TOKENS</span>
        {totals ? (
          <>
            <span className="shrink-0">
              <span className="text-gray-400">calls</span>{" "}
              <span className="font-bold">{totals.calls}</span>
            </span>
            <span className="shrink-0">
              <span className="text-gray-400">in</span>{" "}
              <span className="font-bold text-sky-300">{fmt(totals.input)}</span>
            </span>
            <span className="shrink-0">
              <span className="text-gray-400">out</span>{" "}
              <span className="font-bold text-amber-300">{fmt(totals.output)}</span>
            </span>
            <span className="shrink-0">
              <span className="text-gray-400">cache/r</span>{" "}
              <span className="font-bold text-emerald-300">{fmt(totals.cache_read)}</span>
            </span>
            <span className="shrink-0">
              <span className="text-gray-400">cache/w</span>{" "}
              <span className="font-bold text-violet-300">{fmt(totals.cache_write)}</span>
            </span>
            <span className="shrink-0 ml-auto">
              <span className="text-gray-400">cost</span>{" "}
              <span className="font-bold text-red-300">{fmtUsd(totals.cost)}</span>{" "}
              <span className="text-gray-500">({fmtJpy(totals.cost)})</span>
            </span>
          </>
        ) : (
          <span className="text-gray-500">loading...</span>
        )}
        <button
          onClick={handleClear}
          className="shrink-0 rounded bg-red-900 px-2 py-0.5 text-[10px] hover:bg-red-800"
          title="ログをクリア"
        >
          clear
        </button>
        <button
          onClick={() => setHidden(true)}
          className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] hover:bg-gray-700"
          title="隠す"
        >
          ×
        </button>
      </div>

      {/* 展開時: エンドポイント別 & 最近のログ */}
      {open && (
        <div className="max-h-[40vh] overflow-y-auto border-t border-gray-800 px-3 py-2">
          {/* エンドポイント別（コスト降順） */}
          <div className="mb-3">
            <div className="mb-1 text-[10px] font-bold text-gray-400">ENDPOINT別（コスト降順）</div>
            <table className="w-full text-[10px]">
              <thead className="text-gray-500">
                <tr>
                  <th className="text-left font-normal">endpoint</th>
                  <th className="text-right font-normal w-12">calls</th>
                  <th className="text-right font-normal w-16 text-sky-400">in</th>
                  <th className="text-right font-normal w-16 text-amber-400">out</th>
                  <th className="text-right font-normal w-16 text-emerald-400">cache/r</th>
                  <th className="text-right font-normal w-16 text-violet-400">cache/w</th>
                  <th className="text-right font-normal w-20 text-red-400">cost</th>
                </tr>
              </thead>
              <tbody>
                {sortedEndpoints.map(([ep, v]) => (
                  <tr key={ep} className="border-t border-gray-800">
                    <td className="py-0.5 truncate max-w-[260px]" title={ep}>{ep}</td>
                    <td className="text-right">{v.calls}</td>
                    <td className="text-right text-sky-300">{fmt(v.input)}</td>
                    <td className="text-right text-amber-300">{fmt(v.output)}</td>
                    <td className="text-right text-emerald-300">{fmt(v.cache_read)}</td>
                    <td className="text-right text-violet-300">{fmt(v.cache_write)}</td>
                    <td className="text-right text-red-300">{fmtUsd(v.cost)}</td>
                  </tr>
                ))}
                {sortedEndpoints.length === 0 && (
                  <tr><td colSpan={7} className="py-2 text-center text-gray-500">まだ呼び出しなし</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* 最近のログ */}
          <div>
            <div className="mb-1 text-[10px] font-bold text-gray-400">最近のログ（新しい順）</div>
            <table className="w-full text-[10px]">
              <thead className="text-gray-500">
                <tr>
                  <th className="text-left font-normal w-20">time</th>
                  <th className="text-left font-normal">endpoint</th>
                  <th className="text-left font-normal w-32">model</th>
                  <th className="text-right font-normal w-12 text-sky-400">in</th>
                  <th className="text-right font-normal w-12 text-amber-400">out</th>
                  <th className="text-right font-normal w-12 text-emerald-400">c/r</th>
                  <th className="text-right font-normal w-12 text-violet-400">c/w</th>
                  <th className="text-right font-normal w-20 text-red-400">cost</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => {
                  const t = new Date(e.timestamp);
                  const hh = String(t.getHours()).padStart(2, "0");
                  const mm = String(t.getMinutes()).padStart(2, "0");
                  const ss = String(t.getSeconds()).padStart(2, "0");
                  return (
                    <tr key={`${e.timestamp}-${i}`} className="border-t border-gray-800">
                      <td className="py-0.5 text-gray-500">{hh}:{mm}:{ss}</td>
                      <td className="truncate max-w-[220px]" title={e.endpoint}>{e.endpoint}</td>
                      <td className="text-gray-500 truncate" title={e.model}>{e.model.replace("claude-", "")}</td>
                      <td className="text-right text-sky-300">{fmt(e.input_tokens)}</td>
                      <td className="text-right text-amber-300">{fmt(e.output_tokens)}</td>
                      <td className="text-right text-emerald-300">{fmt(e.cache_read_input_tokens)}</td>
                      <td className="text-right text-violet-300">{fmt(e.cache_creation_input_tokens)}</td>
                      <td className="text-right text-red-300">{fmtUsd(e.cost_usd)}</td>
                    </tr>
                  );
                })}
                {entries.length === 0 && (
                  <tr><td colSpan={8} className="py-2 text-center text-gray-500">まだログなし</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
