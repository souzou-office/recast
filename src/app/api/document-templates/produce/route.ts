import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder, readFileContent } from "@/lib/files";
import fs from "fs/promises";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Docxtemplater = require("docxtemplater");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

const client = new Anthropic();

// テンプレートdocxからプレースホルダー【】を抽出
function extractPlaceholders(text: string): string[] {
  const matches = text.match(/【[^】]+】/g);
  return matches ? [...new Set(matches)] : [];
}

// 半角英数字→全角変換
function toFullWidth(str: string): string {
  return str.replace(/[A-Za-z0-9]/g, (c) => {
    return String.fromCharCode(c.charCodeAt(0) + 0xFEE0);
  });
}

// テンプレートフォルダ + マスターシート → 書類生成
export async function POST(request: NextRequest) {
  const { companyId, templateFolderPath, mode } = await request.json() as {
    companyId: string;
    templateFolderPath: string;
    mode?: "fill" | "generate"; // fill=プレースホルダー置換, generate=AI全文生成
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return new Response(JSON.stringify({ error: "会社が見つかりません" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  // テンプレートフォルダ内のファイルを読み込み
  const templateFiles = await readAllFilesInFolder(templateFolderPath);
  if (templateFiles.length === 0) {
    return new Response(JSON.stringify({ error: "テンプレートフォルダにファイルがありません" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // マスターシートとプロファイル
  const masterSheet = company.masterSheet;
  const profile = company.profile;

  const dataContext = JSON.stringify({
    基本情報: profile?.structured || {},
    案件情報: masterSheet?.structured || {},
  }, null, 2);

  // docxテンプレートを全部探す
  const docxFiles = templateFiles.filter(f =>
    (f.name.endsWith(".docx") || f.name.endsWith(".doc")) &&
    !f.name.toLowerCase().includes("メモ") &&
    !f.name.toLowerCase().includes("memo")
  );

  // メモファイル
  const memoFiles = templateFiles.filter(f =>
    f.name.toLowerCase().includes("メモ") ||
    f.name.toLowerCase().includes("memo") ||
    f.name.toLowerCase().includes("注意")
  );
  const memoText = memoFiles.map(f => f.content).join("\n\n");

  // docxテンプレートがある場合 → プレースホルダー置換モード
  if (docxFiles.length > 0 && mode !== "generate") {
    // 全docxからプレースホルダーを抽出
    const allPlaceholders = new Set<string>();
    for (const df of docxFiles) {
      for (const p of extractPlaceholders(df.content)) allPlaceholders.add(p);
    }

    if (allPlaceholders.size === 0) {
      return new Response(JSON.stringify({ error: "テンプレートに【プレースホルダー】が見つかりません" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    // AIにプレースホルダーの値を一括生成させる
    const placeholderList = Array.from(allPlaceholders).map(p => `- ${p}`).join("\n");
    const prompt = `以下の会社データから、テンプレートのプレースホルダーに入る値をJSON形式で返してください。

## 会社データ
${dataContext}
${masterSheet?.content ? `\n## 案件整理テキスト\n${masterSheet.content}\n` : ""}
${memoText ? `\n## 注意事項\n${memoText}\n` : ""}

## プレースホルダー一覧
${placeholderList}

回答はJSONのみ返してください。キーは【】を含むプレースホルダーそのまま、値は埋める文字列です。
データにない情報は "（要確認）" としてください。`;

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return new Response(JSON.stringify({ error: "AIの応答をパースできませんでした" }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }

      const values: Record<string, string> = JSON.parse(jsonMatch[0]);

      // 全角変換 + キー整理
      const templateData: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        const cleanKey = key.replace(/^【/, "").replace(/】$/, "");
        templateData[cleanKey] = toFullWidth(value);
      }

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mammoth = require("mammoth");

      // 各docxを処理
      const documents: { name: string; docxBase64: string; previewHtml: string; fileName: string }[] = [];

      for (const df of docxFiles) {
        try {
          const rawBuffer = await fs.readFile(df.path);
          const zip = new PizZip(rawBuffer);
          const doc = new Docxtemplater(zip, {
            delimiters: { start: "【", end: "】" },
            paragraphLoop: true,
            linebreaks: true,
            nullGetter: () => "（要確認）",
          });
          doc.render(templateData);

          const outputBuffer = doc.getZip().generate({ type: "nodebuffer" });
          const baseName = df.name.replace(/\.(docx?|doc)$/i, "");
          const outputName = `${company.name}_${baseName}.docx`;

          let previewHtml = "";
          try {
            const result = await mammoth.convertToHtml({ buffer: outputBuffer });
            previewHtml = result.value;
          } catch { /* ignore */ }

          documents.push({
            name: baseName,
            docxBase64: outputBuffer.toString("base64"),
            previewHtml,
            fileName: outputName,
          });
        } catch { /* skip failed template */ }
      }

      return new Response(JSON.stringify({ documents }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "生成に失敗しました" }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  // docxテンプレートがない or generate mode → AI全文生成（ストリーミング）
  const templates: string[] = [];
  for (const f of templateFiles) {
    if (f.base64) continue;
    const isNote = f.name.toLowerCase().includes("メモ") || f.name.toLowerCase().includes("memo");
    if (!isNote) templates.push(`【テンプレート: ${f.name}】\n${f.content}`);
  }

  const prompt = `以下の会社データとテンプレートを使って、書類を生成してください。

## 会社データ
${dataContext}
${masterSheet?.content ? `\n## 案件整理テキスト\n${masterSheet.content}\n` : ""}
## テンプレート
${templates.join("\n\n")}
${memoText ? `\n## 注意事項\n${memoText}` : ""}

ルール:
- テンプレートの【プレースホルダー】を会社データで埋めてください
- データにない情報は【要確認: 項目名】としてください
- 書式・文言はテンプレートを忠実に再現してください`;

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
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
