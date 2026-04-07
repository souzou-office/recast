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

      // Excel → スプレッドシート風HTMLテーブル（結合・列幅反映）
      if (ext === ".xlsx" || ext === ".xls") {
        const workbook = XLSX.read(buffer, { type: "buffer", cellStyles: true });
        let html = `<style>
          .xl-container { font-family: "Yu Gothic", "Meiryo", sans-serif; font-size: 11px; }
          .xl-tabs { display: flex; gap: 1px; margin-bottom: 0; background: #d4d4d4; padding: 0 8px; }
          .xl-tab { padding: 4px 12px; font-size: 11px; background: #e8e8e8; border-radius: 4px 4px 0 0; cursor: pointer; color: #333; }
          .xl-tab.active { background: #fff; font-weight: bold; }
          .xl-sheet { border: 1px solid #d4d4d4; overflow: auto; }
          .xl-sheet table { border-collapse: collapse; table-layout: fixed; }
          .xl-sheet th, .xl-sheet td { border: 1px solid #d4d4d4; padding: 2px 6px; overflow: hidden; text-overflow: ellipsis; height: 20px; vertical-align: middle; }
          .xl-sheet th { background: #f0f0f0; color: #666; font-weight: normal; text-align: center; font-size: 10px; }
          .xl-sheet th.xl-row { width: 36px; min-width: 36px; position: sticky; left: 0; z-index: 1; }
          .xl-sheet th.xl-col { position: sticky; top: 0; z-index: 2; }
          .xl-sheet td { background: #fff; color: #333; white-space: pre-wrap; }
        </style><div class="xl-container">`;

        for (let si = 0; si < workbook.SheetNames.length; si++) {
          const sheetName = workbook.SheetNames[si];
          const sheet = workbook.Sheets[sheetName];
          const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as string[][];
          const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = sheet["!merges"] || [];
          const colWidths: number[] = (sheet["!cols"] || []).map((c: { wch?: number; wpx?: number }) => {
            if (c?.wpx) return c.wpx;
            if (c?.wch) return c.wch * 7; // 大体の変換
            return 72; // デフォルト
          });

          if (workbook.SheetNames.length > 1) {
            html += `<div class="xl-tabs">`;
            for (const sn of workbook.SheetNames) {
              html += `<div class="xl-tab${sn === sheetName ? " active" : ""}">${sn}</div>`;
            }
            html += `</div>`;
          }

          const maxCols = Math.max(...data.map(r => r.length), 0);

          // 結合セルのスキップマップ
          const skipMap = new Set<string>();
          const mergeMap = new Map<string, { colspan: number; rowspan: number }>();
          for (const m of merges) {
            for (let r = m.s.r; r <= m.e.r; r++) {
              for (let c = m.s.c; c <= m.e.c; c++) {
                if (r === m.s.r && c === m.s.c) {
                  mergeMap.set(`${r},${c}`, {
                    colspan: m.e.c - m.s.c + 1,
                    rowspan: m.e.r - m.s.r + 1,
                  });
                } else {
                  skipMap.add(`${r},${c}`);
                }
              }
            }
          }

          html += `<div class="xl-sheet"><table>`;
          // colgroup で列幅指定
          html += `<colgroup><col style="width:36px">`;
          for (let c = 0; c < maxCols; c++) {
            const w = colWidths[c] || 72;
            html += `<col style="width:${w}px">`;
          }
          html += `</colgroup>`;

          // 列ヘッダー
          html += `<tr><th class="xl-col xl-row"></th>`;
          for (let c = 0; c < maxCols; c++) {
            const colLetter = c < 26 ? String.fromCharCode(65 + c) : String.fromCharCode(64 + Math.floor(c / 26)) + String.fromCharCode(65 + (c % 26));
            html += `<th class="xl-col">${colLetter}</th>`;
          }
          html += `</tr>`;

          // セルアドレスをA1形式で取得
          const cellAddr = (r: number, c: number) => {
            const col = c < 26 ? String.fromCharCode(65 + c) : String.fromCharCode(64 + Math.floor(c / 26)) + String.fromCharCode(65 + (c % 26));
            return `${col}${r + 1}`;
          };

          // 色をHEXに変換
          const toHex = (color: { rgb?: string; theme?: number } | undefined): string | null => {
            if (!color) return null;
            if (color.rgb && color.rgb !== "000000") return `#${color.rgb.slice(-6)}`;
            return null;
          };

          // 行データ（セルスタイル反映）
          for (let r = 0; r < data.length; r++) {
            const rowInfo = (sheet["!rows"] || [])[r];
            const rowHeight = rowInfo?.hpx ? `height:${rowInfo.hpx}px` : "";
            html += `<tr${rowHeight ? ` style="${rowHeight}"` : ""}><th class="xl-row">${r + 1}</th>`;
            for (let c = 0; c < maxCols; c++) {
              const key = `${r},${c}`;
              if (skipMap.has(key)) continue;

              const merge = mergeMap.get(key);
              const val = data[r]?.[c] ?? "";
              const mergeAttrs = merge ? ` colspan="${merge.colspan}" rowspan="${merge.rowspan}"` : "";

              // セルスタイル取得
              const cell = sheet[cellAddr(r, c)];
              const style: string[] = [];
              if (cell?.s) {
                const s = cell.s;
                if (s.font?.bold) style.push("font-weight:bold");
                if (s.font?.italic) style.push("font-style:italic");
                if (s.font?.sz) style.push(`font-size:${s.font.sz}pt`);
                const fgColor = toHex(s.fill?.fgColor);
                if (fgColor) style.push(`background:${fgColor}`);
                const fontColor = toHex(s.font?.color);
                if (fontColor) style.push(`color:${fontColor}`);
                if (s.alignment?.horizontal) style.push(`text-align:${s.alignment.horizontal}`);
                if (s.alignment?.vertical) {
                  const vMap: Record<string, string> = { top: "top", center: "middle", bottom: "bottom" };
                  style.push(`vertical-align:${vMap[s.alignment.vertical] || "middle"}`);
                }
                if (s.alignment?.wrapText) style.push("white-space:pre-wrap");
              }
              const styleAttr = style.length > 0 ? ` style="${style.join(";")}"` : "";

              html += `<td${mergeAttrs}${styleAttr}>${val}</td>`;
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
