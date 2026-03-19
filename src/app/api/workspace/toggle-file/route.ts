import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";

export async function PATCH(request: NextRequest) {
  const { companyId, subfolderId, fileId, enabled } = await request.json();

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });

  const sub = company.subfolders.find(s => s.id === subfolderId);
  if (!sub || !sub.files) return NextResponse.json({ error: "フォルダが見つかりません" }, { status: 404 });

  const file = sub.files.find(f => f.id === fileId);
  if (file) file.enabled = enabled;

  await saveWorkspaceConfig(config);
  return NextResponse.json(config);
}
