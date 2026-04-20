import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { mimeFromExtension } from "@/lib/file-parsers";
import { isPathDisabled } from "@/lib/disabled-filter";

const client = new Anthropic();

export async function POST(request: NextRequest) {
  const { companyId, folderPath, disabledFiles, templateFolderPath } = await request.json() as {
    companyId: string;
    folderPath?: string;
    disabledFiles?: string[];
    templateFolderPath?: string;
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

  // テンプレートが指定されていれば、必要な「記載項目」を抽出して渡す（値は渡さない）
  let templateContext = "";
  if (templateFolderPath) {
    try {
      const templateFiles = await readAllFilesInFolder(templateFolderPath);
      const itemsByFile: string[] = [];

      for (const tf of templateFiles) {
        if (tf.base64) continue;
        const ext = tf.name.toLowerCase().split(".").pop() || "";
        if (!["docx", "doc", "xlsx", "xls"].includes(ext)) continue;

        // プレースホルダーから項目名を抽出（簡易版）
        const phNames: string[] = [];
        const phPatterns = [/【([^】]+)】/g, /\{\{([^}]+)\}\}/g, /｛｛([^｝]+)｝｝/g];
        for (const re of phPatterns) {
          let m;
          while ((m = re.exec(tf.content)) !== null) {
            const name = m[1].trim();
            if (!name.startsWith("#") && !name.startsWith("/") && !phNames.includes(name)) {
              phNames.push(name);
            }
          }
        }
        if (phNames.length > 0) {
          itemsByFile.push(`- ${tf.name}: ${phNames.join(", ")}`);
          continue;
        }

        // ハイライトテンプレの場合、ファイルを読んでマーク付きフィールドの「周辺文脈」から項目名を推定
        if (ext === "docx") {
          try {
            const buf = await import("fs/promises").then(fs => fs.readFile(tf.path));
            const { extractMarkedFields } = await import("@/lib/docx-marker-parser");
            const fields = extractMarkedFields(buf);
            if (fields.length > 0) {
              // 周辺文脈（段落全体）から「○○: 値」の形を抽出してラベル化
              const labelSet = new Set<string>();
              for (const f of fields) {
                const ctx = (f.context || "").replace(/\s+/g, " ").trim();
                const val = f.originalValue;
                // ctx の中の val 位置を取得して前後を切り出す
                const idx = ctx.indexOf(val);
                const before = idx >= 0 ? ctx.slice(Math.max(0, idx - 40), idx).trim() : ctx.slice(0, 30);
                const after = idx >= 0 ? ctx.slice(idx + val.length, idx + val.length + 20).trim() : "";
                // 前の文脈から最後の見出し（「項目名：」や「項目名 」）を探す
                const m = before.match(/[一-龥ぁ-んァ-ヶA-Za-z0-9]+(?=[\s　:：]*$)/);
                let label = m ? m[0] : before.slice(-20);
                // よくある後置語を含めて分かりやすく
                if (after.startsWith("円")) label = (label + "（金額）").trim();
                else if (after.startsWith("株")) label = (label + "（株数）").trim();
                else if (after.startsWith("名")) label = (label + "（人数）").trim();
                else if (/年|月|日/.test(val)) label = label + "（日付）";
                if (label.length > 30) label = label.slice(-30);
                if (label.trim()) labelSet.add(label.trim());
                if (f.comment) labelSet.add(f.comment);
              }
              if (labelSet.size > 0) {
                itemsByFile.push(`- ${tf.name}: ${[...labelSet].join(", ")}`);
              }
            }
          } catch { /* ignore */ }
        }
      }

      if (itemsByFile.length > 0) {
        templateContext = `\n## 作成予定の書類と必要な記載項目\n以下の書類を作成する予定です。各書類に必要な項目の種類を示します。これらに該当する情報を案件資料から漏れなく抽出してください。\n${itemsByFile.join("\n")}\n`;
      }
    } catch { /* ignore */ }
  }

  const promptText = `以下の「案件資料」を確認し、今回の手続き・案件に関する情報を抽出・整理してください。
${templateContext}
ルール:
- **出力するのは「案件固有の情報」だけ**（スケジュール、手続内容、指示事項、議案、当事者、対象株式等）
- **会社の基本情報（商号・本店・事業目的・役員構成等）は出力しない**。それは別管理（基本情報タブ）で扱う
- **テンプレートが指定されている場合、テンプレートで必要な情報（日付・人名・金額・株数等）を漏れなく抽出する**
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
    }
    // 画像は案件整理では送らない（テキスト+PDFで十分、壊れた画像でAPIエラーになるリスク回避）
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
