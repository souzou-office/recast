/**
 * GET /api/workspace/list-files?folder=<path>
 *
 * Local-First: ローカルフォルダからライブでファイル一覧を返す。
 * scan-filesの置き換え。キャッシュ不要、毎回fsから読む（一瞬）。
 */
import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { isSupportedFile, getMimeType } from "@/lib/file-parsers";
import type { LiveFile } from "@/types";

export async function GET(request: NextRequest) {
  const folderPath = request.nextUrl.searchParams.get("folder");
  if (!folderPath) {
    return Response.json({ error: "folder パラメータが必要です" }, { status: 400 });
  }

  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const config = await getWorkspaceConfig();

    // このフォルダに対応するsubfolderのdisabledFilesを探す
    const company = config.companies.find(c => c.id === config.selectedCompanyId);
    const subfolder = company?.subfolders.find(s => s.id === folderPath);
    const disabledFiles = new Set(subfolder?.disabledFiles || []);

    const files: LiveFile[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      if (!isSupportedFile(entry.name)) continue;

      const fullPath = path.join(folderPath, entry.name);
      const stat = await fs.stat(fullPath);

      files.push({
        name: entry.name,
        path: fullPath,
        relativePath: entry.name,
        size: stat.size,
        mimeType: getMimeType(entry.name),
        modifiedTime: stat.mtime.toISOString(),
        enabled: !disabledFiles.has(entry.name),
      });
    }

    // 名前順ソート
    files.sort((a, b) => a.name.localeCompare(b.name));

    return Response.json({ files });
  } catch (err) {
    const message = err instanceof Error ? err.message : "フォルダの読み取りに失敗";
    return Response.json({ error: message }, { status: 500 });
  }
}
