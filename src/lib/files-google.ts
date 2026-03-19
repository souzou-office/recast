import { getValidGoogleToken } from "./tokens";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx");
import type { FileInfo, FileContent } from "@/types";

const API_BASE = "https://www.googleapis.com/drive/v3";

// テキストとして読めるMIMEタイプ
const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/html",
  "text/xml",
  "text/tab-separated-values",
  "application/json",
  "text/markdown",
]);

// バイナリだがClaudeに渡せるMIMEタイプ
const BINARY_MIME_TYPES = new Set([
  "application/pdf",
]);

// Google Docs系はエクスポートで対応
const GOOGLE_EXPORT_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

// Office系
const OFFICE_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",      // .xlsx
  "application/vnd.ms-excel",                                                // .xls
]);

const MAX_TEXT_SIZE = 100 * 1024; // 100KB
const MAX_BINARY_SIZE = 3 * 1024 * 1024; // 3MB per file
const MAX_TOTAL_BINARY_SIZE = 8 * 1024 * 1024; // 全PDFの合計上限 8MB

function isSupportedMimeType(mimeType: string): boolean {
  return (
    TEXT_MIME_TYPES.has(mimeType) ||
    BINARY_MIME_TYPES.has(mimeType) ||
    OFFICE_MIME_TYPES.has(mimeType) ||
    mimeType in GOOGLE_EXPORT_TYPES
  );
}

async function driveRequest(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
  return res;
}

export async function listFilesGoogle(folderId: string): Promise<FileInfo[]> {
  const token = await getValidGoogleToken();
  if (!token) return [];

  try {
    const q = `'${folderId}' in parents and trashed = false`;
    const fields = "files(id,name,mimeType,size)";
    const params = new URLSearchParams({
      q, fields, pageSize: "100",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });
    const res = await driveRequest(`/files?${params}`, token);
    if (!res.ok) return [];

    const data = await res.json();
    const files: FileInfo[] = [];

    for (const f of data.files || []) {
      const isDir = f.mimeType === "application/vnd.google-apps.folder";

      if (isDir || isSupportedMimeType(f.mimeType)) {
        files.push({
          name: f.name,
          path: f.id,
          size: parseInt(f.size || "0", 10),
          isDirectory: isDir,
        });
      }
    }

    return files.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function readFileContentGoogle(
  fileId: string,
  fileName: string,
  mimeType?: string
): Promise<FileContent | null> {
  const token = await getValidGoogleToken();
  if (!token) return null;

  try {
    // Google Docs系はエクスポート
    const exportMime = mimeType ? GOOGLE_EXPORT_TYPES[mimeType] : undefined;
    if (exportMime) {
      const params = new URLSearchParams({ mimeType: exportMime });
      const res = await driveRequest(`/files/${fileId}/export?${params}`, token);
      if (!res.ok) return null;
      const content = await res.text();
      return { name: fileName, path: fileId, content };
    }

    // PDF → まずテキスト抽出、ダメならbase64
    if (mimeType && BINARY_MIME_TYPES.has(mimeType)) {
      const res = await driveRequest(`/files/${fileId}?alt=media&supportsAllDrives=true`, token);
      if (!res.ok) return null;

      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_BINARY_SIZE) {
        return { name: fileName, path: fileId, content: `[ファイルサイズが大きすぎます: ${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(1)}MB]` };
      }

      const buffer = Buffer.from(await res.arrayBuffer());

      // テキスト抽出を試みる
      try {
        const parsed = await pdfParse(buffer);
        const text = parsed.text?.trim();
        if (text && text.length > 50) {
          // テキストが十分にある → テキストとして渡す（軽い）
          return { name: fileName, path: fileId, content: text };
        }
      } catch {
        // パース失敗 → base64にフォールバック
      }

      // テキストが取れない（スキャンPDF等）→ base64で画像として渡す
      const base64 = buffer.toString("base64");
      return {
        name: fileName,
        path: fileId,
        content: `[スキャンPDF: ${fileName}]`,
        mimeType,
        base64,
      };
    }

    // Office系 → テキスト抽出
    if (mimeType && OFFICE_MIME_TYPES.has(mimeType)) {
      const res = await driveRequest(`/files/${fileId}?alt=media&supportsAllDrives=true`, token);
      if (!res.ok) return null;

      const buffer = Buffer.from(await res.arrayBuffer());

      try {
        // docx
        if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
          const result = await mammoth.extractRawText({ buffer });
          const text = result.value?.trim();
          if (text) return { name: fileName, path: fileId, content: text };
        }

        // xlsx / xls
        if (
          mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
          mimeType === "application/vnd.ms-excel"
        ) {
          const workbook = XLSX.read(buffer, { type: "buffer" });
          let text = "";
          for (const sheetName of workbook.SheetNames) {
            const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
            text += `[シート: ${sheetName}]\n${csv}\n\n`;
          }
          if (text.trim()) return { name: fileName, path: fileId, content: text.trim() };
        }
      } catch {
        // パース失敗
      }

      return { name: fileName, path: fileId, content: `[読み取れませんでした: ${fileName}]` };
    }

    // テキスト系
    const res = await driveRequest(`/files/${fileId}?alt=media&supportsAllDrives=true`, token);
    if (!res.ok) return null;

    const content = await res.text();
    if (content.length > MAX_TEXT_SIZE) {
      return { name: fileName, path: fileId, content: `[ファイルサイズが大きすぎます]` };
    }

    return { name: fileName, path: fileId, content };
  } catch {
    return null;
  }
}

export async function readAllFilesInFolderGoogle(
  folderId: string
): Promise<FileContent[]> {
  const token = await getValidGoogleToken();
  if (!token) return [];

  try {
    const q = `'${folderId}' in parents and trashed = false`;
    const fields = "files(id,name,mimeType,size)";
    const params = new URLSearchParams({
      q, fields, pageSize: "100",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });
    const res = await driveRequest(`/files?${params}`, token);
    if (!res.ok) return [];

    const data = await res.json();
    const contents: FileContent[] = [];
    let totalBinarySize = 0;

    for (const f of data.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") continue;
      if (!isSupportedMimeType(f.mimeType)) continue;

      const size = parseInt(f.size || "0", 10);
      if (TEXT_MIME_TYPES.has(f.mimeType) && size > MAX_TEXT_SIZE) continue;
      if (BINARY_MIME_TYPES.has(f.mimeType)) {
        if (size > MAX_BINARY_SIZE) continue;
        if (totalBinarySize + size > MAX_TOTAL_BINARY_SIZE) {
          contents.push({
            name: f.name,
            path: f.id,
            content: `[スキップ: 合計サイズ上限に達しました]`,
          });
          continue;
        }
        totalBinarySize += size;
      }

      const content = await readFileContentGoogle(f.id, f.name, f.mimeType);
      if (content) contents.push(content);
    }

    return contents;
  } catch {
    return [];
  }
}

// フォルダ一覧（ブラウザ用）
export async function listFoldersGoogle(
  parentId: string = "root"
): Promise<{ current: string; parent: string | null; dirs: { name: string; path: string }[] }> {
  const token = await getValidGoogleToken();
  if (!token) throw new Error("Google Drive未接続");

  // ルートでは「マイドライブ」「共有アイテム」「共有ドライブ」を表示
  if (parentId === "root") {
    const dirs: { name: string; path: string }[] = [
      { name: "マイドライブ", path: "my-drive" },
      { name: "共有アイテム", path: "shared-with-me" },
    ];

    try {
      const res = await driveRequest("/drives?pageSize=50", token);
      if (res.ok) {
        const data = await res.json();
        for (const drive of data.drives || []) {
          dirs.push({ name: drive.name, path: `drive:${drive.id}` });
        }
      }
    } catch {
      // 共有ドライブがなくてもOK
    }

    return { current: "root", parent: null, dirs };
  }

  if (parentId === "my-drive") {
    return listDriveFolders("root", "my-drive", "root", token);
  }

  if (parentId === "shared-with-me") {
    const q = `sharedWithMe = true and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const fields = "files(id,name)";
    const params = new URLSearchParams({ q, fields, pageSize: "100" });
    const res = await driveRequest(`/files?${params}`, token);
    if (!res.ok) throw new Error("共有アイテムの取得に失敗");

    const data = await res.json();
    const dirs = (data.files || [])
      .map((f: { id: string; name: string }) => ({ name: f.name, path: f.id }))
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

    return { current: "shared-with-me", parent: "root", dirs };
  }

  if (parentId.startsWith("drive:")) {
    const driveId = parentId.slice(6);
    return listDriveFolders(driveId, parentId, "root", token, driveId);
  }

  // 通常のフォルダ — 親はGoogle APIから取得
  try {
    const metaParams = new URLSearchParams({
      fields: "parents",
      supportsAllDrives: "true",
    });
    const metaRes = await driveRequest(`/files/${parentId}?${metaParams}`, token);
    let parentFolder = "root";
    if (metaRes.ok) {
      const meta = await metaRes.json();
      if (meta.parents && meta.parents.length > 0) {
        parentFolder = meta.parents[0];
      }
    }
    return listDriveFolders(parentId, parentId, parentFolder, token);
  } catch {
    return listDriveFolders(parentId, parentId, "root", token);
  }
}

async function listDriveFolders(
  folderId: string,
  currentId: string,
  parentId: string,
  token: string,
  driveId?: string
): Promise<{ current: string; parent: string | null; dirs: { name: string; path: string }[] }> {
  const q = `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const fields = "files(id,name)";
  const searchParams = new URLSearchParams({
    q, fields, pageSize: "100",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
  });
  if (driveId) {
    searchParams.set("driveId", driveId);
    searchParams.set("corpora", "drive");
  }
  const res = await driveRequest(`/files?${searchParams}`, token);
  if (!res.ok) throw new Error("フォルダ一覧の取得に失敗");

  const data = await res.json();
  const dirs = (data.files || [])
    .map((f: { id: string; name: string }) => ({ name: f.name, path: f.id }))
    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

  return { current: currentId, parent: parentId, dirs };
}

// 単一ファイル読み取り（chat APIから使う）
export const readFileById = readFileContentGoogle;
