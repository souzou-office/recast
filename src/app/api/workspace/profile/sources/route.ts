import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceConfig } from "@/lib/folders";
import { listFiles } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";
import type { SubfolderRole } from "@/types";

// 基本情報の参照候補を返す。
// 「見える化＋単純化」方針: 共通フォルダだけでなく会社配下の全フォルダを返し、
// 各フォルダの role と「なぜそうなっているか（共通パターン一致か）」を添える。
// これにより、共通パターン/ロールを理解しなくても「何が読まれるか」が一目で分かり、
// パターンに関係なく好きなファイルを直接選べる（profileSources = 最終的な正）。
// NOTE: listFiles は readdir のみで中身パースしないので速い。

interface SourceFile {
  path: string;
  name: string;
}

async function walkFiles(dir: string, disabled: string[], out: SourceFile[]): Promise<void> {
  const entries = await listFiles(dir);
  for (const e of entries) {
    if (e.isDirectory) {
      await walkFiles(e.path, disabled, out);
      continue;
    }
    if (isPathDisabled(e.path, disabled)) continue;
    out.push({ path: e.path, name: e.name });
  }
}

// 共通パターン判定（src/app/api/workspace/route.ts の matchesCommonPattern と同じロジック）。
// どのパターンに一致したかを返す（理由表示用）。
function matchedCommonPattern(name: string, patterns: string[]): string | null {
  const lower = name.toLowerCase();
  return patterns.find(p => lower.includes(p.toLowerCase())) || null;
}

const ROLE_ORDER: Record<SubfolderRole, number> = { common: 0, job: 1, none: 2 };

export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId は必須です", folders: [] }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません", folders: [] }, { status: 404 });
  }

  const patterns = config.defaultCommonPatterns || [];

  const folders: {
    id: string;
    name: string;
    role: SubfolderRole;
    matchedPattern: string | null;
    files: SourceFile[];
  }[] = [];
  const autoPaths: string[] = [];

  // 全サブフォルダを並列スキャン（共通/案件/除外すべて）
  await Promise.all(
    company.subfolders.map(async sub => {
      const files: SourceFile[] = [];
      await walkFiles(sub.id, sub.disabledFiles || [], files);
      files.sort((a, b) => a.name.localeCompare(b.name));
      folders.push({
        id: sub.id,
        name: sub.name,
        role: sub.role,
        matchedPattern: matchedCommonPattern(sub.name, patterns),
        files,
      });
      // おまかせ（profileSources 未設定）時に実際に読まれるのは共通フォルダのファイル
      if (sub.role === "common") for (const f of files) autoPaths.push(f.path);
    }),
  );

  // 共通 → 案件 → 除外 の順、同 role 内は名前順
  folders.sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || a.name.localeCompare(b.name));

  return NextResponse.json({
    folders,
    selected: company.profileSources || [], // 空配列 = おまかせ（共通フォルダを自動使用）
    autoPaths, // おまかせ時に実際に使われるファイル
  });
}
