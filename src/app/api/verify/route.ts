import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder, readFileContent } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";
import { mimeFromExtension } from "@/lib/file-parsers";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");

const client = new Anthropic();

// 生成済みdocxのbase64からテキストを抽出
async function extractDocxText(base64: string): Promise<string> {
  try {
    const buffer = Buffer.from(base64, "base64");
    const result = await mammoth.extractRawText({ buffer });
    return result.value?.trim() || "";
  } catch {
    return "";
  }
}

// 案件整理の結果と生成書類を突合せ
export async function POST(request: NextRequest) {
  const { companyId, fileIds, caseRoomId, threadId } = await request.json() as {
    companyId: string;
    fileIds?: string[];
    caseRoomId?: string;
    threadId?: string;
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return new Response(JSON.stringify({ error: "会社が見つかりません" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  // スレッドから生成書類を取得（ChatWorkflow経由）
  let threadDocs: { templateName: string; docxBase64: string; previewHtml: string; fileName: string }[] = [];
  if (threadId) {
    try {
      const fs = await import("fs/promises");
      const nodePath = await import("path");
      const dataDir = nodePath.default.join(process.cwd(), "data", "chat-threads", companyId);
      const threadFile = nodePath.default.join(dataDir, `${threadId}.json`);
      const raw = await fs.default.readFile(threadFile, "utf-8");
      const thread = JSON.parse(raw);
      if (thread.generatedDocuments) threadDocs = thread.generatedDocuments;
    } catch { /* ignore */ }
  }

  const caseRoom = caseRoomId ? company.caseRooms?.find(r => r.id === caseRoomId) : null;
  const masterSheet = caseRoom?.masterSheet || company.masterSheet;
  const profile = company.profile;
  const generatedDocuments = threadDocs.length > 0
    ? threadDocs
    : (caseRoom?.generatedDocuments || company.generatedDocuments || []);

  if (generatedDocuments.length === 0) {
    return new Response(JSON.stringify({ error: "生成済み書類がありません。先に書類を生成してください。" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // --- 1. 生成済み書類のテキスト抽出 ---
  const generatedTexts: string[] = [];
  for (const doc of generatedDocuments) {
    const text = await extractDocxText(doc.docxBase64);
    if (text) {
      generatedTexts.push(`【生成書類: ${doc.fileName}】\n${text}`);
    }
  }

  // --- 2. 原本ファイルの読み込み ---
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string };

  const contentBlocks: ContentBlock[] = [];
  const textParts: string[] = [];
  const sourceFiles: { id: string; name: string; mimeType: string }[] = [];

  if (fileIds && fileIds.length > 0) {
    // ファイルパスが指定されている場合、直接読む
    for (const filePath of fileIds) {
      const fc = await readFileContent(filePath);
      if (!fc) continue;

      const ext = path.extname(fc.name).toLowerCase();
      const mime = mimeFromExtension(ext);
      sourceFiles.push({ id: fc.path, name: fc.name, mimeType: mime });

      if (fc.base64) {
        contentBlocks.push({
          type: "document",
          source: { type: "base64", media_type: fc.mimeType || "application/pdf", data: fc.base64 },
          title: `[原本] ${fc.name}`,
        });
      } else {
        textParts.push(`【原本: ${fc.name}】\n${fc.content}`);
      }
    }
  } else {
    // 共通フォルダ（基本情報）と案件フォルダ（手続き内容）を分けて収集
    const commonTexts: string[] = [];
    const caseTexts: string[] = [];

    for (const sub of company.subfolders) {
      const isActive = sub.role === "common" || (sub.role === "job" && sub.active);
      if (!isActive) continue;

      const disabled = sub.disabledFiles ?? [];
      const files = await readAllFilesInFolder(sub.id);
      const isCommon = sub.role === "common";

      for (const fc of files) {
        if (isPathDisabled(fc.path, disabled)) continue;
        sourceFiles.push({ id: fc.path, name: fc.name, mimeType: fc.mimeType || "application/octet-stream" });

        if (fc.base64) {
          contentBlocks.push({
            type: "document",
            source: { type: "base64", media_type: fc.mimeType || "application/pdf", data: fc.base64 },
            title: `${isCommon ? "[原本/基本情報]" : "[原本/案件]"} ${fc.name}`,
          });
        } else {
          if (isCommon) {
            commonTexts.push(`【${fc.name}】\n${fc.content}`);
          } else {
            caseTexts.push(`【${fc.name}】\n${fc.content}`);
          }
        }
      }
    }
    if (commonTexts.length > 0) {
      textParts.push("=== 原本: 共通フォルダ（定款・登記簿・株主名簿等の会社基本情報）===\n" + commonTexts.join("\n\n"));
    }
    if (caseTexts.length > 0) {
      textParts.push("=== 原本: 案件フォルダ（今回の手続き内容: 議事録・指示書・スケジュール等）===\n" + caseTexts.join("\n\n"));
    }
  }

  // --- 3. 案件整理結果 ---
  const referenceData: Record<string, unknown> = {};
  if (profile?.structured) referenceData["基本情報"] = profile.structured;
  if (masterSheet?.structured) referenceData["案件整理結果"] = masterSheet.structured;
  if (masterSheet?.content) referenceData["案件整理テキスト"] = masterSheet.content;

  // --- 4. プロンプト構築 ---
  const prompt = `以下の「原本（元資料）」と「生成済み書類（recastが作成した書類）」を突合せチェックしてください。

## 案件整理結果
${JSON.stringify(referenceData, null, 2)}

## 原本（元資料）
${textParts.join("\n\n")}

## 生成済み書類（チェック対象）
${generatedTexts.join("\n\n")}

## チェック観点（重要度順）

### 1. 原本と生成書類の整合性
- 原本（定款・登記簿・株主名簿・議事録・指示書等）に記載されている情報と、生成書類の記載が一致しているか
- 日付、金額、人名、住所、株数、持分比率などの転記ミスがないか
- 原本に基づいて正しく計算されているか（株数の合計、議決権数など）

### 2. 生成書類間の整合性
- 複数の生成書類間で、同じ情報（日付、人名、会社名等）が一致しているか
- ある書類で記載した内容が、別の書類と矛盾していないか

### 3. 記載漏れ・形式
- 「（要確認）」が残っている箇所
- 必要な情報が空欄や未記入のまま

## 出力フォーマット
1. 総合判定（✅ 問題なし or ❌ 要確認あり）

2. 問題がある場合のみ、表で報告:

| チェック観点 | 生成書類 | 問題内容 | 原本の正しい値 | 重要度 |
|------------|---------|---------|--------------|--------|

重要度: 🔴重大 / 🟡注意 / 🔵軽微

3. 問題なしの場合は「全書類の記載内容が原本と一致しています」と簡潔に

ルール:
- 問題のない項目は一切記載しない
- 問題がある箇所だけ、原本の正しい値と合わせて報告
- 簡潔に`;

  contentBlocks.push({ type: "text", text: prompt });

  // 生成書類のファイル名もsourceFilesに追加（リンク用）
  for (const doc of generatedDocuments) {
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
          model: "claude-sonnet-4-6",
          max_tokens: 8192,
          messages: [{ role: "user", content: contentBlocks as Anthropic.ContentBlockParam[] }],
        });

        for await (const event of aiStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            send({ type: "text", text: event.delta.text });
          }
        }

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
