import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";

// 基本情報の参照候補ファイル一覧を返す（共通フォルダ配下の全ファイル、disabledFiles除外済み）
export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId は必須です", files: [] }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません", files: [] }, { status: 404 });
  }

  const commonSubs = company.subfolders.filter(s => s.role === "common");
  const files: { path: string; name: string; folder: string }[] = [];
  for (const sub of commonSubs) {
    const disabled = sub.disabledFiles || [];
    const contents = await readAllFilesInFolder(sub.id);
    for (const c of contents) {
      if (isPathDisabled(c.path, disabled)) continue;
      files.push({ path: c.path, name: c.name, folder: sub.name });
    }
  }

  return NextResponse.json({ files, selected: company.profileSources || [] });
}
