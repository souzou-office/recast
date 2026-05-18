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
  const templateBlocks: string[] = [];
  if (templateFolderPath) {
    try {
      const tpFiles = await readAllFilesInFolder(templateFolderPath);
      for (const f of tpFiles) {
        // テンプレフォルダ内のメモ (.txt/.md) はテンプレ注意事項として既に Phase 1 で渡し済みなのでスキップ
        if (f.name.endsWith(".txt") || f.name.endsWith(".md")) continue;
        // base64 (PDF/画像) はテンプレとしては想定外なのでスキップ
        if (f.base64) continue;
        if (!f.content) continue;
        templateBlocks.push(`### ${f.name}\n\`\`\`\n${f.content}\n\`\`\``);
      }
    } catch (e) {
      console.warn("[analyze] template read failed:", e instanceof Error ? e.message : e);
    }
  }
  const templateBodyBlock =
    templateBlocks.length > 0
      ? `\n## テンプレート本文 (各書類の中身。★ラベル★ や 【ラベル】 が穴を表す)\n\n${templateBlocks.join("\n\n")}\n`
      : "\n## テンプレート本文\n(読めませんでした)\n";

  // Phase 1 Q&A を明示的に渡す (会話履歴には AI 側の質問しか残らないので)
  const qaBlock =
    previousQA && previousQA.length > 0
      ? `\n## Phase 1 確認質問と回答 (ユーザー確定済み)\n${previousQA
          .map((qa, i) => `${i + 1}. Q: ${qa.question}\n   A: ${qa.answer}`)
          .join("\n")}\n`
      : "\n## Phase 1 確認質問と回答\n(回答なし)\n";

  const userTurnText = `## あなたが今やること (ターン3: Phase 2 = 手続き判断 / テンプレに具体的に何を入れるかを確定する)

ターン1 (案件整理 = 実体判断) と ターン2 (Phase 1 確認質問の回答) を踏まえて、
**選んだテンプレートの中身を1つずつ読んで、各スロットに具体的に何を入れるかを確定** してください。

このターンの目的は **「テンプレに入れる内容と削除する内容を全部確定する」** ことです。
次のターン (produce) は Phase 2 で確定した内容を **ルールベースで** テンプレに適用するだけ。
つまり **AI 判断の最後のチャンスがこのターン** です。漏れがあると produce が困る。

${qaBlock}
${templateBodyBlock}

## 仕事の進め方

1. 各テンプレ書類ごとに、本文を **上から順に** 読む
2. ★ラベル★ や 【ラベル】 のスロット箇所が出てきたら、何を入れるか決める
   - 案件ファイル (Phase 1 で読んだ内容) と Phase 1 Q&A を使って値を決める
   - 値が複数候補ある / どっちか分からない → unconfirmed に積む
3. 議案ブロック (見出しが「第○号議案」「第○章」等) が出てきたら、今回必要か判断
   - Phase 1 の議題構成判断と照合
   - 「今回該当なし」と判断したものは deletes に積む
4. 全部の書類について 1〜3 を繰り返す

## 出力フォーマット

**まず人間向けの md 推論を書く** (ストリーミングで見える)。例:

\`\`\`
# Phase 2: テンプレ穴埋め決定

## 議事録.docx
- 会社名 → 株式会社JINGS (登記簿)
- 払込期日 → 令和8年6月15日 (案件スケジュール表)
- 取締役会決議日 → ⚠ 投資契約書 5/20 vs スケジュール表 5/22 食い違い → unconfirmed
- 第3号議案 (役員報酬の決定の件) → Phase 1で『今回該当なし』判断 → deletes

## 招集通知.docx
...
\`\`\`

**最後に必ず \`\`\`json ブロック で構造化決定を出す** (機械が読む):

\`\`\`json
{
  "documents": [
    {
      "templateFile": "議事録.docx",
      "slots": [
        { "slot": "会社名", "value": "株式会社JINGS", "source": "登記簿 / Phase 1" },
        { "slot": "払込期日", "value": "令和8年6月15日", "source": "案件スケジュール表" }
      ],
      "deletes": [
        { "block": "第3号議案 役員報酬の決定の件", "reason": "Phase 1で『今回該当なし』判断" }
      ],
      "unconfirmed": [
        {
          "slot": "取締役会決議日",
          "reason": "資料間で日付が食い違う",
          "candidates": [
            { "value": "令和8年5月20日", "source": "投資契約書" },
            { "value": "令和8年5月22日", "source": "案件スケジュール表" }
          ]
        }
      ]
    }
  ]
}
\`\`\`

## 重要原則

1. **テンプレ全件・全スロットを網羅**。読み飛ばしたスロットがあると produce で 要確認 残骸になる
2. **Phase 1 で確定した値は Phase 2 で再質問しない**。slots に書き込めば完了
3. **議案削除は反映先テンプレを明示**。"templateFile" + "block" で一意に
4. **unconfirmed は本当に分からないものだけ**。Phase 1 で確定済みなら slots に入れる
5. **slot の表記は ★ラベル★ や 【ラベル】 の中身そのまま** (例: "会社名", "払込期日")。表記揺れさせない
6. **json ブロックは最後に1つだけ**。複数置かない
7. **値は最終形式で書く** (令和8年6月15日 / 株式会社JINGS 等)。produce はこの値をそのまま入れる

## value に何を入れるか

produce は value を slot 位置に **そのまま挿入** するだけ。なので value は
**「テンプレの slot 位置に貼り付けたとき、その文が自然に読める形」** にすること。

判断のやり方: 各 slot について **テンプレ本文の slot の前後 (上に渡したテンプレ本文を見る)** を
確認して、

- 既にそこに肩書き・ラベル・敬称・単位が書かれていれば、value からはそれを **除く**
  - 例: テンプレ「取締役　★氏名★」→ value: "古澤　利成" (取締役は除く)
  - 例: テンプレ「★金額★ 円」→ value: "1,000,000" (円は除く)
- まだ書かれてなくて value 側に含めないと文が壊れるなら、value に **含める**
  - 例: テンプレ「次の者を選任する: ★役職と氏名★」→ value: "取締役 古澤　利成" (両方入れる)
  - 例: テンプレ「★肩書付き住所★」→ value: "代表取締役　神奈川県横浜市…" (肩書を含めて1つの欄)

**slot 名だけで判断しない**。slot 名が「氏名」でもテンプレ周辺に肩書きが無ければ肩書きを含める
必要があるし、slot 名が「役職」でもテンプレに既に「取締役」と書かれていれば value は氏名だけ。

迷ったら「テンプレを読んで、value を貼り付けた完成形を頭に浮かべる」→ 自然に読めるかチェック。`;

  const messagesWithUserTurn = appendUserTurn(aiMessages, userTurnText, "analyze");

  try {
    const encoder = new TextEncoder();
    const send = (controller: ReadableStreamDefaultController, data: object) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    };
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const aiStream = client.messages.stream({
            model: MODEL,
            max_tokens: 16384,
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
            const summary = decisions.documents.map((d: Phase2DocumentDecision) =>
              `${d.templateFile}: slots ${d.slots.length} / deletes ${d.deletes.length} / unconfirmed ${d.unconfirmed.length}`
            ).join("; ");
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
