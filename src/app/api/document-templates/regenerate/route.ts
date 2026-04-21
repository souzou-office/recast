import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

// 生成済み書類の再生成エンドポイント（AI 呼び出しなし）。
//
// 使い方:
//   POST /api/document-templates/regenerate
//   body: {
//     templatePath: "H:\\...\\1.取締役決定書.docx",
//     fileName: "株式会社JINGS_1.取締役決定書.docx",
//     filledSlots: [
//       { slotId: 0, value: "三上春香" },
//       { slotId: 1, value: "広島県..." },
//       ...
//     ]
//   }
//   → docxBase64 を返す
//
// docx: replaceMarkedFields で slotId 単位に置換
// xlsx: replaceXlsxMarkedCells で元値→新値のマップで置換
// AI 呼び出しは完全になし。テンプレ + 値マップ → 出力 を純粋置換で行う。
export async function POST(request: NextRequest) {
  const body = await request.json() as {
    templatePath?: string;
    fileName?: string;
    filledSlots?: { slotId: number; value: string }[];
  };

  if (!body.templatePath || !body.fileName || !Array.isArray(body.filledSlots)) {
    return NextResponse.json({ error: "templatePath / fileName / filledSlots が必須" }, { status: 400 });
  }

  try {
    const buffer = await fs.readFile(body.templatePath);
    const ext = path.extname(body.templatePath).toLowerCase();

    if (ext === ".docx" || ext === ".docm") {
      const { replaceMarkedFields } = await import("@/lib/docx-marker-parser");
      const replacements: Record<number, string> = {};
      for (const s of body.filledSlots) replacements[s.slotId] = s.value;
      const outBuffer = replaceMarkedFields(buffer, replacements);

      // プレビュー用 HTML（best effort）
      let previewHtml = "";
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mammoth = require("mammoth");
        previewHtml = (await mammoth.convertToHtml({ buffer: outBuffer })).value;
      } catch { /* ignore */ }

      return NextResponse.json({
        docxBase64: outBuffer.toString("base64"),
        previewHtml,
        fileName: body.fileName,
      });
    }

    if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") {
      const { replaceXlsxMarkedCells, extractXlsxMarkedCells } = await import("@/lib/xlsx-marker-parser");
      // xlsx は「元値 → 新値」のマップで置換する。slotId の順序で元値を取得。
      const originalCells = extractXlsxMarkedCells(buffer);
      const replacements: Record<string, string> = {};
      for (const s of body.filledSlots) {
        const orig = originalCells[s.slotId]?.value;
        if (!orig) continue;
        replacements[orig] = s.value;
      }
      const outBuffer = replaceXlsxMarkedCells(buffer, replacements);
      return NextResponse.json({
        docxBase64: outBuffer.toString("base64"),
        previewHtml: "",
        fileName: body.fileName,
      });
    }

    return NextResponse.json({ error: "非対応の拡張子" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : "再生成に失敗しました",
    }, { status: 500 });
  }
}
