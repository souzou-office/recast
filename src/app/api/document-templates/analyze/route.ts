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
import type { Phase2Decisions, Phase2DocumentDecision, CaseAiMessage, CaseAiContentBlock } from "@/types";

const client = new Anthropic();
const REASONING_MODEL = "claude-sonnet-4-6";

// === エンジン切替 ===
// RECAST_ENGINE=officecli にすると Phase 2 が OfficeCLI コマンド出力モードに切り替わる。
// デフォルト (未設定 or "changes") は既存の changes スキーマで動く (後方互換)。
function useOfficeCliEngine(): boolean {
  return process.env.RECAST_ENGINE === "officecli";
}

// 仕分け式アーキテクチャ (Step A 確定値表 + ルール機械生成 + ai 退避) を使うか。
// officecli モード前提。RECAST_FILL_MODE=legacy で旧 (書類ごと AI 全生成) に戻せる。
function useClassificationMode(): boolean {
  return useOfficeCliEngine() && process.env.RECAST_FILL_MODE !== "legacy";
}

// === officecli モード用: 必要情報だけ抽出 ===
// aiMessages 全体を送ると 30k+ トークン (添付 PDF/画像、tool_use 往復、テンプレ二度送り 等)。
// Call 2 が必要なのは:
//   - Phase 1 (organize) の整理結果 (案件構造・登場人物・日程・値)
//   - Phase 2-A / 2-B (clarify) の Q&A 確定値 (表記揺れ等)
// これだけ抽出して 5-7k に圧縮し、cache_control で並列 cacheRead を効かせる。
function extractTextFromContent(content: string | CaseAiContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Extract<CaseAiContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function extractEssentialContext(
  aiMessages: CaseAiMessage[],
  organizeResult?: { markdown: string; structured: unknown } | null
): string {
  const blocks: string[] = [];

  // organizeResult.structured (構造化 JSON、案件の値) + markdown (整理結果、変換ルールの言及含む)
  // 両方渡す: structured は穴埋め値の参照用、markdown は「組合の本店→主たる事務所」みたいな
  // 変換ルール参照用。markdown を省くと AI が共通ルール④等を知らずラベル変換失敗する。
  if (organizeResult?.structured) {
    blocks.push(
      `## Phase 1 案件整理結果 (構造化 JSON)\n\n\`\`\`json\n${JSON.stringify(organizeResult.structured, null, 2)}\n\`\`\``
    );
  }
  if (organizeResult?.markdown) {
    blocks.push(
      `## Phase 1 案件整理結果 (markdown、共通ルールの言及・変換指示を含む)\n\n${organizeResult.markdown}`
    );
  }
  if (!organizeResult?.structured && !organizeResult?.markdown) {
    // フォールバック: aiMessages から最終 organize の text を抽出 (旧式)
    const organizeMsgs = aiMessages.filter((m) => m.stage === "organize" && m.role === "assistant");
    if (organizeMsgs.length > 0) {
      const last = organizeMsgs[organizeMsgs.length - 1];
      const text = extractTextFromContent(last.content);
      if (text.trim()) blocks.push(`## Phase 1 案件整理結果 (markdown)\n\n${text}`);
    }
  }

  // Phase 2-A / 2-B 確認質問と回答
  const qaMsgs = aiMessages.filter(
    (m) => m.stage === "clarify-procedural" || m.stage === "clarify"
  );
  if (qaMsgs.length > 0) {
    const qaText = qaMsgs
      .map((m) => {
        const text = extractTextFromContent(m.content);
        return text.trim() ? `[${m.role}]\n${text}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
    if (qaText) blocks.push(`## Phase 2-A / 2-B 確認質問と回答\n\n${qaText}`);
  }

  return blocks.join("\n\n---\n\n") || "(整理結果なし)";
}
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

// 最新スキーマ Tool (C 案): AI が officecli の用語そのままで commands を出す。
// recast 側は --prop key=value に組み立てて exec するだけ。中間翻訳テーブル不要。
//
// AI に渡す情報:
//   - officecli view text の出力 (各段落の @paraId と本文)
//   - officecli query 'run[highlight=yellow]' の出力 (★label★ 相当の位置と内容)
//   - Phase 1 案件整理 + Phase 2-A の Q&A
//   - 統一ルール
//
// AI が出す commands の典型例:
//   - set: 段落の find/replace でテキスト書き換え
//   - remove: 段落削除
//   - add: 段落 / コメント追加
const PHASE2_OFFICECLI_TOOL: Anthropic.Tool = {
  name: "submit_phase2_officecli",
  description:
    "各書類に対する OfficeCLI コマンドのリストを提出する。" +
    "recast は AI が出したコマンドを officecli の CLI 引数に組み立てて順次実行するだけ。" +
    "コマンドの構文は SKILL.md (https://officecli.ai/SKILL.md) に従う。" +
    "段落の特定には @paraId を必ず使う (位置番号は使うな、insert/delete でズレる)。" +
    "★label★ の書き換えは set + find/replace を使う。run 分割があっても find は run 境界を跨いで動く。" +
    "【トークン節約】各 op に判断理由 (reason) は書くな。Call 1 で reasoning は済んでる。" +
    "【docx の 1 op 集約】set は --prop を複数同時指定できる。" +
    "  例: { find: '令和８年２月１１日', replace: '令和８年６月１日', highlight: 'none' } で " +
    "text 置換 + 黄色ハイライト除去を 1 op で実行。" +
    "【xlsx は構造が違う — 重要】" +
    "  - パス: /SheetName/CellAddr 形式 (例: /株主リスト/B14)。シート名は実体に正確に従う" +
    "  - ★ セルへの書き込みは **必ず value= でセル丸ごと上書き** する。find/replace は使うな ★" +
    "    理由: セル内のマーカー (★label★) は run 分割されてることが多く、find が 0 マッチで失敗する" +
    "    (実際に最下段の証明者セル等が『find pattern matched 0』で毎回スキップされる事故が起きている)" +
    "  - 正: { command:'set', path:'/株主リスト/B26', props:{ value:'令和８年６月１日\\n株式会社○○\\n代表取締役 ○○' } }" +
    "  - 誤: { command:'set', path:'/株主リスト/B26', props:{ find:'★証明書の作成日★', replace:'...' } } ← 0 マッチで失敗" +
    "  - セル値に改行を含めたい時は value 内に \\n を入れる (officecli が改行セルとして扱う)" +
    "  - 塗りつぶし除去: --prop fill=FFFFFF (白で潰す)。docx の highlight=none は xlsx で無効" +
    "  - 各セルを個別の set op で書き換える (1 行 = 5 セルなら 5 op)。1 op = 1 セル = value 指定" +
    "【★行数が変わる構造変更 (個人→組合 の同意欄 等) = 最重要・ダブり防止★】" +
    "  個人の同意欄 (住所/氏名 の2行) を 組合の同意欄 (主たる事務所/名称/無限責任組合員/組合員/代表取締役 の" +
    "  5行) に変えるような、**行数が変わる**変換では、その領域を『丸ごと書き直す』として扱う:" +
    "    (1) まず完成形の全行を確定する → (2) 旧領域の段落を **1つ残らず remove** する → " +
    "    (3) 新しい全行を add で作る。" +
    "  - ★旧の個人行 (氏名 行 等) を、新の役割行 (代表取締役 等) に set find/replace で『流用』してはいけない★。" +
    "    流用すると、その値が『氏　名　川上登福』と『代表取締役　川上登福』の2箇所に出て **ダブる** " +
    "    (実際に起きた事故)。旧個人行は repurpose せず必ず remove、新役割行は add で別に作ること。" +
    "  - add した行の **書式 (字下げ・行間・配置) は recast が隣の行から自動で継承する**ので、" +
    "    style/align を気にせず text だけ入れてよい (列ずれの心配は不要)。" +
    "【1対1のラベル変更 (行数が変わらない) は従来通り set find/replace でOK】" +
    "  - 例: 『商　号　○○』→『名　称　○○』 のように 1行→1行 なら set でラベルごと書き換え (書式維持)。" +
    "    行数が増減しないので remove+add は不要。",
  input_schema: {
    type: "object",
    properties: {
      documents: {
        type: "array",
        description: "書類ごとの OfficeCLI コマンド列。同じテンプレから複数出力する場合は outputLabel で区別",
        items: {
          type: "object",
          properties: {
            templateFile: {
              type: "string",
              description: "クリーンな物理テンプレファイル名 (例: '2-1.提案書兼同意書.docx')",
            },
            outputLabel: {
              type: "string",
              description: "同一テンプレから複数出力する場合の識別 (例: '藤崎用')。1 出力なら省略",
            },
            commands: {
              type: "array",
              description: "OfficeCLI コマンド列。順次実行される",
              items: {
                type: "object",
                properties: {
                  command: {
                    type: "string",
                    enum: ["set", "add", "remove", "get", "query", "view", "validate", "close"],
                    description: "officecli の動詞。set=プロパティ変更/find-replace、add=要素追加、remove=削除",
                  },
                  path: {
                    type: "string",
                    description: "対象要素の XPath (例: '/body/p[@paraId=064BAB11]')。@paraId を必ず使う",
                  },
                  parent: {
                    type: "string",
                    description: "add のとき: 親要素のパス (例: '/body')",
                  },
                  type: {
                    type: "string",
                    description: "add のとき: 追加する要素タイプ (例: 'paragraph', 'comment')",
                  },
                  after: {
                    type: "string",
                    description: "add のとき: この要素の直後に挿入 (例: '/body/p[@paraId=xxx]')",
                  },
                  before: {
                    type: "string",
                    description: "add のとき: この要素の直前に挿入",
                  },
                  props: {
                    type: "object",
                    description:
                      "--prop key=value 形式の引数。set なら find/replace、add なら text 等。" +
                      "【重要】1 op で複数属性同時指定可。例: find + replace + highlight=none で " +
                      "「text 置換 + 黄色ハイライト除去」を 1 op で実行できる。別 op に分けない (トークン無駄)。",
                    additionalProperties: { type: "string" },
                  },
                },
                required: ["command"],
              },
            },
          },
          required: ["templateFile", "commands"],
        },
      },
    },
    required: ["documents"],
  },
};

// ===== FILL パス専用 Tool: set のみ許可 =====
// ai 書類の生成を「操作ごと」に 2 パスへ分割する (穴埋め / 構造変更)。FILL パスは set しか持たない
// → add/remove による行のダブり追加や、旧行を set で流用する構造破壊が **物理的に起きない**。
// 構造変更 (行の追加・削除・議案削除・組合化) は STRUCT パス (PHASE2_OFFICECLI_TOOL) の仕事。
// name は同じ submit_phase2_officecli (応答パースを共通化。各 call は片方のツールしか渡さないので競合しない)。
const PHASE2_OFFICECLI_FILL_TOOL: Anthropic.Tool = {
  name: "submit_phase2_officecli",
  description:
    "各書類への OfficeCLI の **set コマンドだけ** を提出する (穴埋め専用パス)。" +
    "★label★ (黄色ハイライト) に値を流し込むのが仕事。**このツールは set しか持たない** (add/remove 不可)。" +
    "段落の特定には @paraId を必ず使う。docx の ★label★ は set + find/replace (run 境界を跨ぐ)。" +
    "【docx】set 1 op で複数 prop 可: { find:'元値', replace:'新値', highlight:'none' } = 置換+ハイライト除去。" +
    "【xlsx】セルは **必ず value= で丸ごと上書き** (find/replace は run 分割で 0 マッチ失敗)。" +
    "  path は /SheetName/CellAddr。塗りつぶし除去は fill=FFFFFF。1 op = 1 セル。" +
    "【禁止】行の追加・削除・議案削除・組合化などの構造変更は **一切やるな** (別工程=STRUCT パスが担当)。" +
    "構造が変わる箇所の行も、このパスでは値を埋めるだけにする (作り替えない)。",
  input_schema: {
    type: "object",
    properties: {
      documents: {
        type: "array",
        description: "書類ごとの set コマンド列。同じテンプレから複数出力する場合は outputLabel で区別",
        items: {
          type: "object",
          properties: {
            templateFile: { type: "string", description: "クリーンな物理テンプレファイル名" },
            outputLabel: { type: "string", description: "同一テンプレから複数出力する場合の識別 (例: '藤崎用')。1 出力なら省略" },
            commands: {
              type: "array",
              description: "set コマンド列のみ",
              items: {
                type: "object",
                properties: {
                  command: { type: "string", enum: ["set"], description: "set のみ (find/replace または value 上書き)" },
                  path: { type: "string", description: "対象要素の XPath (例: '/body/p[@paraId=064BAB11]' / '/シート名/B14')。@paraId を必ず使う" },
                  props: {
                    type: "object",
                    description: "docx: find+replace+highlight=none / xlsx: value+fill。1 op で複数属性可",
                    additionalProperties: { type: "string" },
                  },
                },
                required: ["command", "path"],
              },
            },
          },
          required: ["templateFile", "commands"],
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

// thread から organizeResult を取得 (Phase 1 で execute route が submit_organize_result で保存したもの)
async function loadOrganizeResult(
  companyId: string,
  threadId: string
): Promise<{ markdown: string; structured: unknown } | null> {
  try {
    const crypto = await import("crypto");
    const hash = crypto.createHash("md5").update(companyId).digest("hex");
    const filePath = path.join(process.cwd(), "data", "chat-threads", hash, `${threadId}.json`);
    const raw = await fs.readFile(filePath, "utf-8");
    const thread = JSON.parse(raw);
    return thread.organizeResult || null;
  } catch {
    return null;
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

  // 統一ルール (組合の構造変換 ④ 等) を 1 度だけ読む。Step A と ai モード両方で使う。
  // Phase 1 整理結果は「共通ルール④に基づく」と番号参照のみで本体が無いため、
  // Phase 2 にもルール本体を渡さないと組合変換 (名称/無限責任組合員/代表者) ができない。
  let globalRulesText = "";
  if (templateFolderPath && config.templateBasePath) {
    try {
      const { loadGlobalRules } = await import("@/lib/global-rules");
      globalRulesText = await loadGlobalRules(config.templateBasePath, templateFolderPath);
    } catch (e) {
      console.warn("[analyze] loadGlobalRules failed:", e instanceof Error ? e.message : e);
    }
  }

  // テンプレ群のメモ (選択テンプレフォルダ内の .txt/.md) + 案件フォルダのメモ (.txt/.md) を読んで、
  // 生成 AI (Step A の穴埋め判断 / ai モードの commands 生成) に「作成者・担当者の指示」として渡す。
  // ★これまで一切読まれていなかった★ (analyze/analyze-questions は .txt をスキップ、produce-v2 は
  // docx/xlsx のみ処理) ため、メモに書いた指示が生成に効いていなかった。共通ルール(統一ルール.txt)とは別。
  let memoBlock = "";
  try {
    // 案件フォルダ (thread.folderPath) を引いて、テンプレ群メモ + 案件フォルダメモ(.txt/.md) を読む。
    // 質問生成(analyze-questions)と共通の loadMemoNotes を使う。
    const fsLib = await import("fs/promises");
    const nodePath = await import("path");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require("crypto");
    const companyHash = crypto.createHash("md5").update(company.id).digest("hex");
    const threadFile = nodePath.default.join(process.cwd(), "data", "chat-threads", companyHash, `${threadId}.json`);
    const threadData = JSON.parse(await fsLib.default.readFile(threadFile, "utf-8")) as { folderPath?: string };
    const { loadMemoNotes } = await import("@/lib/memo-notes");
    memoBlock = await loadMemoNotes(templateFolderPath, threadData.folderPath || null);
  } catch { /* メモが読めなくても続行 */ }

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
  // 仕分け式アーキテクチャ用: テンプレごとに「パーサーの slots/位置 + labels + ★label★本文」を捕捉。
  // Step A (確定値表+仕分け) → ルール生成器 に渡す材料。
  type ClassData = {
    templateFile: string;
    filePath: string;
    isXlsx: boolean;
    labels: import("@/lib/template-labels").TemplateLabels | null;
    slots: Map<number, string>;
    docxPositions?: Map<number, import("@/lib/docx-marker-parser").DocxSlotPosition>;
    xlsxPositions?: Map<number, import("@/lib/xlsx-marker-parser").XlsxSlotPosition>;
    xlsxCellTexts?: Map<string, string>;   // xlsx セル単位再構築用
    xlsxPercentRefs?: Set<string>;          // % 書式セル (値に % を付ける)
    starMarkedText: string;   // ★label★ 入り本文 (Step A の文脈把握用)
  };
  const classificationData: ClassData[] = [];
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
            const { text, slots, slotPositions } = getMarkedDocumentTextWithSlots(docBuf);
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
            classificationData.push({
              templateFile: f.name, filePath: f.path, isXlsx: false,
              labels: labels ?? null, slots, docxPositions: slotPositions, starMarkedText: markedText,
            });
          } catch (e) {
            console.warn(`[analyze] docx marker read failed (${f.name}):`, e instanceof Error ? e.message : e);
          }
        } else if (isXlsx) {
          try {
            docBuf = await fs.readFile(f.path);
            const { text, slots, slotPositions, cellTexts, percentRefs } = getXlsxMarkedTextWithSlots(docBuf);
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
            classificationData.push({
              templateFile: f.name, filePath: f.path, isXlsx: true,
              labels: labels ?? null, slots, xlsxPositions: slotPositions, xlsxCellTexts: cellTexts, xlsxPercentRefs: percentRefs, starMarkedText: markedText,
            });
          } catch (e) {
            console.warn(`[analyze] xlsx marker read failed (${f.name}):`, e instanceof Error ? e.message : e);
          }
        }

        if (!markedText && f.content) markedText = f.content;
        if (!markedText) continue;

        if (useOfficeCliEngine()) {
          // OfficeCLI モード: officecli view text の出力を markedText として使う。
          // docx: 各段落の @paraId と本文が `[/body/p[@paraId=XXX]] 本文` 形式で取得できる。
          // xlsx: 各セルが `[/SheetName/CellAddr]` 形式。シート名取得のため outline も併記する。
          try {
            const { runOfficeCli, viewText, query } = await import("@/lib/officecli");
            const officeText = await viewText(f.path);
            let extra = "";
            if (isXlsx) {
              // xlsx は実体のシート名を AI が知る必要がある (思い込みで存在しないシート名を使う事故防止)。
              const outline = await runOfficeCli(["view", f.path, "outline"]);
              extra += outline.exitCode === 0
                ? `\n\n--- xlsx 構造 (実体のシート名はここから確認) ---\n${outline.stdout}`
                : "";

              // 黄色塗りつぶしセル一覧 (placeholder 相当 = 値を埋めるセル)
              const yellowResult = await query(f.path, "cell[fill=#FFFF00]");
              const yellow = typeof yellowResult === "string" ? yellowResult : JSON.stringify(yellowResult);
              extra += `\n\n--- 黄色塗りつぶしセル (★label★ 相当、値を埋める対象) ---\n${yellow}`;

              // 赤文字セル一覧 (もう 1 つの placeholder パターン)
              const redResult = await query(f.path, "cell[font.color=#FF0000]");
              const red = typeof redResult === "string" ? redResult : JSON.stringify(redResult);
              extra += `\n\n--- 赤文字セル (もう 1 つの placeholder、値を埋める対象) ---\n${red}`;

              extra += `\n\n⚠ xlsx のパスは /SheetName/CellAddr (例: /株主リスト/B14) 形式。docx と違って /body/p[...] は使えない。シート名は上記から正確にコピペ。row[N] レベルで一括 find/replace は無効、各セルを個別の set で書き換える。`;
            } else {
              const highlightsResult = await query(f.path, "run[highlight=yellow]");
              const highlights = typeof highlightsResult === "string" ? highlightsResult : JSON.stringify(highlightsResult);
              extra = `\n\n--- 黄色ハイライト run 一覧 (★label★ 相当) ---\n${highlights}`;
            }
            markedText = `${officeText}${extra}`;
          } catch (e) {
            console.warn(`[analyze officecli] view text failed (${f.name}):`, e instanceof Error ? e.message : e);
            // フォールバック: 既存の番号付け markedText
            if (docBuf) markedText = addMarkedTextNumbering(markedText, docBuf, isXlsx);
          }
        } else if (docBuf) {
          // 既存 changes モード: produce-v2 の getContentParagraphs と一致する番号付け。
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

  // OfficeCLI モードでは reasoningPrompt (全書類本文 + 統一ルール + 例文の長文) を Call 2 に渡す
  // 必要は無い (Call 1 廃止、Call 2 は書類別に該当テンプレ本文だけ jsonPrompt に含める)。
  // 各 Call 2 で reasoningPrompt 分のトークンが浮く = コスト・時間が大幅減。
  const messagesWithUserTurn = useOfficeCliEngine()
    ? aiMessages  // officecli: Phase 1 (organize) + 2-A (clarify) のみ
    : appendUserTurn(aiMessages, reasoningPrompt, "analyze");  // changes: 既存通り

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
          // OfficeCLI モードでは Call 1 を廃止 (Call 2 が直接 commands を出すので二重推論不要)。
          // changes モードは Call 1 で推論 → Call 2 で JSON 化、の 2 段階を維持。
          let reasoningText = "";
          if (useOfficeCliEngine()) {
            // officecli モード: Call 1 をスキップ。Phase 1 (organize) の整理結果と
            // Phase 2-A (clarify) の Q&A が既に会話履歴 (messagesWithUserTurn) に入ってる。
            // Call 2 で直接 commands を出させる。
            send(controller, { type: "stage", stage: "reasoning" });
            send(controller, { type: "text", text: "OfficeCLI モード: Call 1 (推論) はスキップ、Call 2 で直接 commands を生成します。\n" });
          } else {
            send(controller, { type: "stage", stage: "reasoning" });
            const reasoningStream = client.messages.stream({
              model: REASONING_MODEL,
              max_tokens: 32000,
              temperature: 0,
              messages: toAnthropicMessages(messagesWithUserTurn) as Anthropic.MessageParam[],
            });

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
          }

          // ============== Call 2: Sonnet 4.6 で JSON 化 (Tool Use) ==============
          // 並列化: 書類ごとに Promise.all で Call 2 を呼び出す。
          // 理由: 全書類分まとめて 1 回の Tool Use で出させると、株主数 × 書類数の展開で
          //       16k tokens を超えて JSON が途中で切れる事故が起きた (Polaris ケース)。
          //       書類ごとに分けると 1 call あたり changes 50-60 op (≈ 3-4k tokens) で余裕に収まる。
          //       並列なので時間は増えず、書類数が増えてもスケールする。
          //       書類間の整合性は Call 1 reasoning で全書類分まとめて取ってるため、
          //       Call 2 は書類ごとの「推論メモを構造化された JSON に転記する作業」のみ。
          send(controller, { type: "stage", stage: "structuring" });

          // ===== OfficeCLI モード用サブルーチン =====
          // env var RECAST_ENGINE=officecli のとき呼ばれる。
          // AI に officecli の commands を出させる (C 案)。
          // Call 1 (reasoning) は廃止 → Call 2 が直接 commands を作る。
          // 必要な情報 (Phase 1 整理結果 + 2-A の Q&A + 統一ルール) は messagesWithUserTurn に
          // 既に入ってるので、それと jsonPrompt を一緒に送る。
          // ★ ai 書類は「操作ごとに 2 パス」で生成する (穴埋め / 構造変更を分離) ★
          // 1 回の自由命令で穴埋めと構造変更を混ぜると、単純置換のクセが構造変更に漏れて
          //   旧行を set で流用 → ダブり等の事故が起きる (Claude for Word は構造変更を1個ずつ
          //   独立適用しているから起きない)。これを構造的に断つ:
          //   - FILL パス: set のみ (add/remove を持たない) → ★label の穴埋めだけ。構造を壊しようがない。
          //                出力の振り分け (会社/組合 何通り作るか) もここで確定する。
          //   - STRUCT パス: FILL が確定した outputLabel を引き継ぎ、各出力に構造変更コマンドだけ足す。
          //                  穴埋めの雑念が無いので構造変更に集中できる。
          //   2 つを (templateFile::outputLabel) で合体。fill/loop 書類はこの関数を通らない (機械生成のまま)。
          const runPhase2OfficeCliForDocument = async (
            templateFile: string,
            bodyForThisDoc: string,
            valueTableHint?: Record<string, string>   // 仕分けモードの確定値表 (書類間で値を揃えるため)
          ): Promise<Phase2DocumentDecision[]> => {
            // 確定値表があれば「この値をそのまま使え」とプロンプトに明示 (書類間の表記統一)
            const valueTableBlock = valueTableHint && Object.keys(valueTableHint).length > 0
              ? `\n## ★確定済みの値 (他書類と統一済み。この表記をそのまま使い、勝手に再フォーマットするな)\n` +
                Object.entries(valueTableHint).map(([k, v]) => `- ${k}: ${v}`).join("\n") + "\n"
              : "";

            // 両パス共通: 株主の振り分け + 値の取り扱い + テンプレ本文
            const sharedBody = `## 株主の振り分けルール (重要)

organizeResult.parties は全株主が \`role: 株主\` で記録されている (個人/法人/組合の区別は無い)。
**テンプレファイル名を見て、このテンプレに適用すべき株主を AI が判断する**:

- **個人用テンプレ** (例: \`XX_個人.docx\`): 個人 (会社・組合じゃない自然人) の株主全員に適用
- **法人用テンプレ** (例: \`XX_法人.docx\`): **法人格を持つ株主全員** (会社・組合・有限責任組合員 等 全部含む) に適用
- **テンプレ名に個人/法人区別が無い** (例: \`XX.docx\`): 全株主に適用 (共通ルールで内部変換)

判断材料: parties[].name + parties[].representative + parties[].note。
- name に「株式会社」「合同会社」「組合」「会社」等が含まれる → 法人格あり
- representative が設定されている → 法人格あり
- note に「組合員」「無限責任組合員」等が書かれている → 組合 = 法人格あり

**漏れチェック**: 法人用テンプレなら、parties から法人格を持つ株主を全員リストアップして、
それぞれに outputLabel 別の entry を作る。1 件でも漏れると登記書類が揃わない。
(個人 7 人 / 法人 1 人 / 組合 1 人なら、個人テンプレで 7 通 + 法人テンプレで 2 通 = 会社 + 組合。)

## organizeResult の値を改変するな

organizeResult.structured に書かれた値 (氏名・住所・日付・株数 等) は **そのまま使う**。
「より正式な表記に」「全部漢数字に」みたいな勝手な変換は禁止。Phase 1 で確定済み。
住所「下谷2丁目3番2号」を「下谷二丁目三番二号」に変えるな。整理結果の通りに使う。
統一ルールで明示的に変換が必要 (組合の本店→主たる事務所 等) な場合のみ変換する。
${valueTableBlock}
## テンプレ本文 (${templateFile})

各段落の冒頭に \`[/body/p[@paraId=XXXXXXXX]]\` (8文字16進ID)。
段落の特定には **必ず @paraId を使う**。位置番号 (p[1]) はダメ (insert/delete でズレる)。
末尾の「黄色ハイライト一覧」が ★label★ 相当 = 値を埋める対象。

${bodyForThisDoc}`;

            // OfficeCLI モード: 会話履歴全部を送るのは無駄 (添付 PDF/画像、tool_use 往復、
            // テンプレ二度送りで 30k+)。必要情報 (整理結果 + Q&A) だけ 1 つの user メッセージに
            // 圧縮し、cache_control で cacheRead を効かせる (FILL→STRUCT で同一 prefix を共有)。
            const organizeResult = await loadOrganizeResult(company.id, threadId);
            let essentialContext = extractEssentialContext(messagesWithUserTurn, organizeResult);
            if (globalRulesText.trim()) {
              essentialContext += `\n\n## 統一ルール (最優先で従う。番号参照されたルールの本体はここ)\n${globalRulesText}`;
            }
            essentialContext += memoBlock; // テンプレ群/案件フォルダのメモ (notes が無ければ空文字)

            // 1 パス分の API 呼び出し (tool と prompt を差し替えて FILL / STRUCT で使い回す)
            const callPass = async (
              tool: Anthropic.Tool,
              jsonPrompt: string,
              passLabel: string
            ): Promise<Phase2DocumentDecision[]> => {
              try {
                const response = await client.messages.create({
                  model: JSON_MODEL,
                  max_tokens: 16384,
                  temperature: 0,
                  tools: [tool],
                  tool_choice: { type: "tool", name: tool.name },
                  messages: [
                    {
                      role: "user",
                      content: [
                        { type: "text", text: essentialContext, cache_control: { type: "ephemeral" } },
                        { type: "text", text: jsonPrompt },
                      ],
                    },
                  ],
                });
                logTokenUsage(`/api/document-templates/analyze (Call 2 ${passLabel}: ${templateFile})`, JSON_MODEL, response.usage);
                if (response.stop_reason === "max_tokens") {
                  console.warn(`[analyze officecli] ${passLabel} for ${templateFile} hit max_tokens (${response.usage.output_tokens})`);
                }
                const toolBlock = response.content.find(
                  (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use"
                );
                if (toolBlock?.name === tool.name) {
                  const input = toolBlock.input as {
                    documents?: { templateFile: string; outputLabel?: string; commands: unknown[] }[]
                  };
                  return (input.documents || []).map((d) => ({
                    templateFile: d.templateFile,
                    outputLabel: d.outputLabel,
                    officeCommands: d.commands as Phase2DocumentDecision["officeCommands"],
                  }));
                }
                console.warn(`[analyze officecli] ${passLabel} for ${templateFile}: Tool Use returned no commands`);
                return [];
              } catch (e) {
                console.error(`[analyze officecli] ${passLabel} for ${templateFile} failed:`, e instanceof Error ? e.message : e);
                return [];
              }
            };

            // ===== パス1: FILL (set のみ) — ★label の穴埋め + 出力の振り分け =====
            const fillPrompt = `## あなたの仕事 (穴埋めパス)

**${templateFile}** の ★label★ (黄色ハイライト) に値を流し込む **set コマンドだけ** を submit_phase2_officecli で提出。他書類は無視。
${qaBlock}
このパスは **穴埋め専用**。行の追加・削除・議案削除・組合化などの **構造変更は一切やらない** (別工程が担当)。
構造が変わる箇所 (組合の同意欄など) の行も、ここでは **そのまま値だけ埋める** (作り替えは別工程)。

${sharedBody}

---

## set コマンドの書き方
### docx
- \`{command:"set", path:"/body/p[@paraId=XXX]", props:{find:"元値", replace:"新値", highlight:"none"}}\` (置換+ハイライト除去を1op)
### xlsx (docx と違う)
- \`{command:"set", path:"/シート名/B14", props:{value:"徳永優也", fill:"FFFFFF"}}\` (value で丸ごと上書き、find/replace 禁止=run分割で0マッチ)
- 1 op = 1 セル。1 行 5 セルなら set 5 回。

## 出力の振り分け (重要)
上の「株主の振り分けルール」に従い、このテンプレから作る出力を **全部** documents[] に並べる
(法人テンプレなら 会社 + 組合 で 2 entry 等)。各 entry に outputLabel を付ける。
**次の工程 (構造変更) がこの outputLabel をそのまま引き継ぐ**ので、識別しやすい名前にする。`;

            const fillDocs = await callPass(PHASE2_OFFICECLI_FILL_TOOL, fillPrompt, "FILL");

            // ===== パス2: STRUCT — 構造変更だけ (FILL が確定した出力ラベルを引き継ぐ) =====
            const knownOutputs = fillDocs.map((d) => ({ templateFile: d.templateFile, outputLabel: d.outputLabel }));
            const outputsList = knownOutputs.length > 0
              ? knownOutputs.map((o) => `- ${o.templateFile}${o.outputLabel ? ` [outputLabel: ${o.outputLabel}]` : " [outputLabel なし]"}`).join("\n")
              : `- ${templateFile} [outputLabel なし]`;

            const structPrompt = `## あなたの仕事 (構造変更パス)

★label★ の穴埋めは **別工程で完了済み**。お前の仕事は **構造変更だけ** (行の追加・削除・議案削除・組合化)。
**穴埋め (単なる ★label の値入れ) は出すな**。構造が変わらない出力は commands を空にしてよい。
${qaBlock}
## 対象の出力 (前工程=穴埋めが確定したもの。この outputLabel を完全一致で引き継ぐこと)
${outputsList}

各出力について、**構造変更が要るものだけ** commands を出す。outputLabel は上のリストの表記を
**そのまま使う** (勝手に変えると別出力扱いになり、穴埋め結果と合体できず崩れる)。

${sharedBody}

---

## 構造変更コマンドの書き方
- **remove** (段落削除): \`{command:"remove", path:"/body/p[@paraId=XXX]"}\`
- **add** (段落追加): \`{command:"add", parent:"/body", after:"/body/p[@paraId=XXX]", type:"paragraph", props:{text:"..."}}\`
- **set** (議案番号の繰り上げ等、行数が変わらない文言修正のみ): \`{command:"set", path:"/body/p[@paraId=YYY]", props:{find:"議案３", replace:"議案２"}}\`
- add した行の書式 (字下げ・行間・配置) は recast が隣行から自動継承するので text だけでよい (列ずれ不要)。

## ⚠ 行数が変わる構造変更 (個人→組合 の同意欄 等) = 最重要・ダブり防止
個人の同意欄 (住所/氏名 の2行) を 組合の同意欄 (主たる事務所/名称/無限責任組合員/組合員/代表取締役 の5-6行)
に変えるような **行数が変わる** 変換では、その領域を『丸ごと書き直す』として扱う:
  (1) まず完成形の全行を頭の中で確定 → (2) 旧領域の段落を **1つ残らず remove** → (3) 新しい全行を add で作る。
- ★旧の個人行 (氏名 行 等) を set find/replace で新役割行 (代表取締役 等) に **流用するな**★。
  流用すると『氏　名　川上登福』と『代表取締役　川上登福』の2箇所に出て **ダブる** (実際の事故)。
  旧個人行は必ず remove、新役割行は add で別に作る。
- 元の情報項目 (本店/商号/代取/議決権 等) を新ラベル群で **1つも省略せず** 表現する。remove より少ない add は省略バグ。

## ⚠ 議案などのブロック削除 (確認回答で「議案◯を丸ごと削除」と指定された場合)
- その議案の **見出し段落から、次の議案の見出しの直前まで** の全段落を remove (見出しも明細も 1 段落残さず)。
- 削除したら後続の議案番号を繰り上げる: 「議案３…」→「議案２…」を set find/replace で直す。`;

            const structDocs = await callPass(PHASE2_OFFICECLI_TOOL, structPrompt, "STRUCT");

            // ===== 合体: (templateFile::outputLabel) で FILL の set + STRUCT の構造変更を結合 =====
            // set が先・構造変更 (remove/add) が後。FILL が同意欄の旧行を埋めても、STRUCT がその行を
            // remove するので消える (ダブらない)。STRUCT の add 行は新規なので FILL と衝突しない。
            const keyOf = (d: Phase2DocumentDecision) => `${d.templateFile}::${d.outputLabel || ""}`;
            const merged = new Map<string, Phase2DocumentDecision>();
            for (const d of fillDocs) {
              merged.set(keyOf(d), { ...d, officeCommands: [...(d.officeCommands || [])] });
            }
            for (const d of structDocs) {
              const cmds = d.officeCommands || [];
              if (cmds.length === 0) continue; // 構造変更が無い出力 (会社など) は skip
              const k = keyOf(d);
              const existing = merged.get(k);
              if (existing) {
                existing.officeCommands = [...(existing.officeCommands || []), ...cmds];
              } else {
                // FILL に無い出力に STRUCT だけ付いた = 振り分けズレ。穴埋め欠落で崩れるが、隠さず残して可視化
                merged.set(k, { ...d, officeCommands: [...cmds] });
                console.warn(`[analyze officecli] STRUCT produced an output not present in FILL: ${k} (穴埋めが付かず崩れる可能性)`);
              }
            }
            return [...merged.values()];
          };

          // 書類ごとに Tool Use を呼ぶサブルーチン (changes モード)
          const runPhase2ForDocument = async (
            templateFile: string,
            bodyForThisDoc: string
          ): Promise<Phase2DocumentDecision[]> => {
            // env var officecli ならそっちのルートに振る
            if (useOfficeCliEngine()) {
              return runPhase2OfficeCliForDocument(templateFile, bodyForThisDoc);
            }
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

          // 書類ごとに半並列で Tool Use を呼ぶ。
          // Anthropic prompt caching の仕様: 並列同時送信だと全 call が cacheWrite (cache 未作成)。
          // → 1 つ目を先に実行して cache 作成 → 残り並列で cacheRead (10倍安い)。
          // 時間: 完全並列なら N 秒、半並列なら 2N 秒 (1 件分待ち + 残り並列)。コスト 1/3 になる。
          let docResults: Phase2DocumentDecision[][];
          if (useClassificationMode() && classificationData.length > 0) {
            // ===== 仕分け式: Step A (確定値表+仕分け) → fill/loop は機械生成、ai は従来 AI =====
            send(controller, { type: "stage", stage: "structuring" });
            send(controller, { type: "text", text: "仕分けモード: 確定値表を作成中...\n" });
            const { runPhase2Planning } = await import("@/lib/phase2-plan");
            const { resolveSlots, generateFillCommands } = await import("@/lib/fill-command-generator");

            // 各テンプレの slot 一覧 (slotId + label ヒント + 形式 + 前値) を AI に渡す
            const planTemplates = classificationData.map((c) => ({
              templateFile: c.templateFile,
              markedText: c.starMarkedText,
              slots: (c.labels?.slots || [])
                .filter((s) => s.label && s.label !== "不明")
                .map((s) => ({ slotId: s.slotId, label: s.label, format: s.format, sourceHint: s.sourceHint, oldValue: c.slots.get(s.slotId) })),
            }));

            const organizeForPlan = await loadOrganizeResult(company.id, threadId);
            let caseContextForPlan = extractEssentialContext(messagesWithUserTurn, organizeForPlan);
            // 統一ルール本体を Step A に渡す (番号参照だけでは組合変換できないため)
            if (globalRulesText.trim()) {
              caseContextForPlan += `\n\n## 統一ルール (最優先で従う。番号参照されたルールの本体はここ)\n${globalRulesText}`;
            }
            caseContextForPlan += memoBlock; // テンプレ群/案件フォルダのメモ (notes が無ければ空文字)
            // 確認回答 (議案削除の要否等) を分類AI(Step A)にも渡す。これが無いと「削除が要る→ai」の
            // 判断ができず、削除が要る書類まで fill に振り分けられて削除指示が落ちる (議案2不具合の根因)。
            if (qaBlock) caseContextForPlan += `\n${qaBlock}`;

            // 案件フォルダの画像 (マイナンバーカード等) を穴埋め AI に添付する。
            // 生年月日・住所などは本人確認書類の画像にしか無く、整理結果(テキスト)に出てこないことがある。
            // 穴埋め時にその画像を直接読めるようにして「データが無い→元データ(原本)を見る」を成立させる
            // (これが無いと生年月日が <UNKNOWN> のまま出る)。analyze は案件ファイルを body で受け取らないので
            // ここで案件フォルダ(thread.folderPath)を読み込む。
            let casePlanImages: { base64: string; mimeType: string; name: string }[] = [];
            try {
              const fsLib = await import("fs/promises");
              const nodePath = await import("path");
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const crypto = require("crypto");
              const companyHash = crypto.createHash("md5").update(company.id).digest("hex");
              const threadFile = nodePath.default.join(process.cwd(), "data", "chat-threads", companyHash, `${threadId}.json`);
              const threadData = JSON.parse(await fsLib.default.readFile(threadFile, "utf-8")) as { folderPath?: string };
              if (threadData.folderPath) {
                const IMG = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
                const caseFiles = await readAllFilesInFolder(threadData.folderPath);
                casePlanImages = caseFiles
                  .filter((cf) => cf.mimeType && IMG.has(cf.mimeType) && cf.base64)
                  .map((cf) => ({ base64: cf.base64 as string, mimeType: cf.mimeType as string, name: cf.name }));
                if (casePlanImages.length > 0) {
                  send(controller, { type: "text", text: `案件画像 ${casePlanImages.length} 件を穴埋め時の原本参照に添付\n` });
                }
              }
            } catch { /* 案件画像が読めなくても続行 */ }

            const plan = await runPhase2Planning({ caseContext: caseContextForPlan, templates: planTemplates, caseImages: casePlanImages });
            const planSummary = plan.templatePlans.map((tp) => `${tp.templateFile}:${tp.mode}`).join(", ");
            send(controller, { type: "text", text: `仕分け: ${planSummary}\n` });
            // サーバーログにも分類結果を出す (loop↔ai のブレ調査用。SSE は client にしか出ないため)
            console.log(`[analyze] 仕分け結果: ${planSummary}`);

            const byFile = new Map(classificationData.map((c) => [c.templateFile, c]));
            const results: Phase2DocumentDecision[][] = [];
            const aiTemplates: { templateFile: string; body: string }[] = [];

            // ai モードに渡す値ヒント (fill/loop で AI が決めた値を label→value で集約。整合性用のソフトヒント)
            const valueHint: Record<string, string> = {};
            for (const tp of plan.templatePlans) {
              const cd = byFile.get(tp.templateFile);
              if (!cd?.labels) continue;
              const labelById = new Map(cd.labels.slots.map((s) => [s.slotId, s.label]));
              const allFills = [
                ...(tp.slotFills || []),
                ...(tp.sharedSlotFills || []),
                ...(tp.entities || []).flatMap((e) => e.slotFills),
              ];
              for (const f of allFills) {
                const lbl = labelById.get(f.slotId);
                if (lbl && f.value) valueHint[lbl] = f.value;
              }
            }

            for (const tp of plan.templatePlans) {
              const cd = byFile.get(tp.templateFile);
              if (!cd) {
                send(controller, { type: "text", text: `  ${tp.templateFile}: メタ無し → skip\n` });
                continue;
              }
              if (tp.mode === "ai") {
                send(controller, { type: "text", text: `  ${tp.templateFile}: [AI個別] ${tp.reason || ""}\n` });
                const block = templateBlocks.find((b) => b.templateFile === tp.templateFile);
                if (block) aiTemplates.push(block);
                continue;
              }
              // fill / loop → 機械生成 (slotId 直接)
              const resolved = resolveSlots({
                slots: cd.slots,
                docxPositions: cd.docxPositions,
                xlsxPositions: cd.xlsxPositions,
              });
              const docs = generateFillCommands({ plan: tp, slots: resolved, xlsxCellTexts: cd.xlsxCellTexts, percentRefs: cd.xlsxPercentRefs });
              const decisionsForTpl: Phase2DocumentDecision[] = docs.map((d) => ({
                templateFile: tp.templateFile,
                outputLabel: d.outputLabel,
                officeCommands: d.commands as Phase2DocumentDecision["officeCommands"],
              }));
              results.push(decisionsForTpl);
              const totalCmds = docs.reduce((s, d) => s + d.commands.length, 0);
              const skipped = [...new Set(docs.flatMap((d) => d.skippedSlotIds))];
              send(controller, {
                type: "text",
                text: `  ${tp.templateFile}: ${tp.mode} ${docs.length}通 ${totalCmds}コマンド機械生成${skipped.length ? ` (slot未処理: ${skipped.length})` : ""}\n`,
              });
            }

            // ai モードのテンプレだけ従来 AI で生成。値ヒントを渡して書類間の表記を統一。
            if (aiTemplates.length > 0) {
              send(controller, { type: "text", text: `AI個別生成 ${aiTemplates.length}件...\n` });
              const aiResults = await Promise.all(
                aiTemplates.map((b) => runPhase2OfficeCliForDocument(b.templateFile, b.body, valueHint))
              );
              results.push(...aiResults);
            }
            docResults = results;
          } else if (templateBlocks.length === 0) {
            docResults = [];
          } else if (templateBlocks.length === 1) {
            docResults = [await runPhase2ForDocument(templateBlocks[0].templateFile, templateBlocks[0].body)];
          } else {
            // 1 件目 (cacheWrite) → 完了待ち → 残り並列 (cacheRead)
            const first = await runPhase2ForDocument(templateBlocks[0].templateFile, templateBlocks[0].body);
            const rest = await Promise.all(
              templateBlocks.slice(1).map((b) => runPhase2ForDocument(b.templateFile, b.body))
            );
            docResults = [first, ...rest];
          }
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

          // aiMessages に analyze ターンを保存。changes モードは reasoning テキスト、
          // officecli モードは Call 1 廃止なので空 (decisions 自体は phase2Decisions から復元可)。
          if (useOfficeCliEngine()) {
            // officecli: ユーザーターン (analyze 指示) も付けずに、aiMessages をそのまま保存。
            // analyze stage を記録するために空テキストの user + assistant ペアを追加してもいいが、
            // truncateBeforeStage が無くても次回 analyze 実行時に切り戻し対象が無いので問題なし。
            await saveAiMessages(company.id, threadId, messagesWithUserTurn);
          } else {
            const finalMessages = appendAssistantTurn(messagesWithUserTurn, reasoningText, "analyze");
            await saveAiMessages(company.id, threadId, finalMessages);
          }

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
