import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import nodePath from "path";

// ライブファイル一覧: ローカルfsから直接読む
export async function POST(request: NextRequest) {
  let dirPath: string;
  try {
    const body = await request.json();
    dirPath = body.path;
  } catch {
    return NextResponse.json({ error: "invalid body", files: [], subfolders: [] });
  }

  if (!dirPath) {
    return NextResponse.json({ error: "path は必須です", files: [], subfolders: [] });
  }

  // デバッグ: パスの存在確認
  const fsSync = require("fs");
  console.log("[list-files] path:", dirPath);
  console.log("[list-files] exists:", fsSync.existsSync(dirPath));


  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    const files = entries
      .filter(e => !e.isDirectory() && !e.name.startsWith("."))
      .map(e => ({
        name: e.name,
        path: nodePath.join(dirPath, e.name),
        size: 0,
        ext: nodePath.extname(e.name).toLowerCase(),
      }));

    const subfolders = entries
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => ({
        name: e.name,
        path: nodePath.join(dirPath, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ files, subfolders });
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : String(e),
      files: [],
      subfolders: [],
    });
  }
}
