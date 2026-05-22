import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";
import { listFiles } from "@/lib/files";
import type { Subfolder, Company } from "@/types";
import fs from "fs/promises";
import nodePath from "path";

// 「会社フォルダ + 中間フォルダ」の mtime を集めて signature 化する。
// detectSubfolders は中間フォルダ（直下にファイルがなくサブフォルダのみ）の場合
// 1段下の subfolders を返すので、新規 subfolder 検知のためには中間フォルダ自体の
// mtime も見る必要がある。fs.stat だけで済む軽量な比較。
async function computeScannedSig(companyId: string, subfolders: Subfolder[]): Promise<string> {
  const dirs = new Set<string>([companyId]);
  for (const sub of subfolders) {
    const parent = nodePath.dirname(sub.id);
    if (parent && parent !== companyId) dirs.add(parent);
  }
  const sorted = [...dirs].sort();
  const parts: string[] = [];
  for (const dir of sorted) {
    try {
      const st = await fs.stat(dir);
      parts.push(`${dir}:${st.mtimeMs}`);
    } catch {
      parts.push(`${dir}:missing`);
    }
  }
  return parts.join("|");
}

// 既存 subfolders を最新ファイルシステム状態に揃える（ロール設定は保持）。
// 戻り値: 変更があったかどうか。
async function reconcileSubfolders(company: Company, patterns: string[]): Promise<boolean> {
  const newSubs = await detectSubfolders(company.id, patterns);
  let changed = false;
  for (const ns of newSubs) {
    if (!company.subfolders.find(s => s.id === ns.id)) {
      company.subfolders.push(ns);
      changed = true;
    }
  }
  const { existsSync } = await import("fs");
  const before = company.subfolders.length;
  company.subfolders = company.subfolders.filter(s => existsSync(s.id));
  if (company.subfolders.length !== before) changed = true;
  company.scannedSig = await computeScannedSig(company.id, company.subfolders);
  return changed;
}

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

// ベースパス設定 + 会社自動検出（複数パス対応）
export async function POST(request: NextRequest) {
  const { basePaths } = await request.json() as { basePaths: string[] };
  if (!basePaths || basePaths.length === 0) {
    return NextResponse.json({ error: "basePaths は必須です" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  config.basePaths = basePaths;
  delete config.basePath; // 旧フィールド削除

  const patterns = config.defaultCommonPatterns || [];

  // basePaths配下にある会社だけ残す
  const validCompanyIds = new Set<string>();

  for (const bp of basePaths) {
    const entries = await listFiles(bp);
    const dirs = entries.filter(e => e.isDirectory);

    for (const dir of dirs) {
      validCompanyIds.add(dir.path);
      const existing = config.companies.find(c => c.id === dir.path);
      if (existing) continue;

      const subfolders = await detectSubfolders(dir.path, patterns);
      const scannedSig = await computeScannedSig(dir.path, subfolders);
      config.companies.push({
        id: dir.path,
        name: dir.name,
        subfolders,
        scannedSig,
      });
    }
  }

  // 選択されたパス配下にない会社を削除
  config.companies = config.companies.filter(c => validCompanyIds.has(c.id));
  if (config.selectedCompanyId && !validCompanyIds.has(config.selectedCompanyId)) {
    config.selectedCompanyId = null;
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
      // ID 切替のみ。ファイルシステムスキャンはしない。
      // 「最新状態に揃える」は、別 action `rescanSelectedIfChanged` を
      // クライアントが裏で叩く形に分離した。これにより会社切替自体は
      // 数 ms で返り、サイドバー表示が引っかからない。
      config.selectedCompanyId = body.companyId;
      break;
    }

    case "rescanSelectedIfChanged": {
      // 選択中の会社の subfolders を mtime ベースで差分検知し、変わってたら
      // detectSubfolders で最新化する。会社フォルダ + 中間フォルダの mtime
      // sig が前回と同じなら readdir 一切なし（fs.stat 数回だけで即返る）。
      // クライアントは会社切替後 / ウィンドウフォーカス復帰時に裏で叩く。
      const company = config.companies.find(c => c.id === config.selectedCompanyId);
      if (company) {
        const currentSig = await computeScannedSig(company.id, company.subfolders);
        if (currentSig !== company.scannedSig) {
          const patterns = config.defaultCommonPatterns || [];
          await reconcileSubfolders(company, patterns);
        }
      }
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
          // 案件に変更する場合、他の案件フォルダを除外に
          if (body.role === "job") {
            for (const s of company.subfolders) {
              if (s.role === "job" && s.id !== body.subfolderId) {
                s.role = "none";
                s.active = false;
              }
            }
            sub.role = "job";
            sub.active = true;
          } else {
            sub.role = body.role;
            if (body.role === "common") sub.active = true;
          }
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
      // テンプレートフォルダ内の.doc/.docmをWordで.docxに変換
      if (config.templateBasePath) {
        try {
          const { execSync } = require("child_process");
          const fsSync = require("fs");
          const nodePath = require("path");
          const os = require("os");

          function convertDocsInDir(dir: string) {
            const items = fsSync.readdirSync(dir);
            for (const item of items) {
              const fullPath = nodePath.join(dir, item);
              if (fsSync.statSync(fullPath).isDirectory()) {
                convertDocsInDir(fullPath);
              } else if (item.endsWith(".doc") || item.endsWith(".docm")) {
                const docxPath = fullPath.replace(/\.(doc|docm)$/i, ".docx");
                if (fsSync.existsSync(docxPath)) continue; // 既にdocxがあればスキップ
                try {
                  const tmpDir = nodePath.join(os.tmpdir(), "recast-doc-convert");
                  fsSync.mkdirSync(tmpDir, { recursive: true });
                  const psScript = nodePath.join(tmpDir, `convert_${Date.now()}.ps1`);
                  fsSync.writeFileSync(psScript, [
                    "$word = New-Object -ComObject Word.Application",
                    "$word.Visible = $false",
                    `$doc = $word.Documents.Open("${fullPath.replace(/\\/g, "\\\\")}")`,
                    `$doc.SaveAs2("${docxPath.replace(/\\/g, "\\\\")}", 16)`,
                    "$doc.Close()",
                    "$word.Quit()",
                  ].join("\n"), "utf-8");
                  execSync(`powershell -ExecutionPolicy Bypass -File "${psScript}"`, { timeout: 30000 });
                  try { fsSync.unlinkSync(psScript); } catch { /* ignore */ }
                } catch { /* 変換失敗はスキップ */ }
              }
            }
          }
          convertDocsInDir(config.templateBasePath);
        } catch { /* ignore */ }
      }
      break;
    }

    case "setRecordsBasePath": {
      // 作業記録の自動保存先フォルダを設定
      // クラウドストレージ (Google Drive 等) のフォルダを指定すれば、自動同期で他 PC・他人と即共有可能
      config.recordsBasePath = body.recordsBasePath || "";
      break;
    }

    case "setDefaultCommonPatterns": {
      config.defaultCommonPatterns = body.patterns;
      break;
    }

    case "applyDefaultCommon": {
      // 共通パターンにマッチしたフォルダを common に設定する。
      // 重要: マッチしないからといって job にリセットはしない (ユーザーの手動設定を破壊しない)。
      // これは追加的 (additive) な操作で、「パターンを使って common 候補をまとめて適用する」用途。
      //
      // 旧実装は「マッチしないものを問答無用で job にリセット」していたため、
      // パターンを空にして実行すると全会社の common 設定が消える事故を起こしていた。
      const patterns = config.defaultCommonPatterns || [];
      for (const company of config.companies) {
        for (const sub of company.subfolders) {
          if (sub.role === "none") continue; // 除外は触らない
          if (matchesCommonPattern(sub.name, patterns)) {
            sub.role = "common";
            sub.active = true;
          }
          // マッチしない場合は何もしない (既存の role を保持)
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

    case "setProfileSources": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        company.profileSources = Array.isArray(body.paths) ? body.paths : undefined;
      }
      break;
    }

    case "deleteProfile": {
      const company = config.companies.find(c => c.id === body.companyId);
      if (company) {
        company.profile = undefined;
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
          if ("masterSheet" in body) { if (body.masterSheet) room.masterSheet = body.masterSheet; else delete room.masterSheet; }
          if ("generatedDocuments" in body) room.generatedDocuments = body.generatedDocuments;
          if ("checkResult" in body) { if (body.checkResult) room.checkResult = body.checkResult; else delete room.checkResult; }
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
    basePaths: [],
    templateBasePath: "",
    recordsBasePath: "",
    defaultCommonPatterns: [],
    companies: [],
    selectedCompanyId: null,
  };
  await saveWorkspaceConfig(config);
  return NextResponse.json(config);
}
