import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readFileContent } from "@/lib/files";
import { logTokenUsage } from "@/lib/token-logger";

const client = new Anthropic();

// 過去案件のファイルから書類雛形を生成（個人情報除去）
export async function POST(request: NextRequest) {
  const { files } = await request.json() as {
    files: { id: string; name: string; mimeType: string }[];
  };

  if (!files || files.length === 0) {
    return NextResponse.json({ error: "ファイルが指定されていません" }, { status: 400 });
  }

  // ファイル読み取り
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

  const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  const contentBlocks: ContentBlock[] = [];
  const textParts: string[] = [];

  for (const f of files) {
    const content = await readFileContent(f.id);
    if (!content) continue;
    if (content.base64) {
      const mime = content.mimeType || "application/pdf";
      if (mime === "application/pdf") {
        contentBlocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: content.base64 },
          title: f.name,
        });
      } else if (IMAGE_MIMES.has(mime)) {
        contentBlocks.push({
          type: "image",
          source: { type: "base64", media_type: mime, data: content.base64 },
        });
      }
    } else {
      textParts.push(`【${f.name}】\n${content.content}`);
    }
  }

  if (contentBlocks.length === 0 && textParts.length === 0) {
    return NextResponse.json({ error: "読み取れるファイルがありません" }, { status: 400 });
  }

  const prompt = `以下の書類を読み、書類雛形（テンプレート）を作成してください。

ルール:
- 個人名、法人名、住所、電話番号、日付などの具体的情報は全て{{プレースホルダー}}に置き換える
  例: {{会社名}}, {{代表取締役氏名}}, {{本店所在地}}, {{開催日}}, {{議決権数}}
- 書類の構造・書式・文言はそのまま維持する
- 複数の書類がある場合は、それぞれ別の雛形として出力する
- 各雛形の冒頭に「=== 雛形: [書類名] ===」と記載する
- カテゴリ（議事録/承諾書/届出書/定款/その他）も判定して「カテゴリ: [カテゴリ名]」と記載する

${textParts.length > 0 ? "\n--- 書類内容 ---\n" + textParts.join("\n\n") : ""}`;

  contentBlocks.push({ type: "text", text: prompt });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content: contentBlocks as Anthropic.ContentBlockParam[] }],
    });
    logTokenUsage("/api/document-templates/generate", "claude-sonnet-4-6", response.usage);

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text : "")
      .join("");

    // 複数雛形をパース
    const templates: { name: string; category: string; content: string }[] = [];
    const sections = text.split(/===\s*雛形:\s*/);

    for (const section of sections) {
      if (!section.trim()) continue;
      const lines = section.split("\n");
      const nameLine = lines[0]?.replace(/===.*$/, "").trim();
      const categoryMatch = section.match(/カテゴリ:\s*(.+)/);
      const category = categoryMatch ? categoryMatch[1].trim() : "その他";
      // カテゴリ行を除去した本文
      const content = lines.slice(1)
        .filter(l => !l.match(/^カテゴリ:/))
        .join("\n")
        .trim();

      if (nameLine && content) {
        templates.push({ name: nameLine, category, content });
      }
    }

    // パースできなかった場合は全体を1つの雛形として返す
    if (templates.length === 0 && text.trim()) {
      templates.push({ name: "雛形", category: "その他", content: text.trim() });
    }

    return NextResponse.json({ templates });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "雛形生成に失敗しました" },
      { status: 500 }
    );
  }
}
