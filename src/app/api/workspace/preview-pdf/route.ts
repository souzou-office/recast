import { NextRequest } from "next/server";
import fs from "fs/promises";
import fsSync from "fs";
import nodePath from "path";
import os from "os";
import { execSync } from "child_process";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

const SOFFICE = "C:/Program Files/LibreOffice/program/soffice.exe";
const TMP_DIR = nodePath.join(os.tmpdir(), "recast-preview");
const CONVERTIBLE = new Set([".doc", ".docx", ".ppt", ".pptx", ".odt", ".xls", ".xlsx", ".ods"]);
const SPREADSHEET_EXTS = new Set([".xls", ".xlsx", ".ods"]);

export async function POST(request: NextRequest) {
  let filePath: string | undefined;
  let base64Data: string | undefined;
  let fileName: string | undefined;

  try {
    const body = await request.json();
    filePath = body.path;
    base64Data = body.base64;
    fileName = body.fileName;
  } catch {
    return new Response("invalid body", { status: 400 });
  }

  try {
    await fs.mkdir(TMP_DIR, { recursive: true });

    let inputPath: string;

    if (base64Data && fileName) {
      const buffer = Buffer.from(base64Data, "base64");
      inputPath = nodePath.join(TMP_DIR, `input_${Date.now()}_${fileName}`);
      await fs.writeFile(inputPath, buffer);
    } else if (filePath) {
      inputPath = filePath;
    } else {
      return new Response("path or base64+fileName required", { status: 400 });
    }

    const ext = nodePath.extname(inputPath).toLowerCase();
    if (!CONVERTIBLE.has(ext)) {
      return new Response("not a convertible file type", { status: 400 });
    }

    const baseName = nodePath.basename(inputPath, ext);
    let pdfInputPath = inputPath;

    // Excel系: 横幅1ページに収める
    if (SPREADSHEET_EXTS.has(ext)) {
      try {
        // ODSに変換
        execSync(`"${SOFFICE}" --headless --convert-to ods --outdir "${TMP_DIR}" "${inputPath}"`, { timeout: 30000 });
        const odsPath = nodePath.join(TMP_DIR, `${baseName}.ods`);

        if (fsSync.existsSync(odsPath)) {
          // ODSのXMLを編集: 横幅1ページに縮小
          const odsBuf = await fs.readFile(odsPath);
          const zip = new PizZip(odsBuf);

          // styles.xmlのpage-layout-propertiesを修正
          const stylesXml = zip.file("styles.xml")?.asText() || "";
          const modified = stylesXml.replace(
            /<style:page-layout-properties([^/]*?)\/>/g,
            (_match: string, attrs: string) => {
              let a = attrs;
              // 既存のスケール・向き属性を削除
              a = a.replace(/style:scale-to="[^"]*"/g, "");
              a = a.replace(/style:scale-to-X="[^"]*"/g, "");
              a = a.replace(/style:scale-to-Y="[^"]*"/g, "");
              a = a.replace(/style:print-orientation="[^"]*"/g, "");
              // 横幅1ページ縮小を追加（縦はそのまま複数ページOK）
              a += ` style:scale-to-X="1" style:scale-to-Y="0"`;
              return `<style:page-layout-properties${a}/>`;
            }
          );
          zip.file("styles.xml", modified);

          // print-rangesを削除（全域印刷）
          const contentXml = zip.file("content.xml")?.asText() || "";
          zip.file("content.xml", contentXml.replace(/table:print-ranges="[^"]*"/g, ""));

          await fs.writeFile(odsPath, zip.generate({ type: "nodebuffer" }));
          pdfInputPath = odsPath;
        }
      } catch {
        // ODS変換失敗 → そのまま直接PDF変換
        pdfInputPath = inputPath;
      }
    }

    // PDF変換
    execSync(`"${SOFFICE}" --headless --convert-to pdf --outdir "${TMP_DIR}" "${pdfInputPath}"`, { timeout: 60000 });

    const pdfBaseName = nodePath.basename(pdfInputPath, nodePath.extname(pdfInputPath));
    const pdfPath = nodePath.join(TMP_DIR, `${pdfBaseName}.pdf`);
    const pdfBuffer = await fs.readFile(pdfPath);

    // 一時ファイル削除
    try { await fs.unlink(pdfPath); } catch { /* ignore */ }
    if (pdfInputPath !== inputPath) { try { await fs.unlink(pdfInputPath); } catch { /* ignore */ } }
    if (base64Data) { try { await fs.unlink(inputPath); } catch { /* ignore */ } }

    return new Response(pdfBuffer, {
      headers: { "Content-Type": "application/pdf" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "変換に失敗" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
