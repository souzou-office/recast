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
  markedText: string;                    // ★label★ / ［領域_N］ 入りの本文 (構造把握用)
  slots: { slotId: number; label: string; format?: string; sourceHint?: string; oldValue?: string }[];
  regions?: { slotId: number; text: string }[];   // 緑マーカーの「入れ替え領域」(slotId + 元テキスト)
}

const SLOT_FILL_ITEM = {
  type: "object" as const,
  properties: {
    slotId: { type: "number" as const, description: "対象 slot の番号 (提示された slotId)" },
    value: { type: "string" as const, description: "その slot に入れる最終的な値。不要な行 (使わない取締役枠等) は空文字 \"\"" },
  },
  required: ["slotId", "value"],
};

// 領域スロット (緑マーカー = 入れ替えブロック) への中身。AI は「入る行」を配列で出すだけ。
// 場所 (消す段落・挿入位置) はパーサーが確定済みなので AI は触らない。
const REGION_FILL_ITEM = {
  type: "object" as const,
  properties: {
    slotId: { type: "number" as const, description: "対象の領域スロット番号 (本文の ［領域_N］ の N)" },
    lines: {
      type: "array" as const,
      items: { type: "string" as const },
      description:
        "その領域に入れる行を上から順に (1要素=1行)。例: 個人なら『住所の行』『氏名の行』、" +
        "組合なら『主たる事務所』『名称』『無限責任組合員』『組合員』『代表取締役』等。完成形を省略せず全行。" +
        "空配列なら領域を削除するだけ (純削除)。",
    },
  },
  required: ["slotId", "lines"],
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
                "fill=出力1通 / " +
                "loop=複数出力 (株主ごと1通など) / " +
                "ai=議案ブロック削除+番号繰り上げ 等、緑の領域マーカーで表せない構造編集だけ。" +
                "★組合化など『行の入れ替え』は緑の領域スロット(［領域_N］)で表すので ai にしない → loop+regionFills を使う★",
            },
            // fill 用 (出力1通)
            slotFills: {
              type: "array",
              description: "fill のとき: 各 slot への値割り当て [{slotId, value}]。埋めるべき全 slot を含める",
              items: SLOT_FILL_ITEM,
            },
            regionFills: {
              type: "array",
              description: "fill のとき: 各 領域スロット (［領域_N］) に入れる行 [{slotId, lines}]",
              items: REGION_FILL_ITEM,
            },
            // loop 用 (複数出力)
            sharedSlotFills: {
              type: "array",
              description: "loop のとき: 全出力で共通の slot 値 (報酬・日付・代表取締役等)。1 回だけ指定 → 全員に適用されて整合する",
              items: SLOT_FILL_ITEM,
            },
            entities: {
              type: "array",
              description: "loop のとき: 出力 (株主等) ごとの固有な値 (点 slotFills + 領域 regionFills)",
              items: {
                type: "object",
                properties: {
                  outputLabel: { type: "string", description: "出力の識別名 (氏名等)" },
                  slotFills: { type: "array", description: "この出力固有の slot 値 (氏名/住所/株数等)", items: SLOT_FILL_ITEM },
                  regionFills: { type: "array", description: "この出力固有の領域の中身 (同意欄ブロック等)。個人=2行/組合=6行", items: REGION_FILL_ITEM },
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
      const regionLines = (t.regions || [])
        .map((r) => `  - 領域 ${r.slotId} (本文の ［領域_${r.slotId}］): 元の内容「${r.text.slice(0, 80)}」`)
        .join("\n");
      const regionBlock = regionLines
        ? `\n\n領域スロット (緑マーカー=入れ替えブロック。この領域に入る行を regionFills で出す):\n${regionLines}`
        : "";
      return `### ${t.templateFile}\n本文:\n${t.markedText}\n\nslot 一覧 (この番号で値を割り当てる):\n${slotLines}${regionBlock}`;
    })
    .join("\n\n---\n\n");

  return `## 案件の事実 (Phase 1 整理 + 確認 Q&A)

${caseContext}

## テンプレ一覧
本文中のマーカーは2種類:
- **★label★ → 点スロット (［要入力_N］)**: 1箇所に「値」を入れる (行数は変わらない)。slotFills で指定。
- **緑マーカー → 領域スロット (［領域_N］)**: 行構成ごと入れ替わるブロック (同意欄など)。regionFills で「入る行」を指定。

${tplBlocks}

## あなたの仕事
各テンプレを仕分け (fill/loop/ai) し、**点スロットには値 (slotFills)、領域スロットには行 (regionFills)** を、
番号 (slotId) で指定する。ラベル名では指定しない。

### 値の入れ方 (点スロット)
- 「形式」ヒントに従って最終表記を決める (例: 形式「○月分より」なら「令和8年6月分より」)
- **同じ意味の値は全テンプレ・全出力で同じにする** (月額報酬は全書類「75万円」で統一。750,000円 にしない)。
  全テンプレを一度に見ているので統一できる
- **案件フォルダの画像 (マイナンバーカード等) が添付されていれば**、整理結果に無い値 (生年月日・住所の
  正確な表記等) は画像から読み取って埋める (UNKNOWN を残さない)
- 本当に決まらない点 slot だけ slotFills に含めない (前案件値が残るが別途チェックされる)
- **使わない行の点 slot** (取締役3枠で1人等) は value を空文字 "" → recast がその行を削除

### 領域の入れ方 (領域スロット = 緑マーカー)
領域は「行構成ごと入れ替わるブロック」。**各出力ごとに、その領域に入る行を regionFills の lines で出す**:
- 個人の出力 → その個人の行 (例: 「住所　○○」「氏名　○○」)
- 組合の出力 → 組合の行 (例: 「主たる事務所　○○」「名称　○○」「無限責任組合員　○○」「組合員　○○」「代表取締役　○○」)
- **場所 (どの段落を消すか・どこに入れるか) は recast が決める**。あなたは行の中身だけ出す (paraId 不要)。
- 元の項目を新ラベルで省略せず全部表現する。完成形を上から順に。

### 仕分け (mode)
- **fill**: 出力1通 (点 slotFills + 必要なら 領域 regionFills)
- **loop**: 複数出力 (株主ごと1通など)。各出力で点も領域も中身が違う:
  - sharedSlotFills = 全出力共通の点 slot 値 (報酬・日付・代取等) を1回指定
  - entities = 出力ごとに { outputLabel(氏名/法人名等), slotFills(その固有の点値), regionFills(その固有の領域行) }
  - ★1つのテンプレを個人にも法人/組合にも使う場合もこれ★。個人も法人も組合も全部 entities に入れ、
    領域 (同意欄) の lines を相手ごとに変える (個人=2行/組合=6行)。**ai にしない**。
    1人でも漏らすとその人の書類が出ない → **全員を entities に列挙**する。
- **ai**: 緑の領域マーカーで表せない構造編集だけ (議案ブロックの丸ごと削除 + 後続議案の番号繰り上げ 等)。
  この時だけ aiOutputs に全出力を列挙し各出力に needsStructuralEdit を付ける。
  (組合化など『行の入れ替え』は領域スロットで表せるので ai にしない)`;
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
