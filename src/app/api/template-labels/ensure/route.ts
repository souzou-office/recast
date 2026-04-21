import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { ensureDocxLabels, ensureXlsxLabels } from "@/lib/template-labels";

function isTemplateFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return [".docx", ".docm", ".xlsx", ".xlsm", ".xls"].includes(ext);
}

function labelsPathFor(templatePath: string): string {
  return templatePath + ".labels.json";
}

async function hasLabels(templatePath: string): Promise<boolean> {
  try {
    await fs.access(labelsPathFor(templatePath));
    return true;
  } catch {
    return false;
  }
}

// POST /api/template-labels/ensure
//   body: { folderPath }
// フォルダ内の全テンプレについて、未生成のラベルを AI で生成する。
// 既に生成済みのファイルはスキップ（確認フロー用 = なぜ毎回解析するのは無駄）。
// レスポンスでファイルごとの newlyGenerated フラグとスロット数を返す。
export async function POST(request: NextRequest) {
  const body = await request.json() as { folderPath?: string };
  if (!body.folderPath) {
    return NextResponse.json({ error: "folderPath が必須" }, { status: 400 });
  }

  try {
    const entries = await fs.readdir(body.folderPath, { withFileTypes: true });
    const targets = entries.filter(e => !e.isDirectory() && isTemplateFile(e.name));

    const files = await Promise.all(
      targets.map(async (e) => {
        const filePath = path.join(body.folderPath!, e.name);
        const existed = await hasLabels(filePath);
        let slotCount = 0;
        let wasNew = false;
        let error: string | undefined;
        try {
          const ext = path.extname(e.name).toLowerCase();
          let labels = null;
          if (ext === ".docx" || ext === ".docm") {
            labels = await ensureDocxLabels(filePath);
          } else if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") {
            labels = await ensureXlsxLabels(filePath);
          }
          slotCount = labels?.slots.length || 0;
          wasNew = !existed && !!labels;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        return { name: e.name, path: filePath, slotCount, wasNew, error };
      })
    );

    const newlyGenerated = files.filter(f => f.wasNew).length;
    return NextResponse.json({
      folderPath: body.folderPath,
      totalFiles: files.length,
      newlyGenerated,
      files,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "フォルダ読み取り失敗" }, { status: 500 });
  }
}
