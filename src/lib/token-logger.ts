/**
 * Claude API のトークン使用量をプロセス内メモリに記録するデバッグ用ロガー。
 * 本番運用では使わず、開発中のコスト可視化用途。
 *
 * 使い方:
 *   import { logTokenUsage } from "@/lib/token-logger";
 *   const response = await client.messages.create({...});
 *   logTokenUsage("/api/chat", "claude-sonnet-4-6", response.usage);
 *
 * ストリーミングの場合:
 *   const stream = client.messages.stream({...});
 *   for await (const ev of stream) { ... }
 *   const final = await stream.finalMessage();
 *   logTokenUsage("/api/chat", "claude-sonnet-4-6", final.usage);
 */

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface TokenLogEntry {
  timestamp: string;
  endpoint: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
}

// Anthropic 公式料金 ($/MTok, 2025-11 時点)
// https://www.anthropic.com/pricing#anthropic-api
// cache_write = 基準入力 × 1.25、cache_read = 基準入力 × 0.1（ephemeral 5min）
const PRICING: Record<string, { in: number; out: number; cache_write: number; cache_read: number }> = {
  "claude-sonnet-4-6": { in: 3, out: 15, cache_write: 3.75, cache_read: 0.3 },
  "claude-sonnet-4-5": { in: 3, out: 15, cache_write: 3.75, cache_read: 0.3 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5, cache_write: 1.25, cache_read: 0.1 },
  "claude-haiku-4-5": { in: 1, out: 5, cache_write: 1.25, cache_read: 0.1 },
};

const MAX_ENTRIES = 500;

// Next.js の dev モードでは HMR でモジュールが再評価されると配列がリセットされる。
// globalThis に退避して寿命を伸ばす。
type Store = { entries: TokenLogEntry[] };
const g = globalThis as unknown as { __recast_token_store__?: Store };
if (!g.__recast_token_store__) {
  g.__recast_token_store__ = { entries: [] };
}
const store = g.__recast_token_store__;

export function logTokenUsage(
  endpoint: string,
  model: string,
  usage: TokenUsage | null | undefined
): void {
  if (!usage) return;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheW = usage.cache_creation_input_tokens || 0;
  const cacheR = usage.cache_read_input_tokens || 0;

  // pricing は正確一致 → 前方一致でフォールバック
  let price = PRICING[model];
  if (!price) {
    const prefix = Object.keys(PRICING).find(k => model.startsWith(k));
    price = prefix ? PRICING[prefix] : PRICING["claude-sonnet-4-6"];
  }

  const cost =
    (input * price.in +
      output * price.out +
      cacheW * price.cache_write +
      cacheR * price.cache_read) /
    1_000_000;

  const entry: TokenLogEntry = {
    timestamp: new Date().toISOString(),
    endpoint,
    model,
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheW,
    cache_read_input_tokens: cacheR,
    cost_usd: cost,
  };

  store.entries.unshift(entry);
  if (store.entries.length > MAX_ENTRIES) {
    store.entries.length = MAX_ENTRIES;
  }

  // サーバーコンソールにも出す（dev で追いかけやすいように）
  const cost4 = cost.toFixed(4);
  const cacheTag = cacheR > 0 ? ` cacheRead=${cacheR}` : cacheW > 0 ? ` cacheWrite=${cacheW}` : "";
  console.log(`[tokens] ${endpoint} ${model} in=${input} out=${output}${cacheTag} $${cost4}`);
}

export function getTokenLog(): TokenLogEntry[] {
  return store.entries.slice();
}

export function clearTokenLog(): void {
  store.entries.length = 0;
}

export interface TokenTotals {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cost: number;
  calls: number;
}

export function getTotals(): TokenTotals {
  return store.entries.reduce<TokenTotals>(
    (acc, e) => ({
      input: acc.input + e.input_tokens,
      output: acc.output + e.output_tokens,
      cache_write: acc.cache_write + e.cache_creation_input_tokens,
      cache_read: acc.cache_read + e.cache_read_input_tokens,
      cost: acc.cost + e.cost_usd,
      calls: acc.calls + 1,
    }),
    { input: 0, output: 0, cache_write: 0, cache_read: 0, cost: 0, calls: 0 }
  );
}
