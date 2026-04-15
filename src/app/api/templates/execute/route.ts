import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { mimeFromExtension } from "@/lib/file-parsers";
import { isPathDisabled } from "@/lib/disabled-filter";

const client = new Anthropic();

export async function POST(request: NextRequest) {
  const { companyId, folderPath, disabledFiles } = await request.json() as {
    companyId: string;
    folderPath?: string;
    disabledFiles?: string[];
  };

  const config = await getWorkspaceConfig();
  const company = companyId
    ? config.companies.find(c => c.id === companyId)
    : config.companies.find(c => c.id === config.selectedCompanyId);

  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // 全資料を収集
  const allTexts: string[] = [];
  const pdfFiles: { name: string; base64: string; mimeType: string }[] = [];
  const sourceFiles: { id: string; name: string; mimeType: string }[] = [];

  if (folderPath) {
    // チャットのフォルダ選択カードで指定されたパスを読む
    const files = await readAllFilesInFolder(folderPath);
    const disabled = disabledFiles || [];
    for (const content of files) {
      if (disabled.includes(content.path)) continue;
      const ext = path.extname(content.name).toLowerCase();
      const mime = mimeFromExtension(ext);
      sourceFiles.push({ id: content.path, name: content.name, mimeType: mime });
      if (content.base64) {
        pdfFiles.push({ name: content.name, base64: content.base64, mimeType: content.mimeType || "application/pdf" });
      } else {
        allTexts.push(`--- ${content.name} ---\n${content.content}`);
      }
    }
  } else {
    // フォールバック: sub.role === "job" && sub.active の案件フォルダ
    for (const sub of company.subfolders) {
      if (!(sub.role === "job" && sub.active)) continue;
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
  }

  if (allTexts.length === 0 && pdfFiles.length === 0) {
    return NextResponse.json({ error: "案件フォルダに読み取れるファイルがありません" }, { status: 400 });
  }

  const promptText = `以下の「案件資料」を確認し、今回の手続き・案件に関する情報だけを抽出・整理してください。

ルール:
- **出力するのは「案件固有の情報」だけ**（スケジュール、手続内容、指示事項、議案、当事者、対象株式等）
- **会社の基本情報（商号・本店・事業目的・役員構成等）は出力しない**。それは別管理（基本情報タブ）で扱う
- 各カテゴリは ## 見出しで区切る
- 結論を簡潔に記載。冗長な説明は不要
- 一覧系は表形式で簡潔に
- 日付・金額・人名は正確に転記
- 矛盾や不整合があれば「⚠ 要確認」として指摘
- 根拠となるファイル名を各項目に記載
- 不明・未確認の情報は「*要確認*」とだけ記載

## 案件資料
${allTexts.join("\n\n")}`;

  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

  const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

  const contentBlocks: ContentBlock[] = [];
  for (const pdf of pdfFiles) {
    if (pdf.mimeType === "application/pdf") {
      contentBlocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
        title: pdf.name,
      });
    } else if (IMAGE_MIMES.has(pdf.mimeType)) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: pdf.mimeType, data: pdf.base64 },
      });
    }
    // それ以外のbase64（未対応MIME）はスキップ
  }
  contentBlocks.push({ type: "text", text: promptText });

  try {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "meta",
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
