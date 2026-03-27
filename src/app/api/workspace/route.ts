import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";
import { listFoldersGoogle } from "@/lib/files-google";
import type { FolderProvider, Subfolder } from "@/types";

/** ローカルフォルダのサブディレクトリ一覧を返す */
async function listLocalSubdirs(dirPath: string): Promise<{ name: string; path: string }[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// 設定取得
export async function GET() {
  const config = await getWorkspaceConfig();
  return NextResponse.json(config);
}

// ルートフォルダ追加
export async function POST(request: NextRequest) {
  const { folderId, name, provider } = await request.json() as {
    folderId: string;
    name: string;
    provider: FolderProvider;
  };

  if (!folderId || !name || !provider) {
    return NextResponse.json({ error: "folderId, name, provider は必須です" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();

  // 既に登録済みなら追加しない
  if (config.baseFolders.some(b => b.folderId === folderId)) {
    return NextResponse.json(config);
  }

  config.baseFolders.push({
    id: `base_${Date.now()}`,
    name,
    folderId,
    provider,
  });

  await saveWorkspaceConfig(config);
  return NextResponse.json(config);
}

// 各種更新
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const config = await getWorkspaceConfig();

  switch (body.action) {
    case "selectCompany": {
      config.selectedCompanyId = body.companyId;
      break;
    }

    case "toggleSubfolder": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        const sub = company.subfolders.find(s => s.id === body.subfolderId);
        if (sub) sub.active = body.active;
      }
      break;
    }

    case "setSubfolderRole": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        const sub = company.subfolders.find(s => s.id === body.subfolderId);
        if (sub) {
          sub.role = body.role;
          if (body.role === "common") sub.active = true;
        }
      }
      break;
    }

    case "toggleGlobalCommon": {
      if (body.enabled) {
        if (!config.globalCommon.find(g => g.id === body.folderId)) {
          config.globalCommon.push({ id: body.folderId, name: body.folderName });
        }
      } else {
        config.globalCommon = config.globalCommon.filter(g => g.id !== body.folderId);
      }
      break;
    }

    case "setCompanies": {
      config.companies = body.companies;
      break;
    }

    case "setDefaultCommonPatterns": {
      config.defaultCommonPatterns = body.patterns;
      break;
    }

    case "applyDefaultCommon": {
      for (const company of config.companies) {
        for (const sub of company.subfolders) {
          const matchesPattern = config.defaultCommonPatterns.some(pattern =>
            sub.name.toLowerCase().includes(pattern.toLowerCase())
          );
          if (matchesPattern && sub.role !== "common") {
            sub.role = "common";
            sub.active = true;
          }
        }
      }
      break;
    }

    case "setSubfolders": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        company.subfolders = body.subfolders;
      }
      break;
    }

    case "addFileToSubfolder": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        const sub = company.subfolders.find(s => s.id === body.subfolderId);
        if (sub) {
          if (!sub.files) sub.files = [];
          const existing = sub.files.find(f => f.id === body.file.id);
          if (!existing) {
            sub.files.push(body.file);
          } else {
            existing.enabled = body.file.enabled;
          }
        }
      }
      break;
    }

    case "autoSetupCompany": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company && (company.subfolders.length === 0 || body.force)) {
        try {
          const baseFolder = config.baseFolders.find(b => b.id === company.baseFolderId);
          const provider = baseFolder?.provider || "local";
          let dirs: { name: string; path: string }[] = [];

          if (provider === "local") {
            dirs = await listLocalSubdirs(company.id);
          } else {
            const result = await listFoldersGoogle(company.id);
            dirs = result.dirs;
          }

          const patterns = config.defaultCommonPatterns || [];
          const newSubs: Subfolder[] = dirs.map(d => {
            const isCommon = patterns.some(p => d.name.toLowerCase() === p.toLowerCase());
            return {
              id: d.path,
              name: d.name,
              role: isCommon ? "common" as const : "job" as const,
              active: isCommon,
            };
          });
          company.subfolders = newSubs;
        } catch { /* フォルダ読み取り失敗 */ }
      }
      break;
    }

    case "batchAutoSetup": {
      const patterns = config.defaultCommonPatterns || [];
      if (patterns.length > 0) {
        for (const company of config.companies) {
          if (company.subfolders.length > 0) continue;
          try {
            const result = await listFoldersGoogle(company.id);
            company.subfolders = result.dirs.map(d => {
              const isCommon = patterns.some(p => d.name.toLowerCase() === p.toLowerCase());
              return {
                id: d.path,
                name: d.name,
                role: isCommon ? "common" as const : "job" as const,
                active: isCommon,
              };
            });
          } catch { /* skip */ }
        }
      }
      break;
    }

    case "deleteMasterSheet": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        delete company.masterSheet;
      }
      break;
    }

    case "removeBaseFolder": {
      const baseFolderId = body.baseFolderId;
      config.baseFolders = config.baseFolders.filter(b => b.id !== baseFolderId);
      config.companies = config.companies.filter(c => c.baseFolderId !== baseFolderId);
      if (config.companies.length > 0 && !config.companies.find(c => c.id === config.selectedCompanyId)) {
        config.selectedCompanyId = null;
      }
      break;
    }

    default:
      return NextResponse.json({ error: "不明なaction" }, { status: 400 });
  }

  await saveWorkspaceConfig(config);
  return NextResponse.json(config);
}

// リセット
export async function DELETE() {
  const config = {
    baseFolders: [],
    globalCommon: [],
    defaultCommonPatterns: [],
    companies: [],
    selectedCompanyId: null,
  };
  await saveWorkspaceConfig(config);
  return NextResponse.json(config);
}
