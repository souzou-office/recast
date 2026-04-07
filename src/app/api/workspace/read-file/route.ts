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

      // Excel → スプレッドシート風HTMLテーブル
      if (ext === ".xlsx" || ext === ".xls") {
        const workbook = XLSX.read(buffer, { type: "buffer", cellStyles: true });
        let html = `<style>
          .xl-container { font-family: "Yu Gothic", "Meiryo", sans-serif; font-size: 11px; }
          .xl-tabs { display: flex; gap: 1px; margin-bottom: 0; background: #d4d4d4; padding: 0 8px; }
          .xl-tab { padding: 4px 12px; font-size: 11px; background: #e8e8e8; border-radius: 4px 4px 0 0; cursor: pointer; color: #333; }
          .xl-tab.active { background: #fff; font-weight: bold; }
          .xl-sheet { border: 1px solid #d4d4d4; overflow: auto; }
          .xl-sheet table { border-collapse: collapse; width: max-content; min-width: 100%; }
          .xl-sheet th, .xl-sheet td { border: 1px solid #d4d4d4; padding: 2px 6px; white-space: nowrap; min-width: 64px; height: 20px; vertical-align: middle; }
          .xl-sheet th { background: #f0f0f0; color: #666; font-weight: normal; text-align: center; position: sticky; font-size: 10px; }
          .xl-sheet th.xl-row { min-width: 36px; width: 36px; left: 0; z-index: 1; }
          .xl-sheet th.xl-col { top: 0; z-index: 2; }
          .xl-sheet td { background: #fff; color: #333; }
        </style><div class="xl-container">`;

        for (let si = 0; si < workbook.SheetNames.length; si++) {
          const sheetName = workbook.SheetNames[si];
          const sheet = workbook.Sheets[sheetName];
          const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as string[][];

          if (workbook.SheetNames.length > 1) {
            html += `<div class="xl-tabs">`;
            for (const sn of workbook.SheetNames) {
              html += `<div class="xl-tab${sn === sheetName ? " active" : ""}">${sn}</div>`;
            }
            html += `</div>`;
          }

          // 列数を計算
          const maxCols = Math.max(...data.map(r => r.length), 0);

          html += `<div class="xl-sheet"><table>`;
          // 列ヘッダー
          html += `<tr><th class="xl-col xl-row"></th>`;
          for (let c = 0; c < maxCols; c++) {
            const colLetter = c < 26 ? String.fromCharCode(65 + c) : String.fromCharCode(64 + Math.floor(c / 26)) + String.fromCharCode(65 + (c % 26));
            html += `<th class="xl-col">${colLetter}</th>`;
          }
          html += `</tr>`;
          // 行データ
          for (let r = 0; r < data.length; r++) {
            html += `<tr><th class="xl-row">${r + 1}</th>`;
            for (let c = 0; c < maxCols; c++) {
              const val = data[r]?.[c] ?? "";
              html += `<td>${val}</td>`;
            }
            html += `</tr>`;
          }
          html += `</table></div>`;

          if (si < workbook.SheetNames.length - 1) html += `<div style="height:16px"></div>`;
        }

        html += `</div>`;
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
