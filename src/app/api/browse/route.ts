import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { listFoldersGoogle } from "@/lib/files-google";
import { listFoldersDropbox } from "@/lib/files-dropbox";

interface DirEntry {
  name: string;
  path: string;
}

export async function GET(request: NextRequest) {
  const dirPath = request.nextUrl.searchParams.get("path");
  const provider = request.nextUrl.searchParams.get("provider") || "local";

  // クラウドプロバイダー
  if (provider === "google") {
    try {
      const result = await listFoldersGoogle(dirPath || "root");
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Google Driveエラー" },
        { status: 400 }
      );
    }
  }

  if (provider === "dropbox") {
    try {
      const result = await listFoldersDropbox(dirPath || "");
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Dropboxエラー" },
        { status: 400 }
      );
    }
  }

  // ローカル
  const targetPath = dirPath || os.homedir();

  try {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const dirs: DirEntry[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;

      if (entry.isDirectory()) {
        dirs.push({
          name: entry.name,
          path: path.join(targetPath, entry.name),
        });
      }
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      current: targetPath,
      parent: path.dirname(targetPath) !== targetPath ? path.dirname(targetPath) : null,
      dirs,
    });
  } catch {
    return NextResponse.json(
      { error: "フォルダを読み取れません" },
      { status: 400 }
    );
  }
}
