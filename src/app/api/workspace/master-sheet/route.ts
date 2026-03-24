import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";

// マスターシートJSON取得
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
    masterSheet: company.masterSheet || null,
    profile: company.profile || null,
  });
}

// マスターシートJSON更新
export async function PATCH(request: NextRequest) {
  const { companyId, type, structured } = await request.json() as {
    companyId: string;
    type: "masterSheet" | "profile";
    structured: Record<string, unknown>;
  };

  if (!companyId || !type || !structured) {
    return NextResponse.json({ error: "companyId, type, structured は必須です" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  if (type === "masterSheet" && company.masterSheet) {
    company.masterSheet.structured = structured;
  } else if (type === "profile" && company.profile) {
    company.profile.structured = structured as any;
  }

  await saveWorkspaceConfig(config);

  return NextResponse.json({ ok: true });
}
