/**
 * file-parsers.ts — バイナリファイルのパーサー共通モジュール
 * PDF, docx, xlsx を Buffer から FileContent に変換する。
 * プロバイダー（ローカル/Google/Dropbox）に依存しない。
 */

import type { FileContent } from "@/types";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx");

// テキストとして読めるMIMEタイプ
export const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/html",
  "text/xml",
  "text/tab-separated-values",
  "application/json",
  "text/markdown",
]);

// PDFなどバイナリだがClaudeに渡せるもの
export const BINARY_MIME_TYPES = new Set([
  "application/pdf",
]);

// Office系
export const OFFICE_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",      // .xlsx
  "application/vnd.ms-excel",                                                // .xls
]);

// Google Docs系エクスポート先
export const GOOGLE_EXPORT_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const MAX_TEXT_SIZE = 100 * 1024; // 100KB
export const MAX_BINARY_SIZE = 3 * 1024 * 1024; // 3MB per file
export const MAX_TOTAL_BINARY_SIZE = 8 * 1024 * 1024; // 全PDFの合計上限 8MB

// 拡張子→MIMEタイプ
const EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "text/xml",
  ".tsv": "text/tab-separated-values",
  ".log": "text/plain",
};

export function mimeFromExtension(ext: string): string {
  return EXT_TO_MIME[ext.toLowerCase()] || "application/octet-stream";
}

export function isSupportedMimeType(mimeType: string): boolean {
  return (
    TEXT_MIME_TYPES.has(mimeType) ||
    BINARY_MIME_TYPES.has(mimeType) ||
    OFFICE_MIME_TYPES.has(mimeType) ||
    mimeType in GOOGLE_EXPORT_TYPES
  );
}

/** Excelシリアル日付値を yyyy/MM/dd に変換 */
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

/** PDF Buffer → FileContent */
export async function parsePdf(buffer: Buffer, name: string, filePath: string): Promise<FileContent> {
  if (buffer.length > MAX_BINARY_SIZE) {
    return { name, path: filePath, content: `[ファイルサイズが大きすぎます: ${(buffer.length / 1024 / 1024).toFixed(1)}MB]` };
  }

  try {
    const parsed = await pdfParse(buffer);
    const text = parsed.text?.trim();
    if (text && text.length > 50) {
      return { name, path: filePath, content: text };
    }
  } catch {
    // パース失敗 → base64にフォールバック
  }

  // テキストが取れない（スキャンPDF等）→ base64
  const base64 = buffer.toString("base64");
  return {
    name,
    path: filePath,
    content: `[スキャンPDF: ${name}]`,
    mimeType: "application/pdf",
    base64,
  };
}

/** DOCX Buffer → FileContent */
export async function parseDocx(buffer: Buffer, name: string, filePath: string): Promise<FileContent> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value?.trim();
    if (text) return { name, path: filePath, content: text };
  } catch {
    // パース失敗
  }
  return { name, path: filePath, content: `[読み取れませんでした: ${name}]` };
}

/** XLSX/XLS Buffer → FileContent */
export async function parseSpreadsheet(buffer: Buffer, name: string, filePath: string): Promise<FileContent> {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    let text = "";
    for (const sheetName of workbook.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { rawNumbers: true });
      text += `[シート: ${sheetName}]\n${fixExcelDates(csv)}\n\n`;
    }
    if (text.trim()) return { name, path: filePath, content: text.trim() };
  } catch {
    // パース失敗
  }
  return { name, path: filePath, content: `[読み取れませんでした: ${name}]` };
}

/** MIMEタイプに応じて Buffer をパースする汎用関数 */
export async function parseBuffer(buffer: Buffer, name: string, filePath: string, mimeType: string): Promise<FileContent | null> {
  // PDF
  if (BINARY_MIME_TYPES.has(mimeType)) {
    return parsePdf(buffer, name, filePath);
  }

  // DOCX
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return parseDocx(buffer, name, filePath);
  }

  // XLSX / XLS
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel"
  ) {
    return parseSpreadsheet(buffer, name, filePath);
  }

  // テキスト系
  if (TEXT_MIME_TYPES.has(mimeType)) {
    if (buffer.length > MAX_TEXT_SIZE) {
      return { name, path: filePath, content: `[ファイルサイズが大きすぎます]` };
    }
    return { name, path: filePath, content: buffer.toString("utf-8") };
  }

  return null;
}
