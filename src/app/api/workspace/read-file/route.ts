import { NextRequest, NextResponse } from "next/server";
import { readFileContent } from "@/lib/files";
import fs from "fs/promises";
import nodePath from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx");

// ローカルファイルの内容を読んで返す（format=html でHTML変換）
export async function POST(request: NextRequest) {
  const { path: filePath, format } = await request.json();
  if (!filePath) {
    return NextResponse.json({ error: "path は必須です" });
  }

  const ext = nodePath.extname(filePath).toLowerCase();

  // HTML変換モード
  if (format === "html") {
    try {
      const buffer = await fs.readFile(filePath);

      // Word → HTML
      if (ext === ".docx" || ext === ".doc") {
        const result = await mammoth.convertToHtml({ buffer });
        return NextResponse.json({ html: result.value, name: nodePath.basename(filePath) });
      }

      // Excel → HTMLテーブル
      if (ext === ".xlsx" || ext === ".xls") {
        const workbook = XLSX.read(buffer, { type: "buffer" });
        let html = "";
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          html += `<h3 style="margin:16px 0 8px;font-size:14px;color:#333;">${sheetName}</h3>`;
          html += XLSX.utils.sheet_to_html(sheet, { editable: false });
        }
        return NextResponse.json({ html, name: nodePath.basename(filePath) });
      }
    } catch {
      return NextResponse.json({ error: "HTML変換に失敗しました" });
    }
  }

  // 通常のテキスト読み取り
  const result = await readFileContent(filePath);
  if (!result) {
    return NextResponse.json({ error: "ファイルを読み取れませんでした" });
  }

  return NextResponse.json({ content: result.content, name: result.name });
}
