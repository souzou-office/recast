import fs from "fs/promises";
import path from "path";
import type { FileInfo, FileContent } from "@/types";
import {
  mimeFromExtension,
  parseBuffer,
  MAX_BINARY_SIZE,
  MAX_TOTAL_BINARY_SIZE,
  BINARY_MIME_TYPES,
  TEXT_MIME_TYPES,
  MAX_TEXT_SIZE,
} from "./file-parsers";

const SUPPORTED_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".md", ".xml",
  ".html", ".htm", ".log", ".tsv",
  ".doc", ".docx", ".docm", ".xls", ".xlsx", ".pdf",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff",
]);

/** ローカルフォルダのファイル一覧 */
export async function listFiles(dirPath: string): Promise<FileInfo[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files: FileInfo[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push({
          name: entry.name,
          path: fullPath,
          size: 0,
          isDirectory: true,
        });
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          const stat = await fs.stat(fullPath);
          files.push({
            name: entry.name,
            path: fullPath,
            size: stat.size,
            isDirectory: false,
          });
        }
      }
    }

    return files.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** ローカルファイル読み取り（テキスト・PDF・docx・xlsx対応） */
export async function readFileContent(filePath: string): Promise<FileContent | null> {
  try {
    const name = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = mimeFromExtension(ext);
    const buffer = await fs.readFile(filePath);
    return parseBuffer(buffer, name, filePath, mime);
  } catch {
    return null;
  }
}

/** ローカルフォルダ内の全ファイルを再帰的に読む */
export async function readAllFilesInFolder(dirPath: string): Promise<FileContent[]> {
  const contents: FileContent[] = [];
  let totalBinarySize = 0;

  async function walk(dir: string) {
    const entries = await listFiles(dir);
    for (const entry of entries) {
      if (entry.isDirectory) {
        await walk(entry.path);
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      const mime = mimeFromExtension(ext);

      if (TEXT_MIME_TYPES.has(mime) && entry.size > MAX_TEXT_SIZE) continue;
      if (BINARY_MIME_TYPES.has(mime)) {
        if (entry.size > MAX_BINARY_SIZE) continue;
        if (totalBinarySize + entry.size > MAX_TOTAL_BINARY_SIZE) {
          contents.push({ name: entry.name, path: entry.path, content: `[スキップ: 合計サイズ上限に達しました]` });
          continue;
        }
        totalBinarySize += entry.size;
      }

      const content = await readFileContent(entry.path);
      if (content) contents.push(content);
    }
  }

  await walk(dirPath);
  return contents;
}
