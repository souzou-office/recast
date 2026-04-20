import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceConfig } from "@/lib/folders";
import { listFiles } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";

// 基本情報の参照候補ファイル一覧を返す（共通フォルダ配下の全ファイル、disabledFiles除外済み）
// NOTE: ファイル名/パスだけ返せばよいので中身はパースしない（listFiles は fs.readdir のみ）
async function walkFiles(
  dir: string,
  disabled: string[],
  folderName: string,
  out: { path: string; name: string; folder: string }[],
): Promise<void> {
  const entries = await listFiles(dir);
  for (const e of entries) {
    if (e.isDirectory) {
      await walkFiles(e.path, disabled, folderName, out);
      continue;
    }
    if (isPathDisabled(e.path, disabled)) continue;
    out.push({ path: e.path, name: e.name, folder: folderName });
  }
}

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

  // サブフォルダごとに並列スキャン（readdir のみなので速い）
  await Promise.all(
    commonSubs.map(sub => walkFiles(sub.id, sub.disabledFiles || [], sub.name, files)),
  );

  files.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));

  return NextResponse.json({ files, selected: company.profileSources || [] });
}
