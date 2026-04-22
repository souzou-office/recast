import { NextRequest, NextResponse } from "next/server";
import { getTokenLog, clearTokenLog, getTotals } from "@/lib/token-logger";

export async function GET() {
  const entries = getTokenLog();
  const totals = getTotals();

  // エンドポイント別集計
  const byEndpoint: Record<string, {
    calls: number;
    input: number;
    output: number;
    cache_write: number;
    cache_read: number;
    cost: number;
  }> = {};
  for (const e of entries) {
    const key = e.endpoint;
    if (!byEndpoint[key]) {
      byEndpoint[key] = { calls: 0, input: 0, output: 0, cache_write: 0, cache_read: 0, cost: 0 };
    }
    const b = byEndpoint[key];
    b.calls += 1;
    b.input += e.input_tokens;
    b.output += e.output_tokens;
    b.cache_write += e.cache_creation_input_tokens;
    b.cache_read += e.cache_read_input_tokens;
    b.cost += e.cost_usd;
  }

  return NextResponse.json({
    totals,
    byEndpoint,
    entries: entries.slice(0, 50), // 最新50件
  });
}

export async function DELETE(_request: NextRequest) {
  clearTokenLog();
  return NextResponse.json({ ok: true });
}
