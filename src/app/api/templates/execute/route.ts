import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { mimeFromExtension } from "@/lib/file-parsers";
import { isPathDisabled } from "@/lib/disabled-filter";
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

  // 全資料を収集（ライブ読み取り）
  const allTexts: string[] = [];
  const pdfFiles: { name: string; base64: string; mimeType: string }[] = [];
  const sourceFiles: { id: string; name: string; mimeType: string }[] = [];

  if (company.profile) {
    allTexts.push(`--- 基本情報サマリー ---\n${company.profile.summary}`);
  }

  for (const sub of company.subfolders) {
    const isActive = sub.role === "common" || (sub.role === "job" && sub.active);
    if (!isActive) continue;

    const files = await readAllFilesInFolder(sub.id);
    const disabled = sub.disabledFiles || [];

    for (const content of files) {
      if (isPathDisabled(content.path, disabled)) continue;
      const ext = path.extname(content.name).toLowerCase();
      const mime = mimeFromExtension(ext);
      sourceFiles.push({ id: content.path, name: content.name, mimeType: mime });
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
- 各確認項目は ## 見出しで区切る
- 各項目は結論を1〜2行で簡潔に記載。冗長な説明は不要
- 一覧系（役員・株主など）は表形式で簡潔に
- 不明・未確認の項目は「*要確認*」とだけ記載
- 根拠条文の引用は不要（ファイル名だけ記載）

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
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "meta",
          templateId: template.id,
          templateName: template.name,
          sourceFiles,
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
