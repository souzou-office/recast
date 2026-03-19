import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";
import type { FolderProvider } from "@/types";

// 設定取得
export async function GET() {
  const config = await getWorkspaceConfig();
  return NextResponse.json(config);
}

// ベースフォルダ設定
export async function POST(request: NextRequest) {
  const { id, name, provider } = await request.json() as {
    id: string;
    name: string;
    provider: FolderProvider;
  };

  if (!id || !name || !provider) {
    return NextResponse.json({ error: "id, name, provider は必須です" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  config.baseFolder = { id, name, provider };
  config.globalCommon = [];
  config.companies = [];
  config.selectedCompanyId = null;

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
      // 全会社にデフォルト共通パターンを適用
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

    default:
      return NextResponse.json({ error: "不明なaction" }, { status: 400 });
  }

  await saveWorkspaceConfig(config);
  return NextResponse.json(config);
}

// リセット
export async function DELETE() {
  const config = {
    baseFolder: null,
    globalCommon: [],
    companies: [],
    selectedCompanyId: null,
  };
  await saveWorkspaceConfig(config);
  return NextResponse.json(config);
}
