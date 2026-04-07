import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execSync } from "child_process";

// Windowsドライブ一覧（ドライブ名付き）
function getWindowsDrives(): { name: string; path: string }[] {
  const drives: { name: string; path: string }[] = [];
  try {
    const output = execSync("wmic logicaldisk get DeviceID,VolumeName /format:csv", { encoding: "utf-8" });
    for (const line of output.split("\n")) {
      const parts = line.trim().split(",");
      if (parts.length >= 3 && /^[A-Z]:$/.test(parts[1])) {
        const letter = parts[1];
        const label = parts[2]?.trim();
        drives.push({
          name: label ? `${letter} ${label}` : letter,
          path: `${letter}\\`,
        });
      }
    }
  } catch {
    // fallback
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      try {
        const p = `${letter}:\\`;
        require("fs").accessSync(p);
        drives.push({ name: `${letter}:`, path: p });
      } catch { /* skip */ }
    }
  }
  return drives;
}

// ローカルファイルシステムのフォルダブラウザ
export async function GET(request: NextRequest) {
  const dirPath = request.nextUrl.searchParams.get("path");

  if (!dirPath) {
    if (process.platform === "win32") {
      return NextResponse.json({ current: "", parent: null, dirs: getWindowsDrives() });
    } else {
      return NextResponse.json({
        current: "",
        parent: null,
        dirs: [
          { name: "ホーム", path: os.homedir() },
          { name: "/", path: "/" },
        ],
      });
    }
  }

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(dirPath);
    return NextResponse.json({
      current: dirPath,
      parent: parent === dirPath ? null : parent, // ルートなら親なし
      dirs,
    });
  } catch {
    return NextResponse.json({ error: "フォルダを開けません" }, { status: 400 });
  }
}
