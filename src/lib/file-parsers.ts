/**
 * file-parsers.ts — ファイル解析の共通モジュール
 *
 * PDF/docx/xlsx のバッファ解析ロジックを files-google.ts から抽出。
 * ローカルファイルシステムからもクラウドAPIからも同じパーサーを使える。
 */
import fs from "fs/promises";
import path from "path";
import type { FileContent } from "@/types";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx");

// --- 定数 ---

const TEXT_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".md", ".xml",
  ".html", ".htm", ".log", ".tsv",
]);

const SUPPORTED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ".doc", ".docx", ".xls", ".xlsx", ".pdf",
]);

const MAX_TEXT_SIZE = 100 * 1024;         // 100KB
const MAX_BINARY_SIZE = 3 * 1024 * 1024;  // 3MB per file

export { SUPPORTED_EXTENSIONS, TEXT_EXTENSIONS, MAX_TEXT_SIZE, MAX_BINARY_SIZE };

// 拡張子 → MIMEタイプ
const EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".md": "text/markdown",
  ".xml": "text/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".log": "text/plain",
  ".tsv": "text/tab-separated-values",
};

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] || "application/octet-stream";
}

export function isSupportedFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

// --- バッファ解析 ---

/** Excelのシリアル値（5桁数値）を日付文字列に変換 */
function fixExcelDates(csv: string): string {
  return csv.replace(/\b(\d{5})\b/g, (match: string) => {
    const num = parseInt(match, 10);
    if (num >= 40000 && num <= 55000) {
      const date = new Date((num - 25569) * 86400 * 1000);
      return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
    }
    return match;
  });
}

/** PDF → テキスト抽出。テキストが取れなければbase64を返す */
export async function parsePdf(buffer: Buffer): Promise<{ text: string | null; base64: string }> {
  const base64 = buffer.toString("base64");
  try {
    const parsed = await pdfParse(buffer);
    const text = parsed.text?.trim();
    if (text && text.length > 50) {
      return { text, base64 };
    }
  } catch {
    // パース失敗
  }
  return { text: null, base64 };
}

/** docx → テキスト */
export async function parseDocx(buffer: Buffer): Promise<string | null> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value?.trim() || null;
  } catch {
    return null;
  }
}

/** xlsx/xls → CSV テキスト */
export async function parseXlsx(buffer: Buffer): Promise<string | null> {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    let text = "";
    for (const sheetName of workbook.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { rawNumbers: true });
      text += `[シート: ${sheetName}]\n${fixExcelDates(csv)}\n\n`;
    }
    return text.trim() || null;
  } catch {
    return null;
  }
}

// --- ローカルファイル読み取り ---

/**
 * ローカルファイルを読んで FileContent を返す。
 * テキスト・PDF・docx・xlsx すべて対応。
 */
export async function readLocalFile(filePath: string): Promise<FileContent | null> {
  try {
    const name = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = getMimeType(filePath);

    const stat = await fs.stat(filePath);

    // PDF
    if (ext === ".pdf") {
      if (stat.size > MAX_BINARY_SIZE) {
        return { name, path: filePath, content: `[ファイルサイズが大きすぎます: ${(stat.size / 1024 / 1024).toFixed(1)}MB]` };
      }
      const buffer = await fs.readFile(filePath);
      const { text, base64 } = await parsePdf(buffer);
      if (text) {
        return { name, path: filePath, content: text };
      }
      return { name, path: filePath, content: `[スキャンPDF: ${name}]`, mimeType: mime, base64 };
    }

    // docx
    if (ext === ".docx") {
      const buffer = await fs.readFile(filePath);
      const text = await parseDocx(buffer);
      if (text) return { name, path: filePath, content: text };
      return { name, path: filePath, content: `[読み取れませんでした: ${name}]` };
    }

    // xlsx / xls
    if (ext === ".xlsx" || ext === ".xls") {
      const buffer = await fs.readFile(filePath);
      const text = await parseXlsx(buffer);
      if (text) return { name, path: filePath, content: text };
      return { name, path: filePath, content: `[読み取れませんでした: ${name}]` };
    }

    // テキスト系
    if (TEXT_EXTENSIONS.has(ext)) {
      if (stat.size > MAX_TEXT_SIZE) {
        return { name, path: filePath, content: `[ファイルサイズが大きすぎます: ${(stat.size / 1024).toFixed(1)}KB]` };
      }
      const content = await fs.readFile(filePath, "utf-8");
      return { name, path: filePath, content };
    }

    // サポート外
    return null;
  } catch {
    return null;
  }
}

/**
 * ローカルフォルダ内の全対応ファイルを読む
 */
export async function readLocalFolder(folderPath: string): Promise<FileContent[]> {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const contents: FileContent[] = [];
    let totalBinarySize = 0;

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) continue;
      if (!isSupportedFile(entry.name)) continue;

      const fullPath = path.join(folderPath, entry.name);
      const ext = path.extname(entry.name).toLowerCase();

      // PDFの合計サイズ制限
      if (ext === ".pdf") {
        const stat = await fs.stat(fullPath);
        if (totalBinarySize + stat.size > 8 * 1024 * 1024) {
          contents.push({ name: entry.name, path: fullPath, content: "[スキップ: 合計サイズ上限に達しました]" });
          continue;
        }
        totalBinarySize += stat.size;
      }

      const content = await readLocalFile(fullPath);
      if (content) contents.push(content);
    }

    return contents;
  } catch {
    return [];
  }
}
