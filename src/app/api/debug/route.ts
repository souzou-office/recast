import { NextResponse } from "next/server";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { getValidGoogleToken } from "@/lib/tokens";
import type { FileContent } from "@/types";

export async function GET() {
  const config = await getWorkspaceConfig();
  const provider = config.baseFolder?.provider ?? "local";
  const company = config.companies.find(c => c.id === config.selectedCompanyId);

  const result: {
    config: typeof config;
    provider: string;
    selectedCompany: typeof company;
    globalCommonFiles: { folder: string; count: number; files: string[] }[];
    companyFiles: { folder: string; role: string; active: boolean; count: number; files: string[] }[];
    errors: string[];
  } = {
    config,
    provider,
    selectedCompany: company,
    globalCommonFiles: [],
    companyFiles: [],
    errors: [],
  };

  // グローバル共通
  for (const folder of config.globalCommon) {
    try {
      const files = await readAllFilesInFolder(folder.id, provider);
      result.globalCommonFiles.push({
        folder: folder.name,
        count: files.length,
        files: files.map(f => f.name),
      });
    } catch (e) {
      result.errors.push(`globalCommon ${folder.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 会社フォルダ
  if (company) {
    for (const sub of company.subfolders) {
      try {
        const files = await readAllFilesInFolder(sub.id, provider);
        result.companyFiles.push({
          folder: sub.name,
          role: sub.role,
          active: sub.active,
          count: files.length,
          files: files.map(f => f.name),
        });
      } catch (e) {
        result.errors.push(`company ${sub.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Google Drive APIの生データを確認（最初のフォルダ）
  const testFolderId = company?.subfolders[0]?.id;
  if (testFolderId && provider === "google") {
    const token = await getValidGoogleToken();
    if (token) {
      try {
        const q = `'${testFolderId}' in parents and trashed = false`;
        const params = new URLSearchParams({
          q,
          fields: "files(id,name,mimeType,size)",
          pageSize: "100",
          includeItemsFromAllDrives: "true",
          supportsAllDrives: "true",
        });
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const raw = await res.json();
        (result as Record<string, unknown>).driveApiRaw = {
          status: res.status,
          testFolder: testFolderId,
          response: raw,
        };
      } catch (e) {
        (result as Record<string, unknown>).driveApiError = String(e);
      }
    } else {
      (result as Record<string, unknown>).driveApiError = "token is null";
    }
  }

  return NextResponse.json(result, { status: 200 });
}
