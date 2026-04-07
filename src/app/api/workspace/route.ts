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

    case "selectSingleJob": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        for (const sub of company.subfolders) {
          if (sub.role === "job") {
            sub.active = sub.id === body.subfolderId ? body.active : false;
          }
        }
      }
      break;
    }

    case "selectSingleFolder": {
      // 同階層の兄弟フォルダを全部disable、選んだものだけenable
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        const sub = company.subfolders.find(s => s.id === body.subfolderId);
        if (sub) {
          if (!sub.disabledFiles) sub.disabledFiles = [];
          const siblings: string[] = body.siblingPaths || [];
          // 兄弟を全部disableに
          for (const sib of siblings) {
            if (sib !== body.selectedPath && !sub.disabledFiles.includes(sib)) {
              sub.disabledFiles.push(sib);
            }
          }
          // 選んだものをenabledに
          sub.disabledFiles = sub.disabledFiles.filter(f => f !== body.selectedPath);
        }
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

    case "setTemplateBasePath": {
      config.templateBasePath = body.templateBasePath || "";
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

    case "saveGeneratedDocument": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        if (!company.generatedDocuments) company.generatedDocuments = [];
        company.generatedDocuments.push({
          templateName: body.templateName,
          docxBase64: body.docxBase64,
          previewHtml: body.previewHtml,
          fileName: body.fileName,
          createdAt: new Date().toISOString(),
        });
      }
      break;
    }

    case "deleteGeneratedDocument": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company && company.generatedDocuments) {
        company.generatedDocuments.splice(body.index, 1);
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

    case "createCaseRoom": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        if (!company.caseRooms) company.caseRooms = [];
        const now = new Date().toISOString();
        company.caseRooms.push({
          id: `case_${Date.now()}`,
          folderPath: body.folderPath || "",
          displayName: body.displayName || "新規案件",
          createdAt: now,
          updatedAt: now,
        });
      }
      break;
    }

    case "updateCaseRoom": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        const room = company.caseRooms?.find(r => r.id === body.caseRoomId);
        if (room) {
          if (body.displayName !== undefined) room.displayName = body.displayName;
          if (body.folderPath !== undefined) room.folderPath = body.folderPath;
          if (body.masterSheet !== undefined) room.masterSheet = body.masterSheet;
          if (body.generatedDocuments !== undefined) room.generatedDocuments = body.generatedDocuments;
          if (body.checkResult !== undefined) room.checkResult = body.checkResult;
          room.updatedAt = new Date().toISOString();
        }
      }
      break;
    }

    case "deleteCaseRoom": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company && company.caseRooms) {
        company.caseRooms = company.caseRooms.filter(r => r.id !== body.caseRoomId);
      }
      break;
    }

    case "saveCaseRoomMasterSheet": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        const room = company.caseRooms?.find(r => r.id === body.caseRoomId);
        if (room) {
          room.masterSheet = body.masterSheet;
          room.updatedAt = new Date().toISOString();
        }
      }
      break;
    }

    case "saveCaseRoomDocument": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        const room = company.caseRooms?.find(r => r.id === body.caseRoomId);
        if (room) {
          if (!room.generatedDocuments) room.generatedDocuments = [];
          room.generatedDocuments.push({
            templateName: body.templateName,
            docxBase64: body.docxBase64,
            previewHtml: body.previewHtml,
            fileName: body.fileName,
            createdAt: new Date().toISOString(),
          });
          room.updatedAt = new Date().toISOString();
        }
      }
      break;
    }

    case "saveCaseRoomCheck": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        const room = company.caseRooms?.find(r => r.id === body.caseRoomId);
        if (room) {
          room.checkResult = body.checkResult;
          room.updatedAt = new Date().toISOString();
        }
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
    templateBasePath: "",
    defaultCommonPatterns: [],
    companies: [],
    selectedCompanyId: null,
  };
  await saveWorkspaceConfig(config);
  return NextResponse.json(config);
}
