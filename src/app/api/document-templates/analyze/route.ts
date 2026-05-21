// /api/document-templates/analyze
// Phase 2 = 「手続き判断」(テンプレに具体的に何を入れるかを確定する)。
//
// 設計の核心:
//   - Phase 1 は実体判断 (案件構造・議題構成・整合性) を md で出力
//   - Phase 2 (このルート) はテンプレ本文 + 案件ファイル + Phase 1 整理 + Phase 1 Q&A を
//     全部読み直して、テンプレの各スロット / 各議案について
//     「何を入れる / 削除する / 確定できない」を 1 つずつ決める
//   - Phase 3 (produce) は Phase 2 の決定をルールベースで適用するだけ
//
// === 2 段階 AI 呼び出し ===
//   Call 1: Sonnet 4.6 が推論 md を生成 (どの slot をどうするか、ラベル変換等を判断)
//   Call 2: Haiku 4.5 が推論を読んで Tool Use で構造化 JSON を生成 (schema 強制)
//
//   理由: 1 回で「推論 + JSON 出力」をやらせると、複雑案件で推論が長文化して
//        JSON 出力に到達しない事故 (Polaris ケース) が起きる。
//        推論と JSON 化を別 call に分割して各タスク単一化 + Tool Use で形式保証する。

import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { logTokenUsage } from "@/lib/token-logger";
import {
  loadAiMessages,
  saveAiMessages,
  truncateBeforeStage,
  appendUserTurn,
  appendAssistantTurn,
  toAnthropicMessages,
  hasStage,
} from "@/lib/case-conversation";
import type { Phase2Decisions, Phase2DocumentDecision } from "@/types";

const client = new Anthropic();
const REASONING_MODEL = "claude-sonnet-4-6";
// Call 2 も Sonnet を使う。Haiku は schema の semantic (blockDeletes anchor の意味、
// rowInsertions の 1 行 1 entry ルール、afterSlot に slot 名のみ可、等) を誤解する傾向が
// あり、推論メモを正しく構造化できないケースが頻発した (総数引受で blockDelete の endAnchor を
// 同じ slot にしたり、rowInsertions に複数行を \n 詰めしたり)。
// Sonnet なら schema 理解が確実。コスト差は Phase 2 で +数円程度 (1 案件 1 回呼び出し)。
const JSON_MODEL = "claude-sonnet-4-6";

// Phase 2 の出力 schema (Tool Use 用)。types/index.ts の Phase2DocumentDecision と整合させる。
// AI はこの schema に従って構造化データを返す。schema 違反は API レベルで弾かれる。
const PHASE2_DECISIONS_TOOL: Anthropic.Tool = {
  name: "submit_phase2_decisions",
  description:
    "Phase 2 の決定 (各書類への slot 判断・行操作・テキスト置換) を提出する。" +
    "推論で確定した「どの slot に何を入れるか」「どの行を消すか」「何を挿入するか」を構造化して渡す。",
  input_schema: {
    type: "object",
    properties: {
      documents: {
        type: "array",
        description: "書類ごとの決定。同じテンプレから複数出力する場合は outputLabel で区別して複数 entry を持つ",
        items: {
          type: "object",
          properties: {
            templateFile: {
              type: "string",
              description: "クリーンな物理テンプレファイル名 (例: '2-1.提案書兼同意書.docx')",
            },
            outputLabel: {
              type: "string",
              description: "同一テンプレから複数出力する場合の識別 (例: '藤崎用', '法人用')。1 出力なら省略",
            },
            slotDecisions: {
              type: "array",
              description: "各 ★label★ slot に対する判断。各 slot は 1 度だけ登場、action は 1 つ",
              items: {
                type: "object",
                properties: {
                  slot: {
                    type: "string",
                    description: "テンプレ内の ★label★ の中身そのまま",
                  },
                  action: {
                    type: "string",
                    enum: ["fill", "delete-row", "unconfirmed"],
                    description: "fill=値を入れる / delete-row=行ごと削除 / unconfirmed=ユーザーに確認",
                  },
                  value: { type: "string", description: "fill のときの値 (最終形式)" },
                  source: { type: "string", description: "fill のときの出典" },
                  reason: { type: "string", description: "delete-row / unconfirmed の理由" },
                  candidates: {
                    type: "array",
                    description: "unconfirmed のときの候補値",
                    items: {
                      type: "object",
                      properties: {
                        value: { type: "string" },
                        source: { type: "string" },
                      },
                      required: ["value", "source"],
                    },
                  },
                },
                required: ["slot", "action"],
              },
            },
            blockDeletes: {
              type: "array",
              description:
                "議案ブロック等の複数段落削除。" +
                "**個別の slot 削除には使わない (それは slotDecisions[delete-row] でやる)**。" +
                "議案 2 全体を消す等、複数段落にまたがる範囲削除でのみ使用",
              items: {
                type: "object",
                properties: {
                  startAnchor: {
                    type: "string",
                    description:
                      "削除開始 (= 削除する最初の段落) に含まれる文字列。例: '議案２　取締役の報酬に関する件'",
                  },
                  endAnchor: {
                    type: "string",
                    description:
                      "**削除しない次の段落** (= 残す段落) に含まれる文字列。" +
                      "例: 議案2 を消すなら '議案３' (次の議案ヘッダ)。" +
                      "重要: endAnchor の段落自体は **削除されない**。startAnchor の段落から endAnchor 段落の直前までを削除。" +
                      "省略時は文書末尾まで削除",
                  },
                  reason: { type: "string" },
                },
                required: ["startAnchor", "reason"],
              },
            },
            rowInsertions: {
              type: "array",
              description:
                "新規行挿入 (ラベル変換等)。docx のみ、xlsx には使わない。" +
                "**1 行 = 1 entry**。3 行挿入したいなら entry を 3 個作る (1 entry に複数行を \\n で詰め込まない)",
              items: {
                type: "object",
                properties: {
                  afterSlot: {
                    type: "string",
                    description:
                      "この slot を含む行の直後に挿入。" +
                      "**必ずテンプレに存在する slot 名** (★label★ の中身)。" +
                      "「同意欄」「（乙）」みたいな固定テキストは指定不可、必ず既存 slot を指定すること。" +
                      "rowInsertions の前の entry で作った新ラベルも指定可 (連鎖挿入)",
                  },
                  template: {
                    type: "string",
                    description:
                      "行のテンプレ文字列 (★新ラベル★ 含む)。" +
                      "**1 段落のテキストのみ**。改行 (\\n) を含めない。複数段落挿入したい場合は entry を分ける",
                  },
                  fills: {
                    type: "array",
                    description: "template 内の ★新ラベル★ ごとの値",
                    items: {
                      type: "object",
                      properties: {
                        slot: { type: "string" },
                        value: { type: "string" },
                        source: { type: "string" },
                      },
                      required: ["slot", "value"],
                    },
                  },
                  reason: { type: "string" },
                },
                required: ["afterSlot", "template", "fills", "reason"],
              },
            },
            textReplaces: {
              type: "array",
              description: "テキスト一括置換 (議案番号繰り上げ等)。docx のみ",
              items: {
                type: "object",
                properties: {
                  anchor: { type: "string" },
                  replacement: { type: "string" },
                  reason: { type: "string" },
                },
                required: ["anchor", "replacement", "reason"],
              },
            },
          },
          required: ["templateFile", "slotDecisions", "blockDeletes"],
        },
      },
    },
    required: ["documents"],
  },
};

// thread.phase2Decisions を更新する小ヘルパー。
async function savePhase2Decisions(companyId: string, threadId: string, decisions: Phase2Decisions): Promise<void> {
  try {
    const crypto = await import("crypto");
    const hash = crypto.createHash("md5").update(companyId).digest("hex");
    const filePath = path.join(process.cwd(), "data", "chat-threads", hash, `${threadId}.json`);
    const raw = await fs.readFile(filePath, "utf-8");
    const thread = JSON.parse(raw);
    thread.phase2Decisions = decisions;
    thread.updatedAt = new Date().toISOString();
    await fs.writeFile(filePath, JSON.stringify(thread, null, 2), "utf-8");
  } catch (e) {
    console.error("[analyze] savePhase2Decisions failed:", e);
  }
}

// rowInsertions の整合性検証: template の ★label★ が fills に対応 entry を持つか。
// 無ければ空 fill を auto-add して produce-v2 で ★ がマーカー残骸として残らないようにする。
function validateRowInsertions(decisions: Phase2Decisions): void {
  for (const doc of decisions.documents) {
    if (!doc.rowInsertions) continue;
    for (const ins of doc.rowInsertions) {
      const labelsInTemplate = [...(ins.template || "").matchAll(/★([^★]+)★/g)].map((m) => m[1]);
      const filledSlots = new Set((ins.fills || []).map((f) => f.slot));
      for (const lbl of labelsInTemplate) {
        if (!filledSlots.has(lbl)) {
          console.warn(`[analyze] rowInsertion missing fill for "★${lbl}★" in template "${ins.template}"`);
          ins.fills = ins.fills || [];
          ins.fills.push({ slot: lbl, value: "", source: "(自動補完: AI が fill を出し忘れた)" });
        }
      }
    }
  }
}

export async function POST(request: NextRequest) {
  const { companyId, threadId, templateFolderPath, previousQA } = (await request.json()) as {
    companyId: string;
    threadId: string;
    templateFolderPath?: string;
    previousQA?: { question: string; answer: string }[];
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find((c) => c.id === companyId);
  if (!company) {
    return new Response(JSON.stringify({ error: "会社が見つかりません" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Phase 1 (organize) 完了が前提
  let aiMessages = await loadAiMessages(company.id, threadId);
  if (!hasStage(aiMessages, "organize")) {
    return new Response(JSON.stringify({ error: "案件整理 (Phase 1) が完了していません" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  aiMessages = truncateBeforeStage(aiMessages, "analyze");

  // === テンプレ本文を読み込む (markedText 構築) ===
  const templateBlocks: string[] = [];
  const templateStructures: { templateFile: string; markedText: string }[] = [];
  if (templateFolderPath) {
    try {
      const { getMarkedDocumentTextWithSlots } = await import("@/lib/docx-marker-parser");
      const { getXlsxMarkedTextWithSlots } = await import("@/lib/xlsx-marker-parser");
      const { ensureDocxLabels, ensureXlsxLabels } = await import("@/lib/template-labels");

      const tpFiles = await readAllFilesInFolder(templateFolderPath);
      for (const f of tpFiles) {
        if (f.name.endsWith(".txt") || f.name.endsWith(".md")) continue;
        if (f.name.endsWith(".labels.json")) continue;
        if (f.base64) continue;

        const ext = f.name.toLowerCase().split(".").pop() || "";
        let markedText = "";

        if (ext === "docx" || ext === "docm") {
          try {
            const buf = await fs.readFile(f.path);
            const { text } = getMarkedDocumentTextWithSlots(buf);
            const labels = await ensureDocxLabels(f.path);
            const labelById = new Map<number, string>();
            for (const s of labels?.slots || []) {
              if (s.label && s.label !== "不明") labelById.set(s.slotId, s.label);
            }
            markedText = text.replace(/［要入力_(\d+)］/g, (_, idStr) => {
              const id = Number(idStr);
              const lbl = labelById.get(id) || `要入力_${id}`;
              return `★${lbl}★`;
            });
          } catch (e) {
            console.warn(`[analyze] docx marker read failed (${f.name}):`, e instanceof Error ? e.message : e);
          }
        } else if (ext === "xlsx" || ext === "xlsm" || ext === "xls") {
          try {
            const buf = await fs.readFile(f.path);
            const { text } = getXlsxMarkedTextWithSlots(buf);
            const labels = await ensureXlsxLabels(f.path);
            const labelById = new Map<number, string>();
            for (const s of labels?.slots || []) {
              if (s.label && s.label !== "不明") labelById.set(s.slotId, s.label);
            }
            markedText = text.replace(/［要入力_(\d+)］/g, (_, idStr) => {
              const id = Number(idStr);
              const lbl = labelById.get(id) || `要入力_${id}`;
              return `★${lbl}★`;
            });
          } catch (e) {
            console.warn(`[analyze] xlsx marker read failed (${f.name}):`, e instanceof Error ? e.message : e);
          }
        }

        if (!markedText && f.content) markedText = f.content;
        if (!markedText) continue;

        // 連続する (空) 行を 1 個に圧縮 (トークン節約)
        markedText = markedText.replace(/(\(空\)\n)(\(空\)\n)+/g, "(空)\n");

        templateBlocks.push(`### ${f.name}\n\`\`\`\n${markedText}\n\`\`\``);
        templateStructures.push({ templateFile: f.name, markedText });
      }
    } catch (e) {
      console.warn("[analyze] template read failed:", e instanceof Error ? e.message : e);
    }
  }
  const templateBodyBlock =
    templateBlocks.length > 0
      ? `\n## テンプレート本文 (各書類の中身。★ラベル★ が埋めるべき穴。slot 直前直後の文字を必ず確認)

**\`(空)\` 行の意味**: テンプレ内に **空段落** があると \`(空)\` と表示される。
セクション区切りとして意味があるので、削除対象に含めない限り保持する。

${templateBlocks.join("\n\n")}\n`
      : "\n## テンプレート本文\n(読めませんでした)\n";

  const qaBlock =
    previousQA && previousQA.length > 0
      ? `\n## Phase 1 確認質問と回答 (ユーザー確定済み)\n${previousQA
          .map((qa, i) => `${i + 1}. Q: ${qa.question}\n   A: ${qa.answer}`)
          .join("\n")}\n`
      : "\n## Phase 1 確認質問と回答\n(回答なし)\n";

  // === Call 1 用プロンプト (推論 md 出力のみ) ===
  // JSON 出力は Call 2 でやるので、ここでは推論 md だけに集中させる。
  const reasoningPrompt = `## あなたが今やること

テンプレ書類を読んで、**各 slot をどうするか、どの行/ブロックを削除するか、ラベル変換が要るか** を推論する。
**JSON は出力しなくていい**。推論 md だけ書く (次のターンで別 AI が JSON 化する)。

${qaBlock}
${templateBodyBlock}

## あなたが決めるべき判断 (4 種類)

各書類について、必要なものだけ:

1. **slotDecisions** (テンプレ既存の★label★ への指示)
   - 各 slot に action を 1 つ: \`fill\` (値を入れる) / \`delete-row\` (行ごと削除) / \`unconfirmed\` (確認質問)
   - \`fill\` のとき value (最終形式) と source (出典) を書く
   - 「テンプレに slot はあるが該当しない」(例: 引受人が法人なのに「乙の無限責任組合員」slot がある) は delete-row
2. **blockDeletes** (議案ブロック等の複数段落削除)
   - startAnchor + endAnchor で範囲指定
   - 議案を削除したら textReplaces で繰り上げも指示
3. **rowInsertions** (新規行挿入 — ラベル変換用)
   - 既存ラベルと違う形式に変えたい場合に delete-row + rowInsertions で対応
   - ⚠ 既存テンプレに同じ意味のラベルがある場合は rowInsertions 不要、fill だけで OK (重複行事故防止)
4. **textReplaces** (テキスト一括置換 — 議案番号繰り上げ等)

## 重要原則

- **設計原則 = 「行一つにつき 1 指定」**。書換 (rewrite) アクションは存在しない
- ラベル変換 (例: 主たる事務所 → 本店) は **delete-row + rowInsertions** で実現
- xlsx は **fills のみ** 使う (delete-row / rowInsertions / blockDeletes / textReplaces は禁止)
- value に **指示文・注記・説明文を書かない** ("【法人引受人のため本行削除】" 等は全部 NG)
- 共通ルールにラベル変換ルールがあれば従う

## value (fill) のルール

- テンプレの slot 前後を見て、既に肩書き/単位が書かれていれば value から外す
- 値は最終形式 (令和8年5月29日 / 株式会社JINGS / 1,000,000 等)
- 指示文・条件分岐は絶対書かない

## outputLabel (株主毎複製等)

「株主毎に 1 通ずつ」のように **同じテンプレから複数出力** する場合:
- templateFile は同じファイル名のまま
- outputLabel で識別 (例: "藤崎用", "株式会社先端用")
- 各 outputLabel で documents の entry を分ける

## 推論 md の書き方

書類ごとに「どの slot をどう処理するか」を箇条書きで明示する。

例:
\`\`\`
### 1.取締役決定書.docx

- ★契約書の作成日★ → fill: "令和8年5月22日" (案件スケジュール表)
- ★選任取締役1人目の氏名★ → fill: "藤崎 伊久哉" (Phase 1 確認回答)
- ★選任取締役2人目の氏名★ → delete-row (今回 1 名のみ)
- 議案2 ブロック → blockDelete (startAnchor:"議案2", endAnchor:"議案3", 報酬議案不要)
- textReplaces: 議案3 → 議案2

### 2-1.提案書兼同意書.docx

(株主 9 名分、株主毎に outputLabel 付けて 9 entry)

#### outputLabel: "藤崎用"
- ★株主の氏名★ → fill: "藤崎 伊久哉"
- ★株主の住所★ → fill: "..."
- ★議案の議決権★ → fill: "49,000"
- ...
\`\`\`

**JSON は出さない。後段の AI が推論を読んで JSON 化する。**`;

  const messagesWithUserTurn = appendUserTurn(aiMessages, reasoningPrompt, "analyze");

  try {
    const encoder = new TextEncoder();
    const send = (controller: ReadableStreamDefaultController, data: object) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    };
    const stream = new ReadableStream({
      async start(controller) {
        try {
          if (templateStructures.length > 0) {
            send(controller, { type: "structures", structures: templateStructures });
          }

          // ============== Call 1: Sonnet 4.6 で推論 ==============
          send(controller, { type: "stage", stage: "reasoning" });
          const reasoningStream = client.messages.stream({
            model: REASONING_MODEL,
            max_tokens: 16384,
            temperature: 0,
            messages: toAnthropicMessages(messagesWithUserTurn) as Anthropic.MessageParam[],
          });

          let reasoningText = "";
          for await (const event of reasoningStream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              reasoningText += event.delta.text;
              send(controller, { type: "text", text: event.delta.text });
            }
          }
          try {
            const final = await reasoningStream.finalMessage();
            logTokenUsage(`/api/document-templates/analyze (Call 1 reasoning)`, REASONING_MODEL, final.usage);
          } catch { /* ignore */ }

          // ============== Call 2: Sonnet 4.6 で JSON 化 (Tool Use) ==============
          send(controller, { type: "stage", stage: "structuring" });

          const jsonPrompt = `## あなたの仕事

下の「推論メモ」と「テンプレ本文」を読んで、submit_phase2_decisions ツールを呼び出して
Phase 2 の構造化決定を提出してください。

**推論を改変するな**。推論メモに書かれた判断を **正確に** ツールの引数に転記する。あなたは形式変換だけ。
新しい判断はしない。

${templateBodyBlock}

---

## 推論メモ (Sonnet 4.6 が判断したもの)

${reasoningText}

---

## ツール呼び出しの正しい使い方 (重要)

### slotDecisions (★label★ への指示)

- 推論メモに書かれた slot 1 つ 1 つを slotDecisions の entry にする
- 「delete-row」と書いてあれば \`action: "delete-row"\`
- 「fill: "X"」と書いてあれば \`action: "fill", value: "X"\`
- 推論メモに書かれてない slot は documents[].slotDecisions に含めない (空欄 fill しない)
- **個別の slot 行を消す** のは slotDecisions[delete-row] でやる (blockDeletes ではない)

### blockDeletes (複数段落の範囲削除)

**individual slot の delete-row には使わない**。議案2 ブロック全体みたいに、**複数段落** を範囲削除するときだけ。

\`startAnchor\` = 削除する **最初の段落** に含まれる文字列
\`endAnchor\` = 削除した **直後に残す段落** に含まれる文字列 (この段落は削除されない)

❌ 悪い例: \`startAnchor="主たる事務所", endAnchor="★主たる事務所所在地★"\`
   → 同じ行を指してる。これは個別 slot 削除なので **slotDecisions[delete-row]** でやる

✅ 良い例: \`startAnchor="議案２　取締役の報酬", endAnchor="議案３"\`
   → 議案2 から議案3 の手前までを範囲削除

### rowInsertions (新規行挿入)

**1 行 = 1 entry**。3 行挿入したいなら entry を 3 個作る。

❌ 悪い例: \`template="本店 ★...★\\n商号 ★...★\\n代表取締役 ★...★"\` (\\n で詰め込み)
   → これは「1 段落の中に改行入りテキスト」になり、3 行として展開されない

✅ 良い例: rowInsertions に 3 entry:
   1. \`{afterSlot: "甲の代表取締役", template: "本店 ★乙の本店所在地★", fills: [...]}\`
   2. \`{afterSlot: "乙の本店所在地", template: "商号 ★乙の商号★", fills: [...]}\` (連鎖)
   3. \`{afterSlot: "乙の商号", template: "代表取締役 ★乙の代表取締役★", fills: [...]}\` (連鎖)

\`afterSlot\` は **必ずテンプレに存在する slot 名** (★label★ の中身) または **前の entry で作った新ラベル名**。
固定テキスト ("（乙）" "同意欄" 等) は指定不可。

### templateFile / outputLabel

- \`templateFile\` はクリーンな物理ファイル名 (例: "2-1.提案書兼同意書.docx")
- 株主毎複製等は \`outputLabel\` で区別。documents 配列に N 個の entry を作る (templateFile は同じまま)`;

          const decisionsResponse = await client.messages.create({
            model: JSON_MODEL,
            max_tokens: 16384,
            temperature: 0,
            tools: [PHASE2_DECISIONS_TOOL],
            tool_choice: { type: "tool", name: "submit_phase2_decisions" },
            messages: [{ role: "user", content: jsonPrompt }],
          });
          logTokenUsage(`/api/document-templates/analyze (Call 2 json)`, JSON_MODEL, decisionsResponse.usage);

          // tool_use ブロックから decisions 取得
          const toolBlock = decisionsResponse.content.find(
            (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use"
          );
          let decisions: Phase2Decisions | null = null;
          if (toolBlock?.name === "submit_phase2_decisions") {
            decisions = toolBlock.input as Phase2Decisions;
          }

          if (decisions && Array.isArray(decisions.documents)) {
            validateRowInsertions(decisions);
            await savePhase2Decisions(company.id, threadId, decisions);
            const summary = decisions.documents.map((d: Phase2DocumentDecision) => {
              const fills = d.slotDecisions.filter((s) => s.action === "fill").length;
              const dels = d.slotDecisions.filter((s) => s.action === "delete-row").length;
              const uncs = d.slotDecisions.filter((s) => s.action === "unconfirmed").length;
              const ins = d.rowInsertions?.length ?? 0;
              const repl = d.textReplaces?.length ?? 0;
              return `${d.templateFile}: fill ${fills} / delete-row ${dels} / unconfirmed ${uncs} / blockDeletes ${d.blockDeletes.length} / rowInsertions ${ins} / textReplaces ${repl}`;
            }).join("; ");
            console.log(`[analyze] decisions saved: ${summary}`);
            send(controller, { type: "decisions", decisions });
          } else {
            console.warn("[analyze] Tool Use returned no decisions");
            send(controller, { type: "decisions", decisions: null });
          }

          // aiMessages に推論ターンを保存 (Call 2 の結果は保存しない、必要なら phase2Decisions から復元)
          const finalMessages = appendAssistantTurn(messagesWithUserTurn, reasoningText, "analyze");
          await saveAiMessages(company.id, threadId, finalMessages);

          send(controller, { type: "done" });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error("[analyze] stream failed:", errMsg);
          try {
            send(controller, { type: "error", error: errMsg });
          } catch { /* closed */ }
        } finally {
          try {
            controller.close();
          } catch { /* closed */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "analyze 失敗" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
