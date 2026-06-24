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
            aiOutputs: {
              type: "array",
              description:
                "ai のとき必須: このテンプレから作る出力を **全部** 列挙する (振り分けはここで1回だけ確定。" +
                "後工程に再判断させない)。法人テンプレが無く個人テンプレを使い回す場合も、" +
                "個人・法人・組合の全員をここに列挙する。漏らすとその人の書類が出なくなる。",
              items: {
                type: "object",
                properties: {
                  outputLabel: { type: "string", description: "出力の識別名 (氏名/法人名等)。1出力だけなら空文字可" },
                  needsStructuralEdit: {
                    type: "boolean",
                    description: "true=この出力は行構造の変更が要る (組合の同意欄など個人と形が違う)。false=穴埋めだけで作れる (個人など)",
                  },
                },
                required: ["outputLabel", "needsStructuralEdit"],
              },
            },
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

### 仕分け (mode) — 唯一の判定基準: 「★既存スロットを埋めるだけ★で全出力が作れるか?」
fill/loop は **既存スロットに値を入れることしかできない** (行の追加・削除・番号繰り上げは不可能)。
それで全出力が作れるなら fill/loop、1 つでも行の増減が要るなら ai。

- **fill**: 出力1通。穴埋めだけで済む (値を入れるだけ・行は増減しない)
- **loop**: 複数出力で、**全出力が完全に同じ行構造**。各出力は同じスロットに値を入れるだけで作れる。
  - sharedSlotFills = 全員共通の slot 値 (報酬・日付・代取等) を1回指定
  - entities = 出力ごとに { outputLabel(氏名等), slotFills(氏名/住所/株数等その固有値) }
- **ai**: **穴埋めだけでは形が合わない** (行の追加・削除・番号繰上げが要る)。次の 1 つでも該当 → 必ず ai:
  - 確認回答で「議案/ブロックを丸ごと削除」「議案番号の繰り上げ」が指定されている
  - ある出力が、テンプレに **無い行を足す/余る行を消す** 必要がある
  - ★**1 つのテンプレを"種類の違う相手"に使い回す場合**★ (最重要・見落としやすい):
    個人用に作られた提案書テンプレ (氏名・住所 の行) を **法人や組合にも使う** とき、
    法人/組合は『名称・所在地・代表取締役・無限責任組合員・組合員』など個人と **行構造が違う**。
    穴埋めだけでは組合の形にできない (個人の枠に詰め込むと崩れる) → **ai**。
    → **個人の出力と法人/組合の出力が混在するテンプレは「全出力同一構造」ではない = loop 不可 = ai**。
    (例: 提案書テンプレ1つで 個人2名 + 会社1 + 組合1 を出す → 組合の行構造が違うので ai)

迷ったら: そのテンプレの **全出力の中に、テンプレの行をそのまま使えない相手が 1 人でもいるか?**
いるなら ai。穴埋めだけで全員作れるなら fill/loop。

### ai のときの aiOutputs (必須・最重要)
ai に分類したら、**aiOutputs にそのテンプレから作る出力を全部列挙**する (loop の entities と同じ顔ぶれ)。
後工程 (穴埋め/構造変更) はこの一覧の通りに出力する。**ここで列挙し漏らすとその人の書類が出なくなる**。
- 個人・法人・組合を**全員**列挙する (個人テンプレを使い回すケースでも法人/組合を必ず含める)
- 各出力に needsStructuralEdit: 行構造の変更が要るか (組合=true / 個人=false 等)
- 例: 個人2名+会社1+組合1なら aiOutputs に4件。個人2名と会社=false、組合=true。`;
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
