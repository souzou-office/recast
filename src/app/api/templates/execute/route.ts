import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { readFileById } from "@/lib/files-google";
import type { CheckTemplate } from "@/types";

const client = new Anthropic();
const TEMPLATES_PATH = path.join(process.cwd(), "data", "templates.json");

export async function POST(request: NextRequest) {
  const { templateId } = await request.json();

  const raw = await fs.readFile(TEMPLATES_PATH, "utf-8");
  const templates: CheckTemplate[] = JSON.parse(raw);
  const template = templates.find(t => t.id === templateId);
  if (!template) {
    return NextResponse.json({ error: "テンプレートが見つかりません" }, { status: 404 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === config.selectedCompanyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // 全資料を収集
  const allTexts: string[] = [];
  const pdfFiles: { name: string; base64: string; mimeType: string }[] = [];

  if (company.profile) {
    allTexts.push(`--- 基本情報サマリー ---\n${company.profile.summary}`);
  }

  for (const sub of company.subfolders) {
    const isActive = sub.role === "common" || (sub.role === "job" && sub.active);
    if (!isActive || !sub.files) continue;

    for (const f of sub.files) {
      if (!f.enabled) continue;
      const content = await readFileById(f.id, f.name, f.mimeType);
      if (!content) continue;
      if (content.base64) {
        pdfFiles.push({ name: content.name, base64: content.base64, mimeType: content.mimeType || "application/pdf" });
      } else {
        allTexts.push(`--- ${content.name} ---\n${content.content}`);
      }
    }
  }

  if (allTexts.length === 0 && pdfFiles.length === 0) {
    return NextResponse.json({ error: "読み取れるファイルがありません" }, { status: 400 });
  }

  const itemList = template.items.map((item, i) => `${i + 1}. ${item}`).join("\n");

  const promptText = `以下の資料を全て確認し、確認項目について情報を抽出・整理してください。

確認項目:
${itemList}

ルール:
- 全項目について必ず回答してください
- 結果は具体的に詳細を記載してください（氏名・住所・日付など省略しない）
- 一覧系（役員・株主など）は表形式で全員分記載してください
- 情報が見つからない場合はその旨記載してください
- 推論できる場合は推論して回答してください
- マークダウン形式で見やすく整理してください（見出し・表・箇条書きを適切に使用）
- 各確認項目は ## 見出しで区切ってください
- 各項目の結論・要点は **太字** で強調してください
- 情報が不足している・要確認の箇所は *斜体* で記載してください（例: *新任役員の情報は資料に記載がありません。別途確認が必要です。*）
- 定款や登記簿の根拠条文があれば引用してください

資料:
${allTexts.join("\n\n")}`;

  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string };

  const contentBlocks: ContentBlock[] = [];
  for (const pdf of pdfFiles) {
    contentBlocks.push({
      type: "document",
      source: { type: "base64", media_type: pdf.mimeType, data: pdf.base64 },
      title: pdf.name,
    });
  }
  contentBlocks.push({ type: "text", text: promptText });

  try {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // 最初にメタ情報を送る
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "meta",
          templateId: template.id,
          templateName: template.name,
        })}\n\n`));

        const aiStream = client.messages.stream({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          messages: [{ role: "user", content: contentBlocks as Anthropic.ContentBlockParam[] }],
        });

        for await (const event of aiStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: "text",
              text: event.delta.text,
            })}\n\n`));
          }
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        controller.close();
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
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "実行に失敗しました" },
      { status: 500 }
    );
  }
}
