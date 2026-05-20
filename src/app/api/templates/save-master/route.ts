import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";
import { logTokenUsage } from "@/lib/token-logger";

const client = new Anthropic();

// テンプレート実行結果をマスターシート（structured JSON）として保存
export async function POST(request: NextRequest) {
  const { companyId, templateId, templateName, content, sourceFiles } = await request.json();

  if (!companyId || !content) {
    return NextResponse.json({ error: "companyId, content は必須です" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // Haikuでマークダウンをstructured JSONに変換
  let structured: Record<string, unknown> | undefined;
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: `以下のマークダウンテキストをJSON形式に変換してください。
各## 見出しをキーとし、その内容を値にしてください。
表はオブジェクトの配列にしてください。
回答はJSONのみ返してください。

${content}`
      }],
    });
    logTokenUsage("/api/templates/save-master", "claude-haiku-4-5-20251001", response.usage);

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      structured = JSON.parse(match[0]);
    }
  } catch { /* パース失敗時はstructuredなしで保存 */ }

  company.masterSheet = {
    templateId: templateId || "",
    templateName: templateName || "",
    content,
    structured,
    sourceFiles: sourceFiles || [],
    createdAt: new Date().toISOString(),
  };

  await saveWorkspaceConfig(config);

  return NextResponse.json({ masterSheet: company.masterSheet });
}
