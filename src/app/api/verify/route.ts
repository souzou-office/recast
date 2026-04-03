import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";
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

  // 案件フォルダの書類を読み込み
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string };

  const contentBlocks: ContentBlock[] = [];
  const textParts: string[] = [];
  const sourceFiles: { id: string; name: string; mimeType: string }[] = [];

  for (const sub of company.subfolders) {
    const isActive = sub.role === "common" || (sub.role === "job" && sub.active);
    if (!isActive) continue;

    const disabled = sub.disabledFiles ?? [];
    const files = await readAllFilesInFolder(sub.id);

    for (const fc of files) {
      if (isPathDisabled(fc.path, disabled)) continue;

      // fileIds filter (using file path as id)
      if (fileIdSet && !fileIdSet.has(fc.path)) continue;

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

  // マスターシートと基本情報をまとめる
  const referenceData: Record<string, unknown> = {};
  if (profile?.structured) referenceData["基本情報"] = profile.structured;
  if (masterSheet?.structured) referenceData["案件整理結果"] = masterSheet.structured;
  if (masterSheet?.content) referenceData["案件整理テキスト"] = masterSheet.content;

  const prompt = `以下の「参照データ（案件整理で抽出した情報）」と「書類（原本）」を突合せして、相違点・記載漏れ・矛盾を指摘してください。

## 参照データ
${JSON.stringify(referenceData, null, 2)}

## 書類内容
${textParts.join("\n\n")}

ルール:
- 各チェック項目を ## 見出しで区切る
- 一致している場合は「✅ 一致」と簡潔に記載
- 相違がある場合は「❌ 相違あり」として具体的に差異を記載（参照データの値 vs 書類の値）
- 書類に記載がない情報は「⚠ 書類に記載なし」
- 参照データにない情報が書類にある場合は「ℹ️ 書類のみに記載」
- 最後に総合判定（問題なし / 要確認あり）を記載`;

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
