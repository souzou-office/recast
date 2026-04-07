import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import fsSync from "fs";
import nodePath from "path";
import os from "os";
import { execSync } from "child_process";

const SOFFICE = "C:/Program Files/LibreOffice/program/soffice.exe";
const TMP_DIR = nodePath.join(os.tmpdir(), "recast-preview");

// Excel → LibreOfficeでHTML変換（結合・色・太字保持）
export async function POST(request: NextRequest) {
  const { path: filePath } = await request.json();
  if (!filePath) {
    return NextResponse.json({ error: "path は必須です" });
  }

  try {
    await fs.mkdir(TMP_DIR, { recursive: true });

    const ext = nodePath.extname(filePath).toLowerCase();
    if (![".xls", ".xlsx", ".ods"].includes(ext)) {
      return NextResponse.json({ error: "Excelファイルではありません" });
    }

    const baseName = nodePath.basename(filePath, ext);
    execSync(`"${SOFFICE}" --headless --convert-to html --outdir "${TMP_DIR}" "${filePath}"`, { timeout: 30000 });

    const htmlPath = nodePath.join(TMP_DIR, `${baseName}.html`);
    if (!fsSync.existsSync(htmlPath)) {
      return NextResponse.json({ error: "HTML変換に失敗しました" });
    }

    let html = await fs.readFile(htmlPath, "utf-8");
    try { await fs.unlink(htmlPath); } catch { /* ignore */ }

    return NextResponse.json({ html });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "変換に失敗" });
  }
}
