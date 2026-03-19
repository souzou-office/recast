import { NextRequest, NextResponse } from "next/server";
import { getValidGoogleToken } from "@/lib/tokens";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";
import type { CachedFile } from "@/types";

const API_BASE = "https://www.googleapis.com/drive/v3";

const SUPPORTED_MIME_TYPES = new Set([
  "text/plain", "text/csv", "text/html", "text/xml",
  "text/tab-separated-values", "application/json", "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
]);

// ファイル名を正規化（日付・バージョン・マーカーを除去）
function normalizeName(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")                  // 拡張子除去
    .replace(/【[^】]*】/g, "")                // 【最新】等を除去
    .replace(/\(.*?\)/g, "")                   // (カッコ内)除去
    .replace(/（.*?）/g, "")                   // （全角カッコ）除去
    .replace(/_?\d{6,8}/g, "")                 // 日付 20220913, 221220 等
    .replace(/_?v\d+/gi, "")                   // バージョン _v5 等
    .replace(/[\s_\-]+/g, " ")                 // 空白正規化
    .trim()
    .toLowerCase();
}

// 類似ファイルをグループ化し、最新だけenabledにする
function deduplicateFiles(files: CachedFile[]): CachedFile[] {
  const groups = new Map<string, CachedFile[]>();

  for (const file of files) {
    const key = normalizeName(file.name);
    const group = groups.get(key) || [];
    group.push(file);
    groups.set(key, group);
  }

  const result: CachedFile[] = [];
  for (const group of groups.values()) {
    // modifiedTimeで降順ソート
    group.sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime());
    for (let i = 0; i < group.length; i++) {
      result.push({ ...group[i], enabled: i === 0 }); // 最新だけenabled
    }
  }

  return result;
}

export async function POST(request: NextRequest) {
  const { companyId, subfolderId } = await request.json();

  if (!companyId || !subfolderId) {
    return NextResponse.json({ error: "companyId, subfolderId は必須です" }, { status: 400 });
  }

  const token = await getValidGoogleToken();
  if (!token) {
    return NextResponse.json({ error: "Google Drive未接続" }, { status: 401 });
  }

  try {
    const q = `'${subfolderId}' in parents and trashed = false`;
    const fields = "files(id,name,mimeType,size,modifiedTime)";
    const params = new URLSearchParams({
      q, fields, pageSize: "200",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });
    const res = await fetch(`${API_BASE}/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      return NextResponse.json({ error: "ファイル一覧の取得に失敗" }, { status: 500 });
    }

    const data = await res.json();
    const rawFiles: CachedFile[] = [];

    for (const f of data.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") continue;
      if (!SUPPORTED_MIME_TYPES.has(f.mimeType)) continue;

      rawFiles.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: parseInt(f.size || "0", 10),
        modifiedTime: f.modifiedTime || new Date().toISOString(),
        enabled: true,
      });
    }

    // 重複排除（最新だけenabled）
    const files = deduplicateFiles(rawFiles);

    // configに保存 + 新規ファイル検出
    const config = await getWorkspaceConfig();
    const company = config.companies.find(c => c.id === companyId);
    const newFileIds: { id: string; name: string; mimeType: string }[] = [];

    if (company) {
      const sub = company.subfolders.find(s => s.id === subfolderId);
      if (sub) {
        // 既存ファイルIDを取得
        const existingIds = new Set((sub.files || []).map(f => f.id));
        // 新規ファイルを検出
        for (const f of files) {
          if (!existingIds.has(f.id)) {
            newFileIds.push({ id: f.id, name: f.name, mimeType: f.mimeType });
          }
        }
        sub.files = files;
        await saveWorkspaceConfig(config);
      }
    }

    return NextResponse.json({ files, newFiles: newFileIds });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "スキャンに失敗" },
      { status: 500 }
    );
  }
}
