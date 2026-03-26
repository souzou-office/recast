import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getValidGoogleToken } from "@/lib/tokens";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";
import type { CachedFile } from "@/types";

const API_BASE = "https://www.googleapis.com/drive/v3";
const anthropic = new Anthropic();

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

// Haikuにファイル名一覧を投げて意味レベルでグループ化し、最新だけenabledにする
async function deduplicateFiles(files: CachedFile[]): Promise<CachedFile[]> {
  if (files.length <= 1) {
    return files.map(f => ({ ...f, enabled: true }));
  }

  const fileList = files.map((f, i) => `${i}: ${f.name}`).join("\n");

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `以下はGoogle Driveフォルダ内のファイル名一覧です。
「実質同じ書類」をグループ化してください。

判定ルール：
- 日付・バージョン違いは同じ書類（例：「定款」と「定款_改定版」と「定款(公証役場認証済み)」）
- 正式名称と通称は同じ書類（例：「登記簿謄本」と「履歴事項全部証明書」）
- 内容が異なるものは別グループ（例：「株主名簿」と「株主総会議事録」）

ファイル一覧：
${fileList}

回答はJSONのみ。番号の配列の配列で返してください。
例: [[0,3],[1],[2,4]]`
    }],
  });

  try {
    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return files.map(f => ({ ...f, enabled: true }));
    }
    const groups: number[][] = JSON.parse(match[0]);

    const result: CachedFile[] = [];
    for (const group of groups) {
      const groupFiles = group.map(i => files[i]).filter(Boolean);
      // modifiedTimeで降順ソート → 最新だけenabled
      groupFiles.sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime());
      for (let i = 0; i < groupFiles.length; i++) {
        result.push({ ...groupFiles[i], enabled: i === 0 });
      }
    }

    // グループに含まれなかったファイルがあれば全てenabled
    const grouped = new Set(groups.flat());
    for (let i = 0; i < files.length; i++) {
      if (!grouped.has(i)) {
        result.push({ ...files[i], enabled: true });
      }
    }

    return result;
  } catch {
    // パース失敗時は全てenabledにする
    return files.map(f => ({ ...f, enabled: true }));
  }
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
    const subfolders: { id: string; name: string }[] = [];

    for (const f of data.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") {
        subfolders.push({ id: f.id, name: f.name });
        continue;
      }
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

    // 重複排除（Haikuで意味レベルグループ化、最新だけenabled）
    const files = await deduplicateFiles(rawFiles);

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

    return NextResponse.json({ files, newFiles: newFileIds, subfolders });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "スキャンに失敗" },
      { status: 500 }
    );
  }
}
