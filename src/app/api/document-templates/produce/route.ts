import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import fs from "fs/promises";
import path from "path";
import type { DocumentTemplate } from "@/types";

const client = new Anthropic();
const TEMPLATES_PATH = path.join(process.cwd(), "data", "document-templates.json");

// マスターシート + 書類雛形 → 書類一式を生成（ストリーミング）
export async function POST(request: NextRequest) {
  const { companyId, templateIds, documentNames } = await request.json() as {
    companyId: string;
    templateIds: string[];
    documentNames?: string[];
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return new Response(JSON.stringify({ error: "会社が見つかりません" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  // 雛形を読み込み
  let allTemplates: DocumentTemplate[] = [];
  try {
    const raw = await fs.readFile(TEMPLATES_PATH, "utf-8");
    allTemplates = JSON.parse(raw);
  } catch { /* ignore */ }

  const selectedTemplates = allTemplates.filter(t => templateIds.includes(t.id));
  if (selectedTemplates.length === 0 && (!documentNames || documentNames.length === 0)) {
    return new Response(JSON.stringify({ error: "書類または雛形を選択してください" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // マスターシートとプロファイルを取得
  const masterSheet = company.masterSheet?.structured;
  const profile = company.profile?.structured;

  const dataContext = JSON.stringify({
    基本情報: profile || {},
    案件情報: masterSheet || {},
  }, null, 2);

  const templatesText = selectedTemplates.map(t =>
    `=== ${t.name}（${t.category}）===\n${t.content}`
  ).join("\n\n");

  const docNamesList = documentNames && documentNames.length > 0
    ? `\n## 作成する書類\n${documentNames.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n`
    : "";

  const prompt = `以下の会社データを使って、書類一式を生成してください。

## 会社データ
${dataContext}
${docNamesList}
${templatesText ? `## 書類雛形（これに沿って生成）\n${templatesText}` : ""}

ルール:
- 雛形の{{プレースホルダー}}を会社データで埋めてください
- データにない情報は{{要確認: 項目名}}としてください
- 配列データ（役員が複数人など）の場合、必要な通数分の書類を生成してください
- 各書類は「=== [書類名] ===」で区切ってください
- 書式・文言は雛形を忠実に再現してください`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const aiStream = client.messages.stream({
          model: "claude-sonnet-4-6",
          max_tokens: 8192,
          messages: [{ role: "user", content: prompt }],
        });

        for await (const event of aiStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text", text: event.delta.text })}\n\n`));
          }
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
      } catch (e) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: e instanceof Error ? e.message : "生成に失敗" })}\n\n`));
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
