import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";

// profile の structured JSON 取得/更新（masterSheet 機能は廃止）
export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId は必須です" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  return NextResponse.json({
    masterSheet: null, // 廃止
    profile: company.profile || null,
  });
}

export async function PATCH(request: NextRequest) {
  const { companyId, type, structured } = await request.json() as {
    companyId: string;
    type: "masterSheet" | "profile";
    structured: Record<string, unknown>;
  };

  if (!companyId || !type || !structured) {
    return NextResponse.json({ error: "companyId, type, structured は必須です" }, { status: 400 });
  }

  // masterSheet 更新は廃止
  if (type === "masterSheet") {
    return NextResponse.json({ error: "masterSheet 機能は廃止されました" }, { status: 410 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  if (type === "profile" && company.profile) {
    company.profile.structured = structured as never;
  }

  await saveWorkspaceConfig(config);

  return NextResponse.json({ ok: true });
}
