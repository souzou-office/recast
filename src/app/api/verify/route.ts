import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder, readFileContent } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";
import { mimeFromExtension } from "@/lib/file-parsers";
import path from "path";

const client = new Anthropic();

// 案件整理の結果と書類を突合せ
export async function POST(request: NextRequest) {
  const { companyId, fileIds } = await request.json() as { companyId: string; fileIds?: string[] };
  const fileIdSet = fileIds ? new Set(fileIds) : null;

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return new Response(JSON.stringify({ error: "会社が見つかりません" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  const masterSheet = company.masterSheet;
  const profile = company.profile;

  if (!masterSheet && !profile) {
    return new Response(JSON.stringify({ error: "案件整理または基本情報を先に生成してください" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // 指定されたファイルを直接読み込み
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
          title: fc.name,
        });
      } else {
        textParts.push(`【${fc.name}】\n${fc.content}`);
      }
    }
  } else {
    // 指定なし → activeフォルダの全ファイル
    for (const sub of company.subfolders) {
      const isActive = sub.role === "common" || (sub.role === "job" && sub.active);
      if (!isActive) continue;

      const disabled = sub.disabledFiles ?? [];
      const files = await readAllFilesInFolder(sub.id);

      for (const fc of files) {
        if (isPathDisabled(fc.path, disabled)) continue;
        sourceFiles.push({ id: fc.path, name: fc.name, mimeType: fc.mimeType || "application/octet-stream" });

        if (fc.base64) {
          contentBlocks.push({
            type: "document",
            source: { type: "base64", media_type: fc.mimeType || "application/pdf", data: fc.base64 },
            title: fc.name,
          });
        } else {
          textParts.push(`【${fc.name}】\n${fc.content}`);
        }
      }
    }
  }

  // マスターシートと基本情報をまとめる
  const referenceData: Record<string, unknown> = {};
  if (profile?.structured) referenceData["基本情報"] = profile.structured;
  if (masterSheet?.structured) referenceData["案件整理結果"] = masterSheet.structured;
  if (masterSheet?.content) referenceData["案件整理テキスト"] = masterSheet.content;

  const prompt = `以下の「案件資料（元データ）」と「生成書類」を突合せチェックしてください。

## 案件資料（元データ）
${JSON.stringify(referenceData, null, 2)}

## 生成書類
${textParts.join("\n\n")}

## チェック観点（重要度順）

### 1. 案件資料と生成書類の整合性
- 案件フォルダの資料に記載されている情報と、生成された書類の記載が一致しているか
- 日付、金額、人名、住所などの転記ミスがないか

### 2. 生成書類間の整合性
- 複数の書類間で、同じ情報（日付、人名、会社名等）が一致しているか
- ある書類で記載した内容が、別の書類と矛盾していないか

### 3. 記載漏れ
- 「（要確認）」が残っている箇所

## 出力フォーマット
1. 総合判定（✅ 問題なし or ❌ 要確認あり）

2. 問題がある場合のみ、表で報告:

| チェック観点 | 書類 | 問題内容 | 重要度 |
|------------|------|---------|--------|

重要度: 🔴重大 / 🟡注意 / 🔵軽微

3. 問題なしの場合は「全書類間で整合性が取れています」と簡潔に

ルール:
- 問題のない項目は一切記載しない（登記簿の内容を羅列しない）
- 問題がある箇所だけ報告
- 簡潔に`;

  contentBlocks.push({ type: "text", text: prompt });

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
