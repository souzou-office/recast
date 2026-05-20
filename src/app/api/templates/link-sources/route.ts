import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { logTokenUsage } from "@/lib/token-logger";

const client = new Anthropic();

// 案件整理の結果テキストとファイル名一覧から、各セクションの根拠ファイルを紐付ける
export async function POST(request: NextRequest) {
  const { content, sourceFiles } = await request.json() as {
    content: string;
    sourceFiles: { id: string; name: string }[];
  };

  if (!content || !sourceFiles || sourceFiles.length === 0) {
    return NextResponse.json({ links: {} });
  }

  // ## 見出しを抽出
  const headings = content.match(/^## .+$/gm);
  if (!headings || headings.length === 0) {
    return NextResponse.json({ links: {} });
  }

  const fileList = sourceFiles.map((f, i) => `${i}: ${f.name}`).join("\n");
  const headingList = headings.map((h, i) => `${i}: ${h.replace("## ", "")}`).join("\n");

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `以下の確認項目（見出し）それぞれについて、根拠となるファイルの番号を対応付けてください。

見出し一覧:
${headingList}

ファイル一覧:
${fileList}

回答はJSONのみ。見出し番号をキー、ファイル番号の配列を値にしてください。
例: {"0": [0, 2], "1": [1], "2": [0, 1, 2]}`
      }],
    });
    logTokenUsage("/api/templates/link-sources", "claude-haiku-4-5-20251001", response.usage);

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return NextResponse.json({ links: {} });
    }

    const raw: Record<string, number[]> = JSON.parse(match[0]);

    // 見出しテキスト → sourceFile[] に変換
    const links: Record<string, { id: string; name: string }[]> = {};
    for (const [headingIdx, fileIndices] of Object.entries(raw)) {
      const heading = headings[parseInt(headingIdx)]?.replace("## ", "");
      if (!heading) continue;
      links[heading] = fileIndices
        .map(i => sourceFiles[i])
        .filter(Boolean);
    }

    return NextResponse.json({ links });
  } catch {
    return NextResponse.json({ links: {} });
  }
}
