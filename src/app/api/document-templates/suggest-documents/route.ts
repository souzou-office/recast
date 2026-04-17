import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";

const client = new Anthropic();

// 案件内容から必要な書類一覧を提案
export async function POST(request: NextRequest) {
  const { companyId } = await request.json();

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  const profile = company.profile?.structured;
  // company.masterSheet は廃止。caseRoom.masterSheet のみ参照
  const caseRoomMasterSheet = company.caseRooms?.find(r => r.masterSheet)?.masterSheet?.structured;
  const masterSheet = caseRoomMasterSheet;

  if (!profile && !masterSheet) {
    return NextResponse.json({ error: "基本情報が必要です" }, { status: 400 });
  }

  const context = JSON.stringify({
    基本情報: profile || {},
    案件情報: masterSheet || {},
  }, null, 2);

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `以下の会社データと案件情報から、登記申請に必要な書類一覧を提案してください。

${context}

回答はJSON配列のみ返してください。各要素は以下の形式:
[
  { "name": "書類名", "reason": "必要な理由（1行）", "required": true },
  ...
]

requiredはtrue（必須）またはfalse（任意・場合による）で判定してください。`
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return NextResponse.json({ documents: [] });
    }

    const documents: { name: string; reason: string; required: boolean }[] = JSON.parse(match[0]);
    return NextResponse.json({ documents });
  } catch {
    return NextResponse.json({ documents: [] });
  }
}
