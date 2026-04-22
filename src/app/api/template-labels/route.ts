import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { ensureDocxLabels, ensureXlsxLabels, type TemplateLabels } from "@/lib/template-labels";
import { isCommonRuleFolderName } from "@/lib/global-rules";

function isTemplateFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return [".docx", ".docm", ".xlsx", ".xlsm", ".xls"].includes(ext);
}

function labelsPathFor(templatePath: string): string {
  return templatePath + ".labels.json";
}

async function loadLabelsFile(templatePath: string): Promise<TemplateLabels | null> {
  try {
    const raw = await fs.readFile(labelsPathFor(templatePath), "utf-8");
    return JSON.parse(raw) as TemplateLabels;
  } catch {
    return null;
  }
}

// GET /api/template-labels
//   (no query)              -> 全テンプレフォルダと各ファイルの解釈状態
//   ?templatePath=<path>    -> そのテンプレの詳細（slots一覧）
export async function GET(request: NextRequest) {
  const templatePath = request.nextUrl.searchParams.get("templatePath");
  const config = await getWorkspaceConfig();

  if (templatePath) {
    const labels = await loadLabelsFile(templatePath);
    if (!labels) {
      return NextResponse.json({ error: "解釈ラベルが存在しません（未解析）" }, { status: 404 });
    }
    return NextResponse.json(labels);
  }

  // 一覧: templateBasePath 配下のフォルダを列挙、各フォルダ内のテンプレファイルと解釈状態
  const basePath = config.templateBasePath;
  if (!basePath) {
    return NextResponse.json({ folders: [], error: "テンプレートベースパスが未設定です" });
  }

  try {
    const rawEntries = await fs.readdir(basePath, { withFileTypes: true });
    // 共通ルールフォルダ除外 + 番号順ソート
    const entries = rawEntries
      .filter(e => e.isDirectory() && !isCommonRuleFolderName(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
    const folders = await Promise.all(
      entries
        .map(async (e) => {
          const folderPath = path.join(basePath, e.name);
          let files: Array<{ name: string; path: string; hasLabels: boolean; slotCount: number; generatedAt: string | null }> = [];
          try {
            const children = await fs.readdir(folderPath, { withFileTypes: true });
            files = await Promise.all(
              children
                .filter(c => !c.isDirectory() && isTemplateFile(c.name))
                .map(async (c) => {
                  const filePath = path.join(folderPath, c.name);
                  const labels = await loadLabelsFile(filePath);
                  return {
                    name: c.name,
                    path: filePath,
                    hasLabels: !!labels,
                    slotCount: labels?.slots.length || 0,
                    generatedAt: labels?.generatedAt || null,
                  };
                })
            );
            // 番号順（"1.", "2-1.", "3." 等）でソート。{numeric:true} は "10" > "2" を正しく扱う。
            files.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
          } catch { /* ignore */ }
          return {
            name: e.name,
            path: folderPath,
            files,
          };
        })
    );
    return NextResponse.json({ folders });
  } catch (err) {
    return NextResponse.json({ folders: [], error: err instanceof Error ? err.message : "読み取り失敗" }, { status: 500 });
  }
}

// PATCH /api/template-labels
//   body: { templatePath, slotId, label, format, sourceHint }
// 指定スロットのラベルを手動修正して .labels.json を更新
export async function PATCH(request: NextRequest) {
  const body = await request.json() as {
    templatePath: string;
    slotId: number;
    label?: string;
    format?: string;
    sourceHint?: string;
  };
  if (!body.templatePath || typeof body.slotId !== "number") {
    return NextResponse.json({ error: "templatePath と slotId は必須" }, { status: 400 });
  }

  const labels = await loadLabelsFile(body.templatePath);
  if (!labels) {
    return NextResponse.json({ error: "解釈ラベルが存在しません" }, { status: 404 });
  }

  const slot = labels.slots.find(s => s.slotId === body.slotId);
  if (!slot) {
    return NextResponse.json({ error: `slotId ${body.slotId} が見つかりません` }, { status: 404 });
  }

  if (body.label !== undefined) slot.label = body.label;
  if (body.format !== undefined) slot.format = body.format;
  if (body.sourceHint !== undefined) slot.sourceHint = body.sourceHint;

  await fs.writeFile(labelsPathFor(body.templatePath), JSON.stringify(labels, null, 2), "utf-8");
  return NextResponse.json({ ok: true, slot });
}

// POST /api/template-labels
//   body: { templatePath, action: "regenerate" }            … 単一ファイルを再解析
//   body: { folderPath, action: "regenerate-folder" }       … フォルダ内の全テンプレを再解析
// キャッシュを破棄して AI で再解析する。
export async function POST(request: NextRequest) {
  const body = await request.json() as {
    templatePath?: string;
    folderPath?: string;
    action: string;
  };

  if (body.action === "regenerate") {
    if (!body.templatePath) {
      return NextResponse.json({ error: "templatePath が必須" }, { status: 400 });
    }
    // キャッシュを削除して ensure 関数を呼ぶと hash 不一致扱いで再生成される
    try {
      await fs.unlink(labelsPathFor(body.templatePath));
    } catch { /* 既に無くても問題なし */ }

    const ext = path.extname(body.templatePath).toLowerCase();
    let labels: TemplateLabels | null = null;
    if (ext === ".docx" || ext === ".docm") {
      labels = await ensureDocxLabels(body.templatePath);
    } else if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") {
      labels = await ensureXlsxLabels(body.templatePath);
    } else {
      return NextResponse.json({ error: "非対応の拡張子" }, { status: 400 });
    }

    if (!labels) {
      return NextResponse.json({ error: "再解析に失敗しました（マーカーが無い可能性）" }, { status: 500 });
    }
    return NextResponse.json(labels);
  }

  if (body.action === "regenerate-folder") {
    if (!body.folderPath) {
      return NextResponse.json({ error: "folderPath が必須" }, { status: 400 });
    }
    // フォルダ内の全テンプレファイルを並列で再解析
    try {
      const entries = await fs.readdir(body.folderPath, { withFileTypes: true });
      const targets = entries.filter(e => !e.isDirectory() && isTemplateFile(e.name));

      const results = await Promise.all(
        targets.map(async (e) => {
          const filePath = path.join(body.folderPath!, e.name);
          try {
            await fs.unlink(labelsPathFor(filePath));
          } catch { /* ignore */ }
          const ext = path.extname(e.name).toLowerCase();
          try {
            let labels: TemplateLabels | null = null;
            if (ext === ".docx" || ext === ".docm") {
              labels = await ensureDocxLabels(filePath);
            } else if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") {
              labels = await ensureXlsxLabels(filePath);
            }
            return { name: e.name, ok: !!labels, slotCount: labels?.slots.length || 0 };
          } catch (err) {
            return { name: e.name, ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        })
      );
      return NextResponse.json({ results, total: targets.length, succeeded: results.filter(r => r.ok).length });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "フォルダ読み取り失敗" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "未対応の action" }, { status: 400 });
}
