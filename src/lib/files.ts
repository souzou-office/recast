import fs from "fs/promises";
import path from "path";
import type { FileInfo, FileContent, FolderProvider } from "@/types";
import { readAllFilesInFolderGoogle } from "./files-google";
import { readAllFilesInFolderDropbox } from "./files-dropbox";

const SUPPORTED_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".md", ".xml",
  ".html", ".htm", ".log", ".tsv",
  ".doc", ".docx", ".xls", ".xlsx", ".pdf",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".md", ".xml",
  ".html", ".htm", ".log", ".tsv",
]);

const MAX_FILE_SIZE = 100 * 1024; // 100KB

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

export async function readFileContent(filePath: string): Promise<FileContent | null> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      return {
        name: path.basename(filePath),
        path: filePath,
        content: `[バイナリファイル: ${path.basename(filePath)}]`,
      };
    }

    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      return {
        name: path.basename(filePath),
        path: filePath,
        content: `[ファイルサイズが大きすぎます: ${(stat.size / 1024).toFixed(1)}KB]`,
      };
    }

    const content = await fs.readFile(filePath, "utf-8");
    return {
      name: path.basename(filePath),
      path: filePath,
      content,
    };
  } catch {
    return null;
  }
}

export async function readAllFilesInFolder(
  folderPath: string,
  provider: FolderProvider = "local"
): Promise<FileContent[]> {
  switch (provider) {
    case "google":
      return readAllFilesInFolderGoogle(folderPath);
    case "dropbox":
      return readAllFilesInFolderDropbox(folderPath);
    default: {
      const files = await listFiles(folderPath);
      const contents: FileContent[] = [];
      for (const file of files) {
        if (file.isDirectory) continue;
        const content = await readFileContent(file.path);
        if (content) contents.push(content);
      }
      return contents;
    }
  }
}
