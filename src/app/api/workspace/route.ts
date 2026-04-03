import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";
import { listFiles } from "@/lib/files";
import type { Subfolder } from "@/types";

// サブフォルダを検出（中間フォルダはスキップして中に入る）
async function detectSubfolders(companyPath: string, patterns: string[]): Promise<Subfolder[]> {
  const topEntries = await listFiles(companyPath);
  const topDirs = topEntries.filter(e => e.isDirectory);
  const topFiles = topEntries.filter(e => !e.isDirectory);

  // 直下にファイルがある場合はそのまま登録
  if (topFiles.length > 0 || topDirs.length === 0) {
    return topDirs.map(d => ({
      id: d.path,
      name: d.name,
      role: matchesCommonPattern(d.name, patterns) ? "common" as const : "job" as const,
      active: matchesCommonPattern(d.name, patterns),
    }));
  }

  // 直下にファイルがなくサブフォルダのみ → 中間フォルダとして中を見る
  const subfolders: Subfolder[] = [];
  for (const topDir of topDirs) {
    const innerEntries = await listFiles(topDir.path);
    const innerDirs = innerEntries.filter(e => e.isDirectory);
    const innerFiles = innerEntries.filter(e => !e.isDirectory);

    if (innerDirs.length > 0 && innerFiles.length === 0) {
      // さらに中間フォルダ → その中のフォルダを登録
      for (const innerDir of innerDirs) {
        subfolders.push({
          id: innerDir.path,
          name: innerDir.name,
          role: matchesCommonPattern(innerDir.name, patterns) ? "common" as const : "job" as const,
          active: matchesCommonPattern(innerDir.name, patterns),
        });
      }
    } else {
      // ファイルがある or 空 → このフォルダ自体を登録
      subfolders.push({
        id: topDir.path,
        name: topDir.name,
        role: matchesCommonPattern(topDir.name, patterns) ? "common" as const : "job" as const,
        active: matchesCommonPattern(topDir.name, patterns),
      });
    }
  }
  return subfolders;
}

function matchesCommonPattern(name: string, patterns: string[]): boolean {
  return patterns.some(p => name.toLowerCase().includes(p.toLowerCase()));
}

// 設定取得
export async function GET() {
  const config = await getWorkspaceConfig();
  return NextResponse.json(config);
}

// ベースパス設定 + 会社自動検出
export async function POST(request: NextRequest) {
  const { basePath } = await request.json() as { basePath: string };
  if (!basePath) {
    return NextResponse.json({ error: "basePath は必須です" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  config.basePath = basePath;

  const entries = await listFiles(basePath);
  const dirs = entries.filter(e => e.isDirectory);
  const patterns = config.defaultCommonPatterns || [];

  for (const dir of dirs) {
    const existing = config.companies.find(c => c.id === dir.path);
    if (existing) continue;

    const subfolders = await detectSubfolders(dir.path, patterns);

    config.companies.push({
      id: dir.path,
      name: dir.name,
      subfolders,
    });
  }

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

    case "toggleFile": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        const sub = company.subfolders.find(s => s.id === body.subfolderId);
        if (sub) {
          if (!sub.disabledFiles) sub.disabledFiles = [];
          if (body.enabled) {
            sub.disabledFiles = sub.disabledFiles.filter(f => f !== body.filePath);
          } else {
            if (!sub.disabledFiles.includes(body.filePath)) {
              sub.disabledFiles.push(body.filePath);
            }
          }
        }
      }
      break;
    }

    case "setDefaultCommonPatterns": {
      config.defaultCommonPatterns = body.patterns;
      break;
    }

    case "applyDefaultCommon": {
      const patterns = config.defaultCommonPatterns || [];
      for (const company of config.companies) {
        for (const sub of company.subfolders) {
          if (sub.role === "none") continue; // 除外は触らない
          if (matchesCommonPattern(sub.name, patterns)) {
            sub.role = "common";
            sub.active = true;
          } else {
            sub.role = "job";
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

    case "rescanCompany": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        const patterns = config.defaultCommonPatterns || [];
        const newSubs = await detectSubfolders(company.id, patterns);
        // 既存設定を保持しつつ新しいフォルダを追加
        for (const ns of newSubs) {
          if (!company.subfolders.find(s => s.id === ns.id)) {
            company.subfolders.push(ns);
          }
        }
        // 存在しないフォルダを除去
        const { existsSync } = require("fs");
        company.subfolders = company.subfolders.filter(s => existsSync(s.id));
      }
      break;
    }

    case "removeCompany": {
      config.companies = config.companies.filter(c => c.id !== body.companyId);
      if (config.selectedCompanyId === body.companyId) {
        config.selectedCompanyId = null;
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

    default:
      return NextResponse.json({ error: "不明なaction" }, { status: 400 });
  }

  await saveWorkspaceConfig(config);
  return NextResponse.json(config);
}

// リセット
export async function DELETE() {
  const config = {
    basePath: "",
    defaultCommonPatterns: [],
    companies: [],
    selectedCompanyId: null,
  };
  await saveWorkspaceConfig(config);
  return NextResponse.json(config);
}
