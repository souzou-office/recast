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

// 新スキーマ Tool: 段落単位の changes 配列を返す。
// 旧 4 配列 (slotDecisions / blockDeletes / rowInsertions / textReplaces) を 1 つに統合し、
// 「1 段落 1 op」が構造的に保証される設計に。指示同士の衝突が発生不可能になる。
const PHASE2_CHANGES_TOOL: Anthropic.Tool = {
  name: "submit_phase2_changes",
  description:
    "各書類のテンプレに対する段落単位の変更操作リスト (changes) を提出する。" +
    "推論で確定した「どの段落をどうするか」を段落番号ベースで指定する。" +
    "1 段落につき指示は 1 つだけ (同じ idx を複数の change で指定しない)。",
  input_schema: {
    type: "object",
    properties: {
      documents: {
        type: "array",
        description: "書類ごとの changes。同じテンプレから複数出力する場合は outputLabel で区別して複数 entry を持つ",
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
            changes: {
              type: "array",
              description: "段落単位の操作リスト。1 段落 1 op を厳守 (同じ idx を複数 entry に書かない)",
              items: {
                type: "object",
                properties: {
                  idx: {
                    type: "number",
                    description: "段落番号 (1-indexed)。markedText の 「段落N: ...」 の N をそのまま使う",
                  },
                  action: {
                    type: "string",
                    enum: ["delete", "fill", "rewrite", "insertAfter"],
                    description:
                      "delete=段落削除 (範囲削除は until 指定) / " +
                      "fill=★label★ を値で置換 (slot + value 必須) / " +
                      "rewrite=段落のテキスト全体を新テキストに差し替え (text 必須) / " +
                      "insertAfter=この段落の直後に新段落を挿入 (text 必須)",
                  },
                  until: {
                    type: "number",
                    description: "delete のとき範囲削除する終端段落番号 (含む)。単独削除なら省略",
                  },
                  slot: {
                    type: "string",
                    description: "fill のとき置換する ★label★ の中身 (★は不要、label 名のみ。labels.json の label と完全一致)",
                  },
                  value: {
                    type: "string",
                    description: "fill のとき置換後の値 (最終形式、単位込み)",
                  },
                  text: {
                    type: "string",
                    description: "rewrite / insertAfter のとき完成形テキスト (固定文 + 値を結合して AI が書く)",
                  },
                  reason: {
                    type: "string",
                    description: "判断理由 (任意、デバッグ用)",
                  },
                },
                required: ["idx", "action"],
              },
            },
          },
          required: ["templateFile", "changes"],
        },
      },
    },
    required: ["documents"],
  },
};

// 旧 Phase 2 Tool (互換のため残置)。新規 AI 出力には使わない。
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
                    enum: ["fill", "delete-row"],
                    description: "fill=値を入れる / delete-row=行ごと削除。「迷う」は Phase 2-A の質問で既に解決済みなので、ここでは2択のみ",
                  },
                  value: { type: "string", description: "fill のときの値 (最終形式)" },
                  source: { type: "string", description: "fill のときの出典" },
                  reason: { type: "string", description: "delete-row の理由" },
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

        // slot 名自体はテンプレ内・slotDecisions 出力で完全一致させる必要があるので、
        // ★label★ には label のみ入れる (拡張するとマッチ崩れて produce-v2 で fill 当たらず空欄化)。
        // format / sourceHint は別途 slot 一覧表として プロンプトに添付して AI に渡す (下流参照)。
        const slotInfoList: { label: string; format?: string; sourceHint?: string }[] = [];

        if (ext === "docx" || ext === "docm") {
          try {
            const buf = await fs.readFile(f.path);
            const { text } = getMarkedDocumentTextWithSlots(buf);
            const labels = await ensureDocxLabels(f.path);
            const labelById = new Map<number, string>();
            for (const s of labels?.slots || []) {
              if (s.label && s.label !== "不明") {
                labelById.set(s.slotId, s.label);
                slotInfoList.push({ label: s.label, format: s.format, sourceHint: s.sourceHint });
              }
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
              if (s.label && s.label !== "不明") {
                labelById.set(s.slotId, s.label);
                slotInfoList.push({ label: s.label, format: s.format, sourceHint: s.sourceHint });
              }
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

        // slot 補足表: ★label★ の書式と推定出典を別表として AI に渡す。
        // ★label★ 自体は元のままで produce-v2 とマッチ。書式/出典は表で参照させる。
        const slotTableLines = slotInfoList
          .filter(s => s.format || s.sourceHint)
          .map(s => {
            const parts: string[] = [];
            if (s.format) parts.push(`書式 \`${s.format}\``);
            if (s.sourceHint) parts.push(`出典: ${s.sourceHint}`);
            return `- \`★${s.label}★\` → ${parts.join(" / ")}`;
          });
        const tableSection = slotTableLines.length > 0
          ? `\n\n**${f.name} の slot 補足** (★label★ ごとの書式と推定出典):\n${slotTableLines.join("\n")}\n`
          : "";

        templateBlocks.push(`### ${f.name}\n\`\`\`\n${markedText}\n\`\`\`${tableSection}`);
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

加えて、テンプレ内容と実体 (案件資料・基本情報・案件整理結果) との **不整合・齟齬があれば必ず指摘する**。
具体的には、推論 md の各書類セクション内に「⚠ テンプレと実体の齟齬」サブセクションを設けて、次のような項目を列挙:
- テンプレに **古い情報** が残っている (旧役員名・旧本店・旧議案 等)
- **案件タイプと関係ない議案ブロック** がある (例: 取締役就任案件なのに役員報酬議案が含まれる)
- **必要なはずの slot が欠落** している
- **構造上の問題** で単純な fill / delete では対応できない箇所
- テンプレに記載された前提と案件の **状況が違う** 部分
- **書類間の役割重複** (例: 取締役決定書で代表取締役を選定する設計なら、株主総会の議事録に
  代取選任議案があれば二重決議となり不要 → 株主総会側の議案を削除提案)
  - 「この判断はこの書類でやる」「あの書類では同じ判断はしない」という **役割分担**を意識する
  - 案件タイプ + 書類名 + 案件整理結果から、どの書類が何を担当すべきかを判断

齟齬を見つけたら ⚠ 印を付けて指摘し、対応方針 (どの slot を削除 / 置換 / そのまま) も併記する。
齟齬が無ければサブセクション自体を省略してよい。

${qaBlock}
${templateBodyBlock}

## あなたが決めるべき判断 (4 種類)

各書類について、必要なものだけ:

1. **slotDecisions** (テンプレ既存の★label★ への指示)
   - 各 slot に action を 1 つ: \`fill\` (値を入れる) / \`delete-row\` (行ごと削除)
   - \`fill\` のとき value (最終形式) と source (出典) を書く
   - 「テンプレに slot はあるが該当しない」(例: 引受人が法人なのに「乙の無限責任組合員」slot がある) は delete-row
   - **「迷う」「確認したい」slot はもう存在しない前提**。Phase 2-A の質問で既に確定済み。
     previousQA に答えがあるはずなので、それを反映して fill する
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

## slot 補足表の読み方

各書類のテンプレ本文の下に **「○○.docx の slot 補足」** という表が付いている。
\`★label★\` ごとに **書式** と **推定出典** が書かれている。

例:
\`\`\`
- \`★議決権を行使できる株主の数★\` → 書式 \`○名\` / 出典: 基本情報の株主リスト人数
- \`★取締役の月額報酬額★\` → 書式 \`○万円\` / 出典: 報酬に関する合意書または（ユーザー確認）
\`\`\`

- **書式** (○名, ○万円, 令和○年○月○日 など) は value をその形式で揃える指示。
  「○名」とあれば value は「2名」(単位『名』含む)、「○万円」とあれば「100万円」のように作る。
  単位を勝手に省略しない。
- **出典** は値をどこから取るかのヒント。「基本情報の役員」「案件スケジュール表」など。
  出典が「ユーザー確認」を含む slot は、Phase 2-A の質問で既に確認済みなのでその回答を反映。

**重要**: slotDecisions の \`slot\` フィールドには ★label★ の中身（label 名）だけを書く。
書式や出典を slot 名に含めない (例: 「議決権を行使できる株主の数」と書く。
「議決権を行使できる株主の数（○名）」のように補足を含めない)。

## value (fill) のルール

- テンプレの slot 前後を見て、既に肩書き/単位が書かれていれば value から外す
- 値は最終形式 (令和8年5月29日 / 株式会社JINGS / 1,000,000 等)
- 指示文・条件分岐は絶対書かない

## xlsx の多行セル ★label★ について (重要)

xlsx の **セル全体が 1 slot** として塗られていて、元セルに **改行が含まれている** ケース
(例: 株主リスト 下部の証明者情報 = 日付/会社名/代表取締役 が縦並びで 1 セル):

- value は **\\n (改行) を含めて** 出力すること
- 元の改行構造をそのまま保つ
- ❌ 悪い例: value="令和８年５月２９日 株式会社○○ 代表取締役 ○○○○" (空白区切り 1 行)
- ✅ 良い例: value="令和８年５月２９日\\n株式会社○○\\n代表取締役　○○○○" (\\n で改行)

これで Excel に書き戻された時に元の縦並びを保つ。

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

**JSON は出さない。後段の AI が推論を読んで JSON 化する。**

## 出力フォーマット注意

- **「ターン1:」「ターン2:」みたいな番号ラベルは出さない**。書類別の見出し (### 1.取締役決定書.docx 等) だけ書く
- 推論の中身に集中する。会話番号付けは不要`;

  const messagesWithUserTurn = appendUserTurn(aiMessages, reasoningPrompt, "analyze");

  try {
    const encoder = new TextEncoder();
    const send = (controller: ReadableStreamDefaultController, data: object) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    };
    const stream = new ReadableStream({
      async start(controller) {
        try {
          send(controller, { type: "stage", stage: "reading-templates" });
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

下の「推論メモ」と「テンプレ本文」を読んで、**submit_phase2_changes** ツールを呼び出して
Phase 2 の構造化決定を提出してください。

**推論を改変するな**。推論メモに書かれた判断を **正確に** ツールの引数に転記する。
あなたは形式変換だけ。新しい判断はしない。

${templateBodyBlock}

---

## 推論メモ (Sonnet 4.6 が判断したもの)

${reasoningText}

---

## ツール呼び出しの正しい使い方 (重要)

各書類について \`changes\` 配列を作る。1 段落 1 op が大原則 (同じ idx を複数 change で指定しない)。

### action 別の使い方

**delete: 段落削除**
- 単独削除: \`{ idx: 10, action: "delete" }\`
- 範囲削除 (議案ブロック等): \`{ idx: 10, action: "delete", until: 17 }\` (段落 10〜17 を一括削除)
- 推論メモの「blockDeletes 議案2 → 議案3 の前まで」は、テンプレ本文で段落番号を特定して
  \`{ idx: 議案2 の段落番号, action: "delete", until: 議案3 の段落番号 - 1 }\` に変換

**fill: ★label★ を値で置換**
- \`{ idx: 25, action: "fill", slot: "記名押印する代表取締役の氏名", value: "藤崎　伊久哉" }\`
- slot は ★label★ の中身 (★は不要)。labels.json の label と完全一致させる
- 段落番号は ★label★ が含まれる段落の番号

**rewrite: 段落全体を新テキストで差し替え**
- 議案番号繰り上げ等: \`{ idx: 17, action: "rewrite", text: "議案２　代表取締役選任の件" }\`
- text は **完成形** (固定文 + 値を AI が結合して書く)

**insertAfter: 段落の直後に新段落を追加**
- \`{ idx: 7, action: "insertAfter", text: "取締役　古澤　利成" }\`
- 複数行挿入したいなら entry を複数並べる (1 entry = 1 段落)

### よくある変換パターン

旧スキーマの slotDecisions / blockDeletes / rowInsertions / textReplaces → 新 changes:

| 旧 | 新 |
|--|--|
| slotDecisions[fill] | \`{ idx, action: "fill", slot, value }\` |
| slotDecisions[delete-row] | \`{ idx, action: "delete" }\` |
| blockDeletes (start/end anchor) | \`{ idx, action: "delete", until }\` (テンプレ本文で段落番号を特定) |
| rowInsertions | \`{ idx, action: "insertAfter", text }\` (text は値込みの完成形) |
| textReplaces (議案番号繰り上げ) | \`{ idx, action: "rewrite", text }\` (text は新タイトル全体) |

### templateFile / outputLabel

- \`templateFile\` はクリーンな物理ファイル名 (例: "2-1.提案書兼同意書.docx")
- 株主毎複製等は \`outputLabel\` で区別。documents 配列に N 個の entry を作る (templateFile は同じまま)`;

          const decisionsResponse = await client.messages.create({
            model: JSON_MODEL,
            max_tokens: 16384,
            temperature: 0,
            tools: [PHASE2_CHANGES_TOOL],
            tool_choice: { type: "tool", name: "submit_phase2_changes" },
            messages: [{ role: "user", content: jsonPrompt }],
          });
          logTokenUsage(`/api/document-templates/analyze (Call 2 changes)`, JSON_MODEL, decisionsResponse.usage);

          // tool_use ブロックから changes 取得
          const toolBlock = decisionsResponse.content.find(
            (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use"
          );
          let decisions: Phase2Decisions | null = null;
          if (toolBlock?.name === "submit_phase2_changes") {
            // 新スキーマ: documents[].changes が入ってる
            decisions = toolBlock.input as Phase2Decisions;
          }

          if (decisions && Array.isArray(decisions.documents)) {
            send(controller, { type: "stage", stage: "validating" });
            await savePhase2Decisions(company.id, threadId, decisions);
            // 新スキーマ: changes 配列の各 action を集計
            const summary = decisions.documents.map((d: Phase2DocumentDecision) => {
              const changes = d.changes || [];
              const fills = changes.filter((c) => c.action === "fill").length;
              const dels = changes.filter((c) => c.action === "delete").length;
              const rewrites = changes.filter((c) => c.action === "rewrite").length;
              const inserts = changes.filter((c) => c.action === "insertAfter").length;
              return `${d.templateFile}: fill ${fills} / delete ${dels} / rewrite ${rewrites} / insertAfter ${inserts} (changes 計 ${changes.length})`;
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
