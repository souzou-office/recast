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
// 入力:
//   - companyId, threadId
//   - templateFolderPath (テンプレフォルダのパス)
//   - previousQA (Phase 1 clarify の Q&A。会話履歴には AI 側しか残ってないので明示的に渡す)
//
// 出力 (ストリーミング):
//   - text: 人間向けの md 推論 (AI が考えながら書く)
//   - decisions: 最終の構造化 JSON ({ documents: Phase2DocumentDecision[] })
//   - done: 終了
//
// 副作用:
//   - aiMessages に analyze ターンを追加 (md + 末尾の JSON ブロック)
//   - thread.phase2Decisions に構造化決定を保存 (clarify-procedural / produce が参照)

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
const MODEL = "claude-sonnet-4-6";

// JSON ブロック (```json ... ```) を AI 出力から抜き出してパースする。
// 末尾だけでなく文中のどこにあっても拾えるようにする (AI が説明後に出すパターンに対応)。
function extractDecisionsJson(text: string): Phase2Decisions | null {
  const blockMatch = text.match(/```json\s*([\s\S]*?)```/);
  const jsonText = blockMatch ? blockMatch[1] : null;
  if (!jsonText) {
    // フォールバック: 最後の { から最後の } までを試す
    const start = text.lastIndexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (obj && Array.isArray(obj.documents)) return obj as Phase2Decisions;
    } catch {
      return null;
    }
    return null;
  }
  try {
    const obj = JSON.parse(jsonText.trim());
    if (obj && Array.isArray(obj.documents)) return obj as Phase2Decisions;
  } catch (e) {
    console.warn("[analyze] JSON parse failed:", e instanceof Error ? e.message : e);
  }
  return null;
}

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
  // 再実行時は analyze 以降を切り戻す
  aiMessages = truncateBeforeStage(aiMessages, "analyze");

  // テンプレ本文を読む (各テンプレの中身を全部 AI に渡す)。
  // 案件ファイル本体は organize ターンで既に aiMessages に積まれているので、AI は会話履歴経由で見られる。
  //
  // 重要: テンプレ本文には ★label★ マーカーを **必ず埋め込む**。
  // (生テキストだと AI に slot 位置が見えず、肩書きをラベルから推測する誤判断の元になる)
  // - docx: getMarkedDocumentTextWithSlots で ［要入力_N］ 入りテキストを取り、labels.json
  //         の label に置き換える
  // - xlsx: getXlsxMarkedTextWithSlots で同様
  // - placeholder 形式 ({{...}}, 【...】) は f.content にそのまま入っているのでフォールバック
  const templateBlocks: string[] = [];
  // フロントの「構造表示」で使うために、テンプレ別の marked text を別配列で持っておく。
  const templateStructures: { templateFile: string; markedText: string }[] = [];
  if (templateFolderPath) {
    try {
      const { getMarkedDocumentTextWithSlots } = await import("@/lib/docx-marker-parser");
      const { getXlsxMarkedTextWithSlots } = await import("@/lib/xlsx-marker-parser");
      const { ensureDocxLabels, ensureXlsxLabels } = await import("@/lib/template-labels");

      const tpFiles = await readAllFilesInFolder(templateFolderPath);
      for (const f of tpFiles) {
        // テンプレフォルダ内のメモ (.txt/.md) はテンプレ注意事項として既に Phase 1 で渡し済みなのでスキップ
        if (f.name.endsWith(".txt") || f.name.endsWith(".md")) continue;
        // base64 (PDF/画像) はテンプレとしては想定外なのでスキップ
        if (f.base64) continue;

        const ext = f.name.toLowerCase().split(".").pop() || "";
        let markedText = "";

        if (ext === "docx" || ext === "docm") {
          try {
            const buf = await fs.readFile(f.path);
            const { text } = getMarkedDocumentTextWithSlots(buf);
            const labels = await ensureDocxLabels(f.path);
            // ［要入力_N］ → ★label★ に置換 (label が無ければ ★要入力_N★ のまま)
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

        // ハイライト系で取れなかった場合は f.content をフォールバック (placeholder 形式テンプレ用)
        if (!markedText && f.content) markedText = f.content;
        if (!markedText) continue;

        templateBlocks.push(`### ${f.name}\n\`\`\`\n${markedText}\n\`\`\``);
        templateStructures.push({ templateFile: f.name, markedText });
      }
    } catch (e) {
      console.warn("[analyze] template read failed:", e instanceof Error ? e.message : e);
    }
  }
  const templateBodyBlock =
    templateBlocks.length > 0
      ? `\n## テンプレート本文 (各書類の中身。★ラベル★ が埋めるべき穴。slot 直前直後の文字を必ず確認)\n\n${templateBlocks.join("\n\n")}\n`
      : "\n## テンプレート本文\n(読めませんでした)\n";

  // Phase 1 Q&A を明示的に渡す (会話履歴には AI 側の質問しか残らないので)
  const qaBlock =
    previousQA && previousQA.length > 0
      ? `\n## Phase 1 確認質問と回答 (ユーザー確定済み)\n${previousQA
          .map((qa, i) => `${i + 1}. Q: ${qa.question}\n   A: ${qa.answer}`)
          .join("\n")}\n`
      : "\n## Phase 1 確認質問と回答\n(回答なし)\n";

  const userTurnText = `## あなたが今やること

テンプレ書類を読んで、各スロット (★label★) に何を入れるか / どの議案を削除するかを確定する。
書類生成前の最後の AI 判断ターン。漏れがあると次ターン (produce) が困る。

${qaBlock}
${templateBodyBlock}

## 出力

人間向けの md 推論を書いた後、末尾に \`\`\`json ブロックで構造化決定を出す:

\`\`\`json
{
  "documents": [
    {
      "templateFile": "議事録.docx",
      "slotDecisions": [
        { "slot": "★ の中身そのまま", "action": "fill", "value": "値", "source": "出典" },
        { "slot": "乙の無限責任組合員の名称", "action": "delete-row", "reason": "引受人が法人なのでこの行は不要" },
        { "slot": "取締役会決議日", "action": "unconfirmed", "reason": "資料間で日付が食い違う",
          "candidates": [
            { "value": "令和8年5月20日", "source": "投資契約書" },
            { "value": "令和8年5月22日", "source": "案件スケジュール表" }
          ]
        }
      ],
      "blockDeletes": [
        { "block": "議案２　取締役の報酬に関する件", "reason": "役員報酬議案は今回該当なし" }
      ]
    }
  ]
}
\`\`\`

## slotDecisions のルール (構造的に重要)

各 slot は配列に **1 度だけ** 登場。**action は必ず 1 つだけ**:

- \`action: "fill"\` → \`value\` に値を入れる、\`source\` に出典を書く
- \`action: "delete-row"\` → この slot を含む段落 (= 行) を丸ごと削除する、\`reason\` で理由
- \`action: "unconfirmed"\` → ユーザーに聞く、\`reason\` と任意で \`candidates\`

**絶対にやってはいけないこと**:

- \`value\` に **指示文・注記・説明文を書く** (例: "【法人引受人のため本行削除】", "(該当なし)",
  "削除", "—" は **全部 NG**)。値じゃないものを value に書くな
- 同じ slot を 2 度書く (構造的に 1 entry のみ)
- 「値を埋める」と「行を削除」を 1 entry に混ぜる (action は 1 つだけ)

**該当しない slot の扱い**:

「テンプレに slot はあるが、この案件では該当しない」(例: 引受人が法人なのにテンプレに
「乙の無限責任組合員の名称」slot がある) → \`action: "delete-row"\` でその行を削除する。
**絶対に value に指示文を書かない**。

**共通ルール (Phase 1 ターンで渡された) を必ず参照** する:
- 「引受人が法人なら無限責任組合員 と 組合員 行は削除」「主たる事務所 → 本店」等の
  書類フォーマット変換ルールが共通ルールに書かれていれば、それに従って delete-row と fill を
  組み合わせる

## value に何を入れるか (fill action のみ)

produce は value を slot 位置に **そのまま挿入** するので:

- テンプレの slot 前後 (上に渡した本文) を見て、既に肩書き/単位が書かれていれば value から外す
- 値は最終形式 (令和8年5月29日 / 株式会社JINGS / 1,000,000 等)
- 指示文・条件分岐・複数アクションは **絶対書かない**

## blockDeletes

議案ブロック (議案2 全体等) のように **複数段落にまたがる削除** で、特定の 1 slot に紐づかない
ものは \`blockDeletes\` に書く。
- \`block\`: 削除対象ブロックのヘッダー文字列 (例: "議案２　取締役の報酬に関する件")
- \`reason\`: 理由

## json ブロックは末尾に 1 つだけ`;

  const messagesWithUserTurn = appendUserTurn(aiMessages, userTurnText, "analyze");

  try {
    const encoder = new TextEncoder();
    const send = (controller: ReadableStreamDefaultController, data: object) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    };
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // フロントに「テンプレ構造」を最初に渡す (折り畳み表示用)
          if (templateStructures.length > 0) {
            send(controller, { type: "structures", structures: templateStructures });
          }

          const aiStream = client.messages.stream({
            model: MODEL,
            max_tokens: 16384,
            temperature: 0,
            messages: toAnthropicMessages(messagesWithUserTurn) as Anthropic.MessageParam[],
          });

          let assistantText = "";
          for await (const event of aiStream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              assistantText += event.delta.text;
              send(controller, { type: "text", text: event.delta.text });
            }
          }
          try {
            const final = await aiStream.finalMessage();
            logTokenUsage("/api/document-templates/analyze", MODEL, final.usage);
          } catch {
            /* ignore */
          }

          // 構造化 JSON を抜き出して保存
          const decisions = extractDecisionsJson(assistantText);
          if (decisions) {
            await savePhase2Decisions(company.id, threadId, decisions);
            const summary = decisions.documents.map((d: Phase2DocumentDecision) => {
              const fills = d.slotDecisions.filter((s) => s.action === "fill").length;
              const dels = d.slotDecisions.filter((s) => s.action === "delete-row").length;
              const uncs = d.slotDecisions.filter((s) => s.action === "unconfirmed").length;
              return `${d.templateFile}: fill ${fills} / delete-row ${dels} / unconfirmed ${uncs} / blockDeletes ${d.blockDeletes.length}`;
            }).join("; ");
            console.log(`[analyze] decisions saved: ${summary}`);
            send(controller, { type: "decisions", decisions });
          } else {
            console.warn("[analyze] no JSON decisions block found in assistant output");
            send(controller, { type: "decisions", decisions: null });
          }

          const finalMessages = appendAssistantTurn(messagesWithUserTurn, assistantText, "analyze");
          await saveAiMessages(company.id, threadId, finalMessages);

          send(controller, { type: "done" });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error("[analyze] stream failed:", errMsg);
          try {
            send(controller, { type: "error", error: errMsg });
          } catch {
            /* closed */
          }
        } finally {
          try {
            controller.close();
          } catch {
            /* closed */
          }
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
