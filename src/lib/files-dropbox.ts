import { getValidDropboxToken } from "./tokens";
import type { FileInfo, FileContent } from "@/types";
import path from "path";
import { mimeFromExtension, parseBuffer } from "./file-parsers";

const API_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";

const SUPPORTED_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".md", ".xml",
  ".html", ".htm", ".log", ".tsv",
  ".doc", ".docx", ".xls", ".xlsx", ".pdf",
]);

async function dropboxApi(endpoint: string, token: string, body?: object) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

export async function listFilesDropbox(folderPath: string): Promise<FileInfo[]> {
  const token = await getValidDropboxToken();
  if (!token) return [];

  try {
    const res = await dropboxApi("/files/list_folder", token, {
      path: folderPath === "/" ? "" : folderPath,
      limit: 100,
    });
    if (!res.ok) return [];

    const data = await res.json();
    const files: FileInfo[] = [];

    for (const entry of data.entries || []) {
      if (entry[".tag"] === "folder") {
        files.push({
          name: entry.name,
          path: entry.path_lower || entry.path_display,
          size: 0,
          isDirectory: true,
        });
      } else if (entry[".tag"] === "file") {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          files.push({
            name: entry.name,
            path: entry.path_lower || entry.path_display,
            size: entry.size || 0,
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

export async function readFileContentDropbox(
  filePath: string,
  fileName: string
): Promise<FileContent | null> {
  const token = await getValidDropboxToken();
  if (!token) return null;

  try {
    const res = await fetch(`${CONTENT_BASE}/files/download`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path: filePath }),
      },
    });

    if (!res.ok) return null;

    const ext = path.extname(fileName).toLowerCase();
    const mime = mimeFromExtension(ext);
    const buffer = Buffer.from(await res.arrayBuffer());
    return parseBuffer(buffer, fileName, filePath, mime);
  } catch {
    return null;
  }
}

export async function readAllFilesInFolderDropbox(
  folderPath: string
): Promise<FileContent[]> {
  const files = await listFilesDropbox(folderPath);
  const contents: FileContent[] = [];

  for (const file of files) {
    if (file.isDirectory) continue;
    const content = await readFileContentDropbox(file.path, file.name);
    if (content) contents.push(content);
  }

  return contents;
}

// フォルダ一覧（ブラウザ用）
export async function listFoldersDropbox(
  folderPath: string = ""
): Promise<{ current: string; parent: string | null; dirs: { name: string; path: string }[] }> {
  const token = await getValidDropboxToken();
  if (!token) throw new Error("Dropbox未接続");

  const res = await dropboxApi("/files/list_folder", token, {
    path: folderPath === "/" ? "" : folderPath,
    limit: 100,
  });
  if (!res.ok) throw new Error("フォルダ一覧の取得に失敗");

  const data = await res.json();
  const dirs = (data.entries || [])
    .filter((e: { ".tag": string }) => e[".tag"] === "folder")
    .map((e: { name: string; path_lower: string; path_display: string }) => ({
      name: e.name,
      path: e.path_lower || e.path_display,
    }))
    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

  // 親パスの計算
  let parent: string | null = null;
  if (folderPath && folderPath !== "") {
    const segments = folderPath.split("/").filter(Boolean);
    segments.pop();
    parent = segments.length === 0 ? "" : "/" + segments.join("/");
  }

  return {
    current: folderPath || "/",
    parent,
    dirs,
  };
}
