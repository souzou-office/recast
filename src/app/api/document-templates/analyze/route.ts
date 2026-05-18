// /api/document-templates/analyze
// Phase 2 = 「手続き上の整理」(テンプレ突き合わせ分析)。
// Phase 1 (案件整理 = 実体判断) と clarify (実体の質問回答) の結果を踏まえて、
// 選んだテンプレ群と突き合わせ、以下を md レポートで返す:
//   ① テンプレ vs 実体判断の齟齬 (議案の取捨候補)
//   ② 書類間の統一性チェック (表記揺れ・値の整合)
//   ③ 穴の確認 (未確定スロット一覧、各書類で何個埋まらないか)
//   末尾に ⚠ Phase 2 要確認事項 リスト (clarify2 で聞くべき項目)
//
// 出力はあくまで「分析レポート」。実際の議案削除・値置換は次のターン (produce) が担当。
// このターンを挟むメリット: Phase 1 (実体判断) の決定が、選んだテンプレに対して
// 「具体的にどこで衝突するか」を一覧化し、生成前にユーザーが書面ルール上の確認を済ませられる。

import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
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

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

export async function POST(request: NextRequest) {
  const { companyId, threadId, templateFolderPath } = (await request.json()) as {
    companyId: string;
    threadId: string;
    templateFolderPath?: string;
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return new Response(JSON.stringify({ error: "会社が見つかりません" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  // organize (Phase 1) が完了済みであることを前提にする
  let aiMessages = await loadAiMessages(company.id, threadId);
  if (!hasStage(aiMessages, "organize")) {
    return new Response(JSON.stringify({ error: "案件整理 (Phase 1) が完了していません" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  // analyze の再実行時は analyze 以降を切り戻す (produce/verify があれば一緒に落ちる)
  aiMessages = truncateBeforeStage(aiMessages, "analyze");

  // --- テンプレ情報の収集 ---
  // 各テンプレについて:
  //   - 書類名
  //   - スロット (slot label の一覧、または placeholder 名)
  //   - 議案ブロック構造 (parseDocxStructure)
  // を AI プロンプトに渡す。実体は produce で読むので、ここでは「骨格」だけ
  const templateBlocks: string[] = [];
  if (templateFolderPath) {
    try {
      const templateFiles = await readAllFilesInFolder(templateFolderPath);
      const { ensureDocxLabels, ensureXlsxLabels } = await import("@/lib/template-labels");
      const { parseDocxStructure } = await import("@/lib/docx-structure-parser");

      for (const tf of templateFiles) {
        if (tf.base64) continue;
        const ext = tf.name.toLowerCase().split(".").pop() || "";
        const baseName = tf.name.replace(/\.[^.]+$/, "");
        const lines: string[] = [`### ${baseName}`];

        // ラベル (要入力_N → 意味ラベル)
        let labelLines: string[] = [];
        if (ext === "docx" || ext === "docm") {
          try {
            const labels = await ensureDocxLabels(tf.path);
            if (labels) {
              const seen = new Set<string>();
              for (const s of labels.slots) {
                if (!s.label || s.label === "不明" || seen.has(s.label)) continue;
                seen.add(s.label);
                const format = s.format ? ` (形式: ${s.format})` : "";
                labelLines.push(`  - ${s.label}${format}`);
              }
            }
          } catch { /* ignore */ }
        } else if (ext === "xlsx" || ext === "xlsm" || ext === "xls") {
          try {
            const labels = await ensureXlsxLabels(tf.path);
            if (labels) {
              const seen = new Set<string>();
              for (const s of labels.slots) {
                if (!s.label || s.label === "不明" || seen.has(s.label)) continue;
                seen.add(s.label);
                labelLines.push(`  - ${s.label}`);
              }
            }
          } catch { /* ignore */ }
        }

        // placeholder 形式 ({{...}}, 【...】)
        if (tf.content) {
          const phPatterns = [/【([^】]+)】/g, /\{\{([^}]+)\}\}/g, /｛｛([^｝]+)｝｝/g];
          const found = new Set<string>();
          for (const re of phPatterns) {
            let m;
            while ((m = re.exec(tf.content)) !== null) {
              const name = m[1].trim();
              if (name.startsWith("#") || name.startsWith("/")) continue;
              if (!found.has(name)) {
                found.add(name);
                labelLines.push(`  - ${name}`);
              }
            }
          }
        }

        if (labelLines.length > 0) {
          lines.push(`スロット (${labelLines.length}件):`);
          lines.push(...labelLines.slice(0, 30)); // 多すぎたら頭の方だけ
          if (labelLines.length > 30) lines.push(`  ... (他 ${labelLines.length - 30}件)`);
        }

        // 議案ブロック構造 (docx のみ)
        if (ext === "docx" || ext === "docm") {
          try {
            const buf = await fs.readFile(tf.path);
            const structure = parseDocxStructure(buf);
            if (structure.sections.length > 0) {
              lines.push(`議案ブロック:`);
              for (const sec of structure.sections) {
                lines.push(`  - ${sec}`);
              }
            }
          } catch { /* ignore */ }
        }

        if (lines.length > 1) templateBlocks.push(lines.join("\n"));
      }
    } catch (e) {
      console.warn("[analyze] template scan failed:", e instanceof Error ? e.message : e);
    }
  }

  const templateInfoBlock = templateBlocks.length > 0
    ? `\n## 選んだ書類テンプレートの骨格 (スロット + 議案ブロック)\n\n${templateBlocks.join("\n\n")}\n`
    : "\n## 選んだ書類テンプレートの骨格\n(テンプレ情報を読めませんでした)\n";

  const userTurnText = `## あなたが今やること (ターン3: Phase 2 = テンプレ突き合わせ分析)

ターン1 (案件整理 = 実体判断) で出した判断と、ターン2 (実体確認質問の回答) を踏まえて、
これから使う書類テンプレート群と **突き合わせ分析** を行ってください。

このターンの目的は **「書類を生成する前に、書面ルール上で確認すべきこと」を洗い出す** ことです。
**まだ書類は生成しません**。値の精密抽出も次のターンです。

${templateInfoBlock}

## 出力フォーマット (必ずこの形式で md)

3つのセクション + 末尾に要確認事項。

\`\`\`
# Phase 2 テンプレ整理結果

## ① テンプレ vs 実体判断の齟齬

ターン1で「今回該当なし」と判断した議案がテンプレに含まれているか、
または「追加で必要」とした議案がテンプレに無いかを書き出す。

- 「議事録.docx」第3号議案「役員報酬の決定の件」 → ターン1 で『今回該当なし』 → **削除推奨**
- 「招集通知.docx」「監査報告」セクション → ターン1 で『監査役関連 該当なし』 → **削除推奨**
- (追加が必要な議案があれば「テンプレに無いが追加すべき」と書く)

## ② 統一性チェック

書類間で同じ値が出てくるスロット (会社名・代表者名・決議日等) を見つけ、
ターン1の確定値 / 要確認の有無を確認する。

- 「会社名」: 5書類で使用、ターン1で「株式会社JINGS」確定 ✓
- 「代表者氏名」: 3書類で使用、ターン1で確定値あり ✓
- 「引受人名」: 4書類で使用、ターン1で要確認 (商号表記揺れ) ⚠

## ③ 穴の確認

各書類でターン1 + ターン2の回答だけで埋まらない可能性のあるスロットを書き出す。
(値抽出は次のターンでやるが、今の段階でも明らかに不足なものは洗い出せる)

### 議事録.docx (11 スロット)
- 確定可能: 8
- 要確認: 3
  - 払込期日 (案件ファイル参照で取得可)
  - 引受人正式商号 (上記の要確認案件)
  - 株主総会基準日公告日 (ターン1 ⚠で未確定)

### 招集通知.docx (7 スロット)
- 確定可能: 6
- 要確認: 1
  - 取締役会決議日 (ターン1で資料間矛盾)

## ⚠ Phase 2 要確認事項 (書面ルール上の確認、最大10件)

1. 「議事録.docx」第3号議案 (役員報酬) を削除でよいですか？
2. 引受人の正式商号は全書類で「××株式会社」「株式会社××」どちらに統一しますか？
3. 株主総会基準日の公告日が未定 → 公告予定日を教えてください
4. 取締役会決議日: 5/20 (投資契約書) vs 5/22 (スケジュール表) → どちらで全書類を作成しますか？
5. ...
\`\`\`

## 重要原則

1. **書類を生成しない**。骨格分析のみ
2. **議案削除の決定権はユーザー**。AI は「削除推奨」と書くだけで実行しない
3. **要確認事項は書面ルール上のもの**に絞る (実体的な事実は Phase 1 で確認済)
4. **既に Phase 1 の clarify で回答済みの内容を再質問しない**
5. 出力は **必ず md** (構造化 JSON は不要)`;

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
            max_tokens: 8192,
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
          } catch { /* ignore */ }

          const finalMessages = appendAssistantTurn(messagesWithUserTurn, assistantText, "analyze");
          await saveAiMessages(company.id, threadId, finalMessages);

          send(controller, { type: "done" });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error("[analyze] stream failed:", errMsg);
          try { send(controller, { type: "error", error: errMsg }); } catch { /* closed */ }
        } finally {
          try { controller.close(); } catch { /* closed */ }
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
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
