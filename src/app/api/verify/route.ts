import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx");

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

/**
 * 検証 = 「1案件1会話」のターン4。
 *
 * 旧設計: 検証担当 Claude を「はじめまして」状態で呼び、原本+生成書類+Q&A を毎回再送していた。
 *   この Claude は organize/clarify/produce で各値がどう判断されたかを知らないため、
 *   「これは organize で迷った末に選んだ値」のような文脈を持たずにチェックしていた。
 * 新設計: produce が会話に書き込んだ「自分が各書類の各スロットに入れた値」を、同じ Claude が
 *   ターン4で自己レビューする形にする。Claude は organize での迷い・clarify でユーザーに
 *   確認した結果を全て覚えているので、「自分が怪しいと思っていた所」を集中チェックできる。
 *
 * 注: 原本ファイルは organize（ターン1）で既に Claude に渡している。verify でも fileIds 経由で
 *   個別に追加できるが、通常は同じ案件資料が前提なので会話履歴のみで成立する。
 */

// 生成書類の base64 からテキストを抽出
async function extractDocumentText(base64: string, fileName: string): Promise<string> {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  try {
    const buffer = Buffer.from(base64, "base64");
    if (ext === "xlsx" || ext === "xlsm" || ext === "xls") {
      const wb = XLSX.read(buffer, { type: "buffer" });
      const parts: string[] = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        const csv: string = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        if (csv.trim()) parts.push(`[シート: ${sheetName}]\n${csv}`);
      }
      return parts.join("\n\n").trim();
    }
    const result = await mammoth.extractRawText({ buffer });
    return result.value?.trim() || "";
  } catch {
    return "";
  }
}

export async function POST(request: NextRequest) {
  const { companyId, threadId } = await request.json() as {
    companyId: string;
    fileIds?: string[]; // 互換のため残すが現在は未使用
    caseRoomId?: string; // 互換のため残すが現在は未使用
    threadId?: string;
    folderPath?: string;
    disabledFiles?: string[];
  };

  if (!threadId) {
    return new Response(JSON.stringify({ error: "threadId が必要です" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return new Response(JSON.stringify({ error: "会社が見つかりません" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  // スレッドから生成書類を取得
  let threadDocs: { templateName: string; docxBase64: string; previewHtml: string; fileName: string; filledSlots?: { slotId: number; label: string; value: string }[] }[] = [];
  try {
    const fs = await import("fs/promises");
    const nodePath = await import("path");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require("crypto");
    const companyHash = crypto.createHash("md5").update(companyId).digest("hex");
    const threadFile = nodePath.default.join(process.cwd(), "data", "chat-threads", companyHash, `${threadId}.json`);
    const raw = await fs.default.readFile(threadFile, "utf-8");
    const thread = JSON.parse(raw);
    if (thread.generatedDocuments) threadDocs = thread.generatedDocuments;
  } catch { /* ignore */ }

  if (threadDocs.length === 0) {
    return new Response(JSON.stringify({ error: "生成済み書類がありません。先に書類を生成してください。" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // 会話履歴を読み込み: organize/clarify/produce が完了している前提
  let aiMessages = await loadAiMessages(company.id, threadId);
  if (!hasStage(aiMessages, "organize")) {
    return new Response(JSON.stringify({ error: "案件整理（ターン1）が完了していません。先に案件整理してください。" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  // verify 再実行時は verify 以降のターンを切り戻す
  aiMessages = truncateBeforeStage(aiMessages, "verify");

  // 生成書類のテキスト抽出 + filledSlots 一覧
  const generatedTexts: string[] = [];
  for (const doc of threadDocs) {
    const text = await extractDocumentText(doc.docxBase64, doc.fileName);
    if (!text) continue;
    let docBlock = `【生成書類: ${doc.fileName}】\n${text}`;
    const slots = doc.filledSlots;
    if (slots && slots.length > 0) {
      docBlock += `\n\n[この書類の項目一覧（slotId 付き）]\n` +
        slots
          .filter(s => s.value && s.value.trim())
          .map(s => `- slotId=${s.slotId}: ${s.label} = "${s.value}"`)
          .join("\n");
    }
    generatedTexts.push(docBlock);
  }

  const userTurnText = `## あなたが今やること（ターン4: 生成書類のセルフレビュー）

ターン3で各書類のスロットに値を埋めましたね。その結果テキストが下にあります。
**自分自身がやった作業を、もう一度原本と突き合わせて確認** してください。

その上で、**人間が目視で最終確認すべきこと** を箇条書きで列挙してください。
修正アクションは取らず、人間に「ここを見てほしい」と伝えるだけが目的です。

特に注意:
- ターン1（案件整理）で「迷った」「判断に揺れがあった」項目があれば、**その値が正しく入っているかを優先的に確認**
- ターン2（clarify）でユーザーに確認した値は **正しい前提**として扱う
- ターン1〜3で自分がした判断の根拠を思い出しながらチェックする

## 確認対象（値の正しさ）
- 日付・氏名・住所・会社名・金額・株数・持分比率などの**値**が、原本/基本情報/案件整理と不整合
- 値が \`（要確認）\` のまま残っている
- 書類間で同じ意味の値が不一致（書類Aの代表取締役氏名 ≠ 書類Bの代表取締役氏名 等）
- 必須の値が空欄

## 取り上げないもの（recast が触っていない部分）
- **条文番号の体系**（第1条、第2条 等、①②③ 等、(1)(2)(3) 等）
- **箇条書き記号の揺れ**
- **全角半角の違い**、空白・改行・句読点の差
- 見出し・定型文・章立て等、テンプレート由来の固定文言
- **Word の自動番号付け機能による番号の抽出漏れ**: テキスト抽出の限界で実体の問題ではない。**絶対に取り上げないこと**
- **slot 値が partial に見える件**: テンプレの固定文字 + slot 値が連結されて本文になる。
  例: テンプレ「東〜京都〇〇」+ slot「京都〇〇」→ 本文「東京都〇〇」(正しい)。
  slot 単体が不完全に見えても、**生成書類本文が正しければ取り上げない**。

**判定の指針**: 「この不整合は recast が値を埋める際のミスか、それともテンプレ由来・抽出ツール由来か」を必ず自問し、後者なら一覧に含めない。
**重要**: 「**生成書類本文（[この書類の項目一覧] より上のテキスト）**」を判断材料の主軸にすること。

## 生成書類（チェック対象）
${generatedTexts.join("\n\n")}

## 出力フォーマット

**Markdown のチェックリスト形式** で、書類ごとに見出しを立てて出力してください。
各項目は \`- [ ] \` で始まる1行（必要ならカッコ内に補足）。JSON は使わない。

例:

\`\`\`markdown
## 最終確認してほしいこと

### 1.取締役決定書
- [ ] 代表取締役の氏名が「三上春香」になっているか（基本情報では「三上春香」だが書面は「福田峻介」となっている）
- [ ] 払込金額の単位「円」が抜けていないか

### 2.総数引受契約書
- [ ] 代表取締役の住所が原本と一致しているか
\`\`\`

ルール:
- 全ての生成書類について、確認事項があれば見出しを立てる。**問題なしなら見出し自体を出さない**
- 全書類で確認事項ゼロなら、本文に **「最終確認が必要な事項は見つかりませんでした。」** だけ返す
- 重大度や severity の記号は付けない（人間がリストを目で追って確認するため、フラットでよい）`;

  const messagesWithUserTurn = appendUserTurn(aiMessages, userTurnText, "verify");

  // 生成書類のファイル名も sourceFiles に追加（リンク用）
  const sourceFiles: { id: string; name: string; mimeType: string }[] = [];
  for (const doc of threadDocs) {
    sourceFiles.push({ id: `generated:${doc.fileName}`, name: `[生成] ${doc.fileName}`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ type: "meta", sourceFiles });

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
            send({ type: "text", text: event.delta.text });
          }
        }

        try {
          const final = await aiStream.finalMessage();
          logTokenUsage("/api/verify", MODEL, final.usage);
        } catch { /* ignore */ }

        // assistant ターンを保存
        const finalMessages = appendAssistantTurn(messagesWithUserTurn, assistantText, "verify");
        await saveAiMessages(company.id, threadId, finalMessages);

        send({ type: "done" });
      } catch (e) {
        send({ type: "error", error: e instanceof Error ? e.message : "突合せに失敗" });
      } finally {
        controller.close();
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
}
