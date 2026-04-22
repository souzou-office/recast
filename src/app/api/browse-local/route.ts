import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execSync } from "child_process";

// Windowsドライブ一覧（ドライブ名付き）
// 注意: wmic は出力が CP932（Shift-JIS）なので Node の "utf-8" デコードで日本語ラベルが化ける。
// PowerShell 経由で UTF-8 出力に固定して取得する。
function getWindowsDrives(): { name: string; path: string }[] {
  const drives: { name: string; path: string }[] = [];
  try {
    const psCommand = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Get-CimInstance Win32_LogicalDisk | ForEach-Object { $_.DeviceID + ',' + $_.VolumeName }";
    const output = execSync(`powershell -NoProfile -NonInteractive -Command "${psCommand}"`, {
      encoding: "utf-8",
      windowsHide: true,
    });
    for (const line of output.split(/\r?\n/)) {
      const idx = line.indexOf(",");
      if (idx < 0) continue;
      const letter = line.slice(0, idx).trim();
      const label = line.slice(idx + 1).trim();
      if (!/^[A-Z]:$/.test(letter)) continue;
      drives.push({
        name: label ? `${letter} ${label}` : letter,
        path: `${letter}\\`,
      });
    }
  } catch { /* PowerShell 失敗時はフォールバックへ */ }

  if (drives.length === 0) {
    // フォールバック: ドライブレター列挙のみ（ラベル無し）
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
