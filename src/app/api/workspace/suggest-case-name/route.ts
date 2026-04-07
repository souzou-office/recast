import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// フォルダ名+ファイル名からAIが案件名を自動生成
export async function POST(request: NextRequest) {
  const { folderName, fileNames, companyName } = await request.json();

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `以下のフォルダ名とファイル名から、案件の表示名を生成してください。

会社名: ${companyName || ""}
フォルダ名: ${folderName || ""}
ファイル名: ${(fileNames || []).join(", ")}

ルール:
- 「YYYY/MM 案件内容」の形式（例: 2026/04 定時株主総会 役員改選）
- 日付が不明なら省略
- 簡潔に（20文字以内）
- 表示名のみ返してください`,
      }],
    });

    const name = response.content[0].type === "text" ? response.content[0].text.trim() : "新規案件";
    return NextResponse.json({ name });
  } catch {
    return NextResponse.json({ name: folderName || "新規案件" });
  }
}
