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
//   Call 2: Sonnet 4.6 が推論を読んで Tool Use で構造化 JSON を生成 (schema 強制)
//
//   Call 2 は **書類ごとに Promise.all で並列実行**。理由:
//     - 全書類分まとめて 1 回で出させると、株主数 × 書類数で changes が 300+ op になり
//       16k tokens を超えて JSON が途中で切れる事故が起きた (Polaris で 380 op → max_tokens 張り付き)
//     - 書類ごとに分ければ 1 call あたり 50-60 op (≈ 3-4k tokens) で余裕
//     - 並列なので時間は増えない (むしろ短縮可能性あり)
//     - 書類間整合性は Call 1 reasoning で取れてるので Call 2 は転記作業のみ
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
    "1 段落につき指示は 1 つだけ (同じ idx を複数の change で指定しない)。" +
    "【重要】op 数を減らす最適化を勝手にやらない。ラベル変換 (delete + insertAfter のセット) で" +
    "元のラベルが N 行 (本店/商号/代表取締役/議決権 等) ある場合、新ラベル M 行 (主たる事務所/" +
    "名称/無限責任組合員/組合員/代表取締役/議決権 等) を **insertAfter で 1 行ずつ全て** 指示する。" +
    "「主たる事務所だけ書けば十分」みたいな省略は禁止。元の情報項目を全て新ラベルで再現すること。",
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
  // templateBlocks は Call 1 (全書類分結合) と Call 2 (書類ごとに分割) の両方で使うため、
  // ファイル名と本文をペアで保持する。Call 1 では join、Call 2 では Map で引く。
  const templateBlocks: { templateFile: string; body: string }[] = [];
  const templateStructures: { templateFile: string; markedText: string }[] = [];
  if (templateFolderPath) {
    try {
      const { getMarkedDocumentTextWithSlots } = await import("@/lib/docx-marker-parser");
      const { getXlsxMarkedTextWithSlots } = await import("@/lib/xlsx-marker-parser");
      const { ensureDocxLabels, ensureXlsxLabels } = await import("@/lib/template-labels");
      const { addMarkedTextNumbering } = await import("@/lib/produce-edits");

      const tpFiles = await readAllFilesInFolder(templateFolderPath);
      for (const f of tpFiles) {
        if (f.name.endsWith(".txt") || f.name.endsWith(".md")) continue;
        if (f.name.endsWith(".labels.json")) continue;
        if (f.base64) continue;

        const ext = f.name.toLowerCase().split(".").pop() || "";
        let markedText = "";
        let docBuf: Buffer | null = null;
        const isXlsx = ext === "xlsx" || ext === "xlsm" || ext === "xls";

        // slot 名自体はテンプレ内・slotDecisions 出力で完全一致させる必要があるので、
        // ★label★ には label のみ入れる (拡張するとマッチ崩れて produce-v2 で fill 当たらず空欄化)。
        // format / sourceHint は別途 slot 一覧表として プロンプトに添付して AI に渡す (下流参照)。
        const slotInfoList: { label: string; format?: string; sourceHint?: string }[] = [];

        if (ext === "docx" || ext === "docm") {
          try {
            docBuf = await fs.readFile(f.path);
            const { text } = getMarkedDocumentTextWithSlots(docBuf);
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
        } else if (isXlsx) {
          try {
            docBuf = await fs.readFile(f.path);
            const { text } = getXlsxMarkedTextWithSlots(docBuf);
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

        // **重要**: produce-v2 と完全に同じ番号付けをする。
        // ズレると AI の changes の idx が全部誤爆する (例: 「下記の者を取締役として選任すること」が消える)。
        // 共通関数 addMarkedTextNumbering を使う。これで「段落N: 」/「行N: 」プレフィックスが付き、
        // 空段落は番号付けされない (= produce-v2 の getContentParagraphs と一致)。
        if (docBuf) {
          markedText = addMarkedTextNumbering(markedText, docBuf, isXlsx);
        }

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

        templateBlocks.push({ templateFile: f.name, body: `### ${f.name}\n\`\`\`\n${markedText}\n\`\`\`${tableSection}` });
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

${templateBlocks.map(b => b.body).join("\n\n")}\n`
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

不要な議案ブロックがあれば削除指示する (例: 取締役就任案件なのに役員報酬議案がある、
書類間で役割重複している議案ブロック等)。それ以外の齟齬解説は不要 (テンプレ自体の修正は
Phase 2 では対処できないため、ここで書いても無駄)。

**⚠ ラベル変換 (本店→主たる事務所、商号→名称 等) を判断する時の重要原則**:

元のラベル行ブロックを新形式に置き換える場合、推論段階で **新形式の全行を明示的に列挙する**。
例: 法人テンプレ「本店/商号/代表取締役/議決権 (4 行)」を組合用に変換するなら、推論メモに

\`\`\`
- 段落 36-39 (本店/商号/代表取締役/議決権) を delete range
- 段落 35 の後に以下 6 行を insertAfter で挿入:
  1. 主たる事務所 東京都...
  2. 名称 Deep30投資事業有限責任組合
  3. 無限責任組合員 Deep30有限責任事業組合
  4. 組合員 株式会社Deep30
  5. 代表取締役 川上登福
  6. 議案の議決権 １，５７８個
\`\`\`

と **必ず全行を箇条書きで列挙**する。「主たる事務所だけ書けばよい」みたいな省略は厳禁。
元のラベルが伝える情報項目 (所在地・名称・代表者・議決権数 等) を新ラベル群で全て表現する。

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
            max_tokens: 32000,
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
          // 並列化: 書類ごとに Promise.all で Call 2 を呼び出す。
          // 理由: 全書類分まとめて 1 回の Tool Use で出させると、株主数 × 書類数の展開で
          //       16k tokens を超えて JSON が途中で切れる事故が起きた (Polaris ケース)。
          //       書類ごとに分けると 1 call あたり changes 50-60 op (≈ 3-4k tokens) で余裕に収まる。
          //       並列なので時間は増えず、書類数が増えてもスケールする。
          //       書類間の整合性は Call 1 reasoning で全書類分まとめて取ってるため、
          //       Call 2 は書類ごとの「推論メモを構造化された JSON に転記する作業」のみ。
          send(controller, { type: "stage", stage: "structuring" });

          // 書類ごとに Tool Use を呼ぶサブルーチン
          const runPhase2ForDocument = async (
            templateFile: string,
            bodyForThisDoc: string
          ): Promise<Phase2DocumentDecision[]> => {
            const jsonPrompt = `## あなたの仕事

下の「推論メモ」と「テンプレ本文 (${templateFile})」を読んで、**submit_phase2_changes** ツールを呼び出して
**${templateFile}** についての Phase 2 構造化決定を提出してください。

**他の書類は無視。${templateFile} だけ。**

**推論を改変するな**。推論メモに書かれた判断を **正確に** ツールの引数に転記する。
あなたは形式変換だけ。新しい判断はしない。

## テンプレート本文 (${templateFile} のみ)

**\`(空)\` 行の意味**: テンプレ内に **空段落** があると \`(空)\` と表示される。
セクション区切りとして意味があるので、削除対象に含めない限り保持する。

${bodyForThisDoc}

---

## 推論メモ (Sonnet 4.6 が判断したもの。全書類分含むが、**${templateFile} に関する部分のみ抽出して構造化**)

${reasoningText}

---

## ツール呼び出しの正しい使い方 (重要)

\`documents\` 配列には **${templateFile} のみ** を入れる (他書類は他の call で処理される)。
\`changes\` 配列は 1 段落 1 op が大原則 (同じ idx を複数 change で指定しない)。

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

### ⚠ ラベル変換パターン (delete range + insertAfter の組み合わせ) — 必ず読め

ラベル行ブロックを別形式に置き換える時 (例: 法人テンプレを組合用に書き換える):

\`\`\`
元テンプレ (4 行):
段落 36: 本　　　　店　★...★
段落 37: 商　　　　号　★...★
段落 38: 代表取締役　★...★
段落 39: 議案の議決権　★...★

組合用に変換 (6 行):
（株主）　　主たる事務所　東京都...
　　　　　　名　　　　称　Deep30投資事業有限責任組合
　　　　　　無限責任組合員　Deep30有限責任事業組合
　　　　　　組合員　株式会社Deep30
　　　　　　代表取締役　川上登福
　　　　　　議案の議決権　１，５７８個
\`\`\`

正しい changes:
\`\`\`
{ idx: 36, action: "delete", until: 39 }                                         ← 元 4 行を範囲削除
{ idx: 35, action: "insertAfter", text: "（株主）　主たる事務所　東京都..." }    ← 新 1 行目
{ idx: 35, action: "insertAfter", text: "　　　名　　　　称　Deep30投資..." }    ← 新 2 行目
{ idx: 35, action: "insertAfter", text: "　　　無限責任組合員　Deep30有限..." }  ← 新 3 行目
{ idx: 35, action: "insertAfter", text: "　　　組合員　株式会社Deep30" }         ← 新 4 行目
{ idx: 35, action: "insertAfter", text: "　　　代表取締役　川上登福" }           ← 新 5 行目
{ idx: 35, action: "insertAfter", text: "　　　議案の議決権　１，５７８個" }     ← 新 6 行目
\`\`\`

**絶対やってはいけない最適化**:

❌ 1 行だけ書いて省略:
\`\`\`
{ idx: 36, action: "delete", until: 39 }
{ idx: 35, action: "insertAfter", text: "（株主）　主たる事務所　東京都..." }   ← これだけ！残り 5 行を勝手に省略
\`\`\`
→ 商号・代表取締役・議決権・組合員等の情報が完全に書類から消える事故。

❌ 元 N 行 → 新 1 行で「まとめる」:
\`\`\`
{ idx: 35, action: "insertAfter", text: "主たる事務所/名称/代表取締役/議決権" }
\`\`\`
→ 1 段落に全部書いても法務局には通らない。

**正解の原則**: 元のラベルが伝える **情報項目** (本店所在地/商号/代表者氏名/議決権数 等) を、
新ラベルの組み合わせで **1 つも省略せず** 表現する。op 数を減らす最適化を勝手にやらない。
delete range で消す段落数より少ない insertAfter は **ほぼ確実に省略バグ**。

### templateFile / outputLabel

- \`templateFile\` は **${templateFile}** (このまま使う)
- 株主毎複製等は \`outputLabel\` で区別。documents 配列に N 個の entry を作る (templateFile は同じまま)`;

            try {
              // max_tokens: 16384 (Anthropic non-streaming は ~21333 が上限)。
              // 並列化したので 1書類あたり changes 50-60 op (≈ 2-3k tokens) で 16k に余裕で収まる。
              const response = await client.messages.create({
                model: JSON_MODEL,
                max_tokens: 16384,
                temperature: 0,
                tools: [PHASE2_CHANGES_TOOL],
                tool_choice: { type: "tool", name: "submit_phase2_changes" },
                messages: [{ role: "user", content: jsonPrompt }],
              });
              logTokenUsage(
                `/api/document-templates/analyze (Call 2 changes: ${templateFile})`,
                JSON_MODEL,
                response.usage
              );
              if (response.stop_reason === "max_tokens") {
                console.warn(`[analyze] Call 2 for ${templateFile} hit max_tokens (${response.usage.output_tokens})`);
              }
              const toolBlock = response.content.find(
                (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use"
              );
              if (toolBlock?.name === "submit_phase2_changes") {
                const input = toolBlock.input as { documents?: Phase2DocumentDecision[] };
                return input.documents || [];
              }
              console.warn(`[analyze] Call 2 for ${templateFile}: Tool Use returned no decisions`);
              return [];
            } catch (e) {
              console.error(`[analyze] Call 2 for ${templateFile} failed:`, e instanceof Error ? e.message : e);
              return [];
            }
          };

          // 書類ごとに並列で Tool Use を呼ぶ
          const docResults = await Promise.all(
            templateBlocks.map((b) => runPhase2ForDocument(b.templateFile, b.body))
          );
          const decisions: Phase2Decisions = { documents: docResults.flat() };

          if (decisions.documents.length > 0) {
            send(controller, { type: "stage", stage: "validating" });
            await savePhase2Decisions(company.id, threadId, decisions);
            // 新スキーマ: changes 配列の各 action を集計
            const summary = decisions.documents.map((d: Phase2DocumentDecision) => {
              const changes = d.changes || [];
              const fills = changes.filter((c) => c.action === "fill").length;
              const dels = changes.filter((c) => c.action === "delete").length;
              const rewrites = changes.filter((c) => c.action === "rewrite").length;
              const inserts = changes.filter((c) => c.action === "insertAfter").length;
              return `${d.templateFile}${d.outputLabel ? `[${d.outputLabel}]` : ""}: fill ${fills} / delete ${dels} / rewrite ${rewrites} / insertAfter ${inserts} (計 ${changes.length})`;
            }).join("; ");
            console.log(`[analyze] decisions saved: ${summary}`);
            send(controller, { type: "decisions", decisions });
          } else {
            console.warn("[analyze] All Call 2 invocations returned no decisions");
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
