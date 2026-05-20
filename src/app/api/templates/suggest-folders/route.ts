import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { logTokenUsage } from "@/lib/token-logger";

const client = new Anthropic();

// テンプレート名 → 関連フォルダを推論（Haiku）
export async function POST(request: NextRequest) {
  const { templateName, templateItems, folderNames } = await request.json() as {
    templateName: string;
    templateItems: string[];
    folderNames: { id: string; name: string }[];
  };

  if (!templateName || !folderNames || folderNames.length === 0) {
    return NextResponse.json({ suggested: [] });
  }

  const folderList = folderNames.map((f, i) => `${i + 1}. ${f.name}`).join("\n");
  const itemList = templateItems?.length > 0
    ? `\n確認項目:\n${templateItems.map(it => `- ${it}`).join("\n")}`
    : "";

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{
        role: "user",
        content: `テンプレート「${templateName}」で案件整理を行います。${itemList}

以下のフォルダ一覧から、この案件に必要なフォルダの番号を全て選んでください。
定款・登記・株主名簿など基本資料フォルダも含めてください。

フォルダ一覧:
${folderList}

回答は番号をカンマ区切りで（例: 1,3,5）。該当なしなら「なし」。`
      }],
    });
    logTokenUsage("/api/templates/suggest-folders", "claude-haiku-4-5-20251001", response.usage);

    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
    if (text === "なし") {
      return NextResponse.json({ suggested: [] });
    }

    const indices = text.match(/\d+/g)?.map(n => parseInt(n, 10) - 1) || [];
    const suggested = indices
      .filter(i => i >= 0 && i < folderNames.length)
      .map(i => folderNames[i].id);

    return NextResponse.json({ suggested });
  } catch {
    return NextResponse.json({ suggested: [] });
  }
}
