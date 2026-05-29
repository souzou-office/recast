// 仕分け式アーキテクチャの「判断」フェーズ (Step A)。
//
// AI を 1 回だけ呼んで、Phase2Plan を出す:
//   1. valueTable     — 案件レベルの確定値 (label → 値)。全書類が共有 → 整合性保証
//   2. entityGroups   — 株主ごとに変わる値 (個人/法人それぞれの label→値 表)
//   3. templatePlans  — 各テンプレの仕分け (fill / loop / ai)
//
// ここで「同じ報酬額を 75万円 に統一」「個人テンプレは loop、法人は ai」等の *判断* をする。
// 実際の差し込み (機械作業) は fill-command-generator.ts が決定論的にやる。

import Anthropic from "@anthropic-ai/sdk";
import { logTokenUsage } from "./token-logger";
import type { Phase2Plan } from "@/types";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

// テンプレ 1 つ分の入力 (Step A に渡す)。
export interface PlanTemplateInput {
  templateFile: string;
  markedText: string;                    // ★label★ 入りの本文 (構造把握用)
  labels: { label: string; format?: string; sourceHint?: string; oldValue?: string }[];
}

const PHASE2_PLAN_TOOL: Anthropic.Tool = {
  name: "submit_phase2_plan",
  description:
    "全テンプレを見て『確定値表 + エンティティ表 + 各テンプレの仕分け』を提出する。" +
    "これは判断だけ。実際の差し込みは recast が機械的にやるので、ここでは値と方針を決めるだけ。",
  input_schema: {
    type: "object",
    properties: {
      valueTable: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "案件レベルの確定値。キー = labels の label と完全一致、値 = 最終表記で確定した1つの値。" +
          "★重要★ 同じ label は全書類で同じ値になる (例: 取締役の月額報酬額 は『75万円』で固定、" +
          "ある書類で 750,000円 にしない)。株主ごとに変わる値はここに入れず entityGroups に入れる。",
      },
      entityGroups: {
        type: "array",
        description:
          "株主ごとに値が変わるテンプレ用。同質なエンティティ (個人株主、法人株主) をグループ化。",
        items: {
          type: "object",
          properties: {
            groupId: { type: "string", description: "グループ識別 (例: '個人株主', '法人株主')。templatePlans が参照" },
            entities: {
              type: "array",
              description: "各エンティティの label→値 表。キーは labels の label と一致させる",
              items: { type: "object", additionalProperties: { type: "string" } },
            },
          },
          required: ["groupId", "entities"],
        },
      },
      templatePlans: {
        type: "array",
        description: "各テンプレの扱いの仕分け",
        items: {
          type: "object",
          properties: {
            templateFile: { type: "string" },
            mode: {
              type: "string",
              enum: ["fill", "loop", "ai"],
              description:
                "fill=出力1通・全て valueTable から / " +
                "loop=エンティティ数だけ出力 (個人提案書など、構造が全員同じ) / " +
                "ai=構造が変わって機械化できない (組合の行挿入が混在する法人提案書など)",
            },
            entityGroupId: { type: "string", description: "loop のとき必須: ループする EntityGroup の groupId" },
            outputLabelField: { type: "string", description: "loop のとき: 出力名に使う label (例: '株主の氏名')" },
            reason: { type: "string", description: "ai のとき: なぜ機械化できないか (短く)" },
          },
          required: ["templateFile", "mode"],
        },
      },
    },
    required: ["valueTable", "entityGroups", "templatePlans"],
  },
};

function buildPrompt(caseContext: string, templates: PlanTemplateInput[]): string {
  const tplBlocks = templates
    .map((t) => {
      const labelLines = t.labels
        .map((l) => {
          const parts = [`"${l.label}"`];
          if (l.format) parts.push(`形式:${l.format}`);
          if (l.sourceHint) parts.push(`出典:${l.sourceHint}`);
          if (l.oldValue) parts.push(`前案件値:${l.oldValue.slice(0, 20)}`);
          return `  - ${parts.join(" / ")}`;
        })
        .join("\n");
      return `### ${t.templateFile}\n本文:\n${t.markedText}\n\nラベル:\n${labelLines}`;
    })
    .join("\n\n---\n\n");

  return `## 案件の事実 (Phase 1 整理 + 確認 Q&A)

${caseContext}

## テンプレ一覧 (★label★ = 値を埋める箇所)

${tplBlocks}

## あなたの仕事

上記の事実をもとに、**判断だけ** してください。実際の差し込みは recast が機械的にやります。

### 1. valueTable (案件レベルの確定値)
全テンプレのラベルのうち「案件で1つに決まる値」(代表取締役の氏名、月額報酬、各種日付、会社名等) を、
**最終表記で確定**して valueTable に入れる。
- ★最重要★ 同じ label は全書類で同じ値。「形式」ヒントに従い、表記を1つに統一する
  (例: 月額報酬は「75万円」か「750,000円」のどちらか一方に決めて、全書類でそれを使う)
- 値が決められない/資料に無いものは valueTable に入れない (空欄のまま = verify が拾う)

### 2. entityGroups (株主ごとに変わる値)
「株主ごとに1通ずつ作る」テンプレ用。株主の氏名・住所・株式数のように人ごとに変わるラベルは、
ここにエンティティ表として入れる。
- 個人株主と法人株主は別グループにする (groupId: "個人株主" / "法人株主")
- 各エンティティの label→値 はラベル名をキーに

### 3. templatePlans (各テンプレの仕分け)
各テンプレを 3 つに仕分け:
- **fill**: 出力は1通。全 slot が valueTable で埋まる (取締役決定書、議事録、委任状 等)
- **loop**: 株主ごとに1通 (個人提案書 等)。entityGroupId で対象グループ指定、outputLabelField で出力名指定。
  ★条件: そのグループの全員が「値の差し替えだけ」で済む (構造が全員同じ) こと
- **ai**: 構造が変わって機械化できない場合のみ (例: 法人提案書で『株式会社』と『組合』が混在し、
  組合だけ行を挿入する必要がある等)。reason に理由を書く。**安易に ai にせず、迷ったら fill/loop を優先**

迷ったら: 同質な複数出力 → loop、単一出力 → fill、構造差がある複数出力 → ai。`;
}

export async function runPhase2Planning(args: {
  caseContext: string;
  templates: PlanTemplateInput[];
}): Promise<Phase2Plan> {
  const prompt = buildPrompt(args.caseContext, args.templates);
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    temperature: 0,
    tools: [PHASE2_PLAN_TOOL],
    tool_choice: { type: "tool", name: "submit_phase2_plan" },
    messages: [{ role: "user", content: prompt }],
  });
  logTokenUsage("/api/document-templates/analyze (Step A: plan)", MODEL, resp.usage);

  const block = resp.content.find(
    (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use" && b.name === "submit_phase2_plan"
  );
  if (!block) {
    return { valueTable: {}, entityGroups: [], templatePlans: [] };
  }
  const input = block.input as Partial<Phase2Plan>;
  return {
    valueTable: input.valueTable || {},
    entityGroups: input.entityGroups || [],
    templatePlans: input.templatePlans || [],
  };
}
