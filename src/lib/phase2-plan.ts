// 仕分け式アーキテクチャの「判断」フェーズ (Step A)。
//
// AI を 1 回だけ呼んで、Phase2Plan を出す:
//   - 各テンプレの扱いの仕分け (fill / loop / ai)
//   - fill/loop は各 slot に値を割り当てる (slotId 直接指定。ラベル名照合は使わない)
//
// ★slotId 直接指定にする理由★
//   ラベル名はテンプレ間で表記が揺れる (報酬の支給開始時期 vs 報酬支給開始時期)。
//   文字列照合だと 1 文字差で外れて古い値が残る。slotId は番号なので揺れない。
//   AI は全テンプレを 1 回で見るので、同じ意味の slot に同じ値を入れて整合性も担保できる。

import Anthropic from "@anthropic-ai/sdk";
import { logTokenUsage } from "./token-logger";
import type { Phase2Plan } from "@/types";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

// テンプレ 1 つ分の入力 (Step A に渡す)。各 slot に slotId が付く。
export interface PlanTemplateInput {
  templateFile: string;
  markedText: string;                    // ★label★ 入りの本文 (構造把握用)
  slots: { slotId: number; label: string; format?: string; sourceHint?: string; oldValue?: string }[];
}

const SLOT_FILL_ITEM = {
  type: "object" as const,
  properties: {
    slotId: { type: "number" as const, description: "対象 slot の番号 (提示された slotId)" },
    value: { type: "string" as const, description: "その slot に入れる最終的な値。不要な行 (使わない取締役枠等) は空文字 \"\"" },
  },
  required: ["slotId", "value"],
};

const PHASE2_PLAN_TOOL: Anthropic.Tool = {
  name: "submit_phase2_plan",
  description:
    "全テンプレを見て、各テンプレの扱い (fill/loop/ai) と、各 slot への値割り当てを提出する。" +
    "値は slot 番号 (slotId) で指定する。ラベル名では指定しない。",
  input_schema: {
    type: "object",
    properties: {
      templatePlans: {
        type: "array",
        description: "各テンプレの仕分けと値割り当て",
        items: {
          type: "object",
          properties: {
            templateFile: { type: "string" },
            mode: {
              type: "string",
              enum: ["fill", "loop", "ai"],
              description:
                "fill=出力1通・各 slot に値を入れる / " +
                "loop=同質な複数出力 (株主ごと1通など。全員構造が同じ) / " +
                "ai=構造が変わって機械化できない (組合で行挿入が要る等)",
            },
            // fill 用
            slotFills: {
              type: "array",
              description: "fill のとき: 各 slot への値割り当て [{slotId, value}]。埋めるべき全 slot を含める",
              items: SLOT_FILL_ITEM,
            },
            // loop 用
            sharedSlotFills: {
              type: "array",
              description: "loop のとき: 全出力で共通の slot 値 (報酬・日付・代表取締役等)。1 回だけ指定 → 全員に適用されて整合する",
              items: SLOT_FILL_ITEM,
            },
            entities: {
              type: "array",
              description: "loop のとき: 出力 (株主等) ごとの固有 slot 値",
              items: {
                type: "object",
                properties: {
                  outputLabel: { type: "string", description: "出力の識別名 (氏名等)" },
                  slotFills: { type: "array", description: "この出力固有の slot 値 (氏名/住所/株数等)", items: SLOT_FILL_ITEM },
                },
                required: ["outputLabel", "slotFills"],
              },
            },
            // ai 用
            reason: { type: "string", description: "ai のとき: なぜ機械化できないか (短く)" },
          },
          required: ["templateFile", "mode"],
        },
      },
    },
    required: ["templatePlans"],
  },
};

function buildPrompt(caseContext: string, templates: PlanTemplateInput[]): string {
  const tplBlocks = templates
    .map((t) => {
      const slotLines = t.slots
        .map((s) => {
          const parts = [`slot ${s.slotId}: 「${s.label}」`];
          if (s.format) parts.push(`形式:${s.format}`);
          if (s.sourceHint) parts.push(`出典:${s.sourceHint}`);
          if (s.oldValue) parts.push(`前案件値:${s.oldValue.slice(0, 24)}`);
          return `  - ${parts.join(" / ")}`;
        })
        .join("\n");
      return `### ${t.templateFile}\n本文:\n${t.markedText}\n\nslot 一覧 (この番号で値を割り当てる):\n${slotLines}`;
    })
    .join("\n\n---\n\n");

  return `## 案件の事実 (Phase 1 整理 + 確認 Q&A)

${caseContext}

## テンプレ一覧 (★label★ = 値を埋める箇所。各 slot に番号 slotId が振ってある)

${tplBlocks}

## あなたの仕事

各テンプレを仕分けして、**各 slot に入れる値を slot 番号 (slotId) で指定**してください。

### 値の入れ方 (重要)
- 値は必ず **slotId** で指定する。ラベル名では指定しない (ラベルは slot を理解するためのヒント)
- 「形式」ヒントに従って最終表記を決める (例: 形式「○月分より」なら「令和8年6月分より」)
- **同じ意味の値は全テンプレ・全出力で同じにする** (例: 月額報酬は全書類で「75万円」に統一。
  ある書類で 750,000円 にしない)。あなたは全テンプレを一度に見ているので統一できる
- **案件フォルダの画像 (マイナンバーカード・運転免許証・印鑑証明書等) が添付されている場合**、
  整理結果・確認回答のテキストに無い値 (生年月日・住所・氏名の正確な表記など) は、その添付画像から
  **読み取って埋める**こと。生年月日はまさにこれらの画像に写っている。
  「資料から値が決まらない」と諦める前に、必ず添付画像を確認する (UNKNOWN 等の placeholder を残さない)。
- それでも本当に決まらない slot だけ slotFills に含めない (前案件値が残るが、それは別途チェックされる)
- **使わない行の slot** (取締役3枠あるが1人だけ等、余る枠) は value を空文字 "" にする
  → recast がその行を削除して詰める

### 仕分け (mode)
- **fill**: 出力は1通で、**slot の穴埋めだけ**で済む書類 (値を入れるだけ・構造は変えない)
- **loop**: 株主ごとに1通 (個人提案書等、全員構造が同じ)。
  - sharedSlotFills = 全員共通の slot 値 (報酬・日付・代取等) を1回指定
  - entities = 株主ごとに { outputLabel(氏名等), slotFills(氏名/住所/株数等その人固有) }
- **ai**: **穴埋め以外の“構造の編集”が要る書類**。次のどれかに当てはまれば必ず ai にする:
  - 確認回答で「**議案/ブロックを丸ごと削除**」「議案番号の繰り上げ」が指定されている
  - 行の挿入が要る (法人提案書で組合だけ無限責任組合員の行を足す等)
  - その他、slot 穴埋めだけでは形が合わない
  fill/loop は **slot に値を入れることしかできず、段落・ブロックの削除や番号繰り上げはできない**。
  そういう編集が 1 つでもあれば ai。reason に理由を書く。
  (穴埋めだけで済むなら fill/loop を優先)`;
}

export async function runPhase2Planning(args: {
  caseContext: string;
  templates: PlanTemplateInput[];
  caseImages?: { base64: string; mimeType: string; name: string }[];
}): Promise<Phase2Plan> {
  const prompt = buildPrompt(args.caseContext, args.templates);
  // 案件フォルダの画像 (マイナンバーカード等) を添付。整理結果テキストに無い値 (生年月日・住所など、
  // 画像にしか無い情報) を穴埋め AI が原本から直接読み取れるようにする。画像が無ければ従来どおり文字のみ。
  const imgMimes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  const images = (args.caseImages || []).filter((im) => im.base64 && imgMimes.has(im.mimeType));
  const content: string | Anthropic.ContentBlockParam[] = images.length > 0
    ? [
        ...images.map((im) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: im.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: im.base64 },
        })),
        { type: "text" as const, text: prompt },
      ]
    : prompt;
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 16384,
    temperature: 0,
    tools: [PHASE2_PLAN_TOOL],
    tool_choice: { type: "tool", name: "submit_phase2_plan" },
    messages: [{ role: "user", content }],
  });
  logTokenUsage("/api/document-templates/analyze (Step A: plan)", MODEL, resp.usage);

  const block = resp.content.find(
    (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use" && b.name === "submit_phase2_plan"
  );
  if (!block) return { templatePlans: [] };
  const input = block.input as Partial<Phase2Plan>;
  return { templatePlans: input.templatePlans || [] };
}
