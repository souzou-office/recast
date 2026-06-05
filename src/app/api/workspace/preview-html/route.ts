// OfficeCLI screenshot を使って docx / xlsx を PNG レンダリング → HTML (data URL 埋め込み) を返す。
//
// 設計:
//   - docx は常に `--render html` (Chromium・Word 非依存)。
//     ★native (Word) は使わない理由★: ① 大量プレビューで Word プロセスが枯渇し 0xC0000142 で
//     プレビューが全滅する ② コメントがあると右側に灰色のマークアップ枠が出て見栄えが悪い。
//     verify の指摘はチェックリストに全部出るので、プレビュー内にコメントを出す必要はない。
//   - xlsx はデフォルト (Excel ライクな見た目)
//   - その他の拡張子はエラー
//
// パフォーマンス対策 (Word プロセス起動 ~5s / 回 がボトルネック):
//   - サーバ側 PNG キャッシュ (sha1(content) or sha1(path+mtime))
//   - Mutex で全 officecli 呼び出しをシリアル化 (Word は singleton)
//   - 同じキーへの同時リクエストは in-flight Promise を共有 (dedup)
//
// クライアント側にも軽量キャッシュあり (src/lib/preview-cache.ts)。

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import nodePath from "path";
import os from "os";
import crypto from "crypto";
import { runOfficeCli } from "@/lib/officecli";

// ---- 設定 ----
const DOCX_EXTS = [".docx", ".docm"];
const XLSX_EXTS = [".xls", ".xlsx", ".xlsm"];
const MAX_CACHE = 50;
const RENDER_TIMEOUT_MS = 60_000;
const SCREENSHOT_WIDTH = "1600";
const DOCX_MAX_PAGES = "1-30";  // 存在しないページは officecli が無視する (stats 呼び出し不要)
// レンダリング設定のバージョン。render args 変更時にここを bump するとキャッシュ無効化される。
const RENDER_VERSION = "v7-docx-html-always";

// ---- サーバ側 PNG キャッシュ (process 内のみ、再起動で消える) ----
const htmlCache = new Map<string, string>();
function cacheGet(key: string): string | undefined {
  return htmlCache.get(key);
}
function cacheSet(key: string, html: string): void {
  if (htmlCache.size >= MAX_CACHE) {
    const oldest = htmlCache.keys().next().value;
    if (oldest) htmlCache.delete(oldest);
  }
  htmlCache.set(key, html);
}

// ---- 同時リクエスト対策 ----
// 同じキーで既に処理中なら、そっちの結果を待って返す (dedup)
// Word は同時複数起動できることが確認済みなので Mutex は使わない
// (クライアント側の pre-warm は sequential なので、最大でも「ユーザークリック + pre-warm」の 2 並列)
const inflight = new Map<string, Promise<string>>();

// ---- 入出力型 ----
type RequestBody = { path?: string; docxBase64?: string; fileName?: string };
type ResponseBody = { html: string } | { error: string };

export async function POST(request: NextRequest): Promise<NextResponse<ResponseBody>> {
  let body: RequestBody;
  try {
    body = await request.json();
  } catch (e) {
    return NextResponse.json({ error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  }
  const { path: filePath, docxBase64, fileName } = body;

  // --- 引数検証 + キャッシュキー算出 ---
  let cacheKey: string;
  let ext: string;
  if (docxBase64 && fileName) {
    cacheKey = "b:" + crypto.createHash("sha1").update(RENDER_VERSION + ":" + docxBase64).digest("hex");
    ext = nodePath.extname(fileName).toLowerCase();
  } else if (filePath) {
    try {
      const stat = await fs.stat(filePath);
      cacheKey = "f:" + crypto.createHash("sha1").update(`${RENDER_VERSION}:${filePath}:${stat.mtimeMs}`).digest("hex");
    } catch {
      return NextResponse.json({ error: `ファイルが見つかりません: ${filePath}` });
    }
    ext = nodePath.extname(filePath).toLowerCase();
  } else {
    return NextResponse.json({ error: "filePath または docxBase64+fileName が必要です" });
  }

  const isDocx = DOCX_EXTS.includes(ext);
  const isXlsx = XLSX_EXTS.includes(ext);
  if (!isDocx && !isXlsx) {
    return NextResponse.json({ error: `非対応: ${ext} (docx / xlsx のみ)` });
  }

  // --- キャッシュヒット ---
  const cached = cacheGet(cacheKey);
  if (cached) return NextResponse.json({ html: cached });

  // --- 同一キーで処理中なら共有 ---
  const existing = inflight.get(cacheKey);
  if (existing) {
    try {
      const html = await existing;
      return NextResponse.json({ html });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "プレビュー生成に失敗" });
    }
  }

  // --- 新規 render (並列実行可) ---
  const renderPromise = renderToHtml({ filePath, docxBase64, fileName, isDocx });
  inflight.set(cacheKey, renderPromise);
  try {
    const html = await renderPromise;
    cacheSet(cacheKey, html);
    return NextResponse.json({ html });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "プレビュー生成に失敗" });
  } finally {
    inflight.delete(cacheKey);
  }
}

// docx / xlsx を PNG 化して HTML 文字列に埋め込んで返す。
async function renderToHtml(args: {
  filePath?: string;
  docxBase64?: string;
  fileName?: string;
  isDocx: boolean;
}): Promise<string> {
  const { filePath, docxBase64, fileName, isDocx } = args;

  // 入力 docx/xlsx の path を決定 (base64 なら temp に書き出し)
  let inputPath: string;
  let cleanupInput = false;
  if (docxBase64 && fileName) {
    const tmpDir = nodePath.join(os.tmpdir(), "recast-preview-input");
    await fs.mkdir(tmpDir, { recursive: true });
    const safeName = fileName.replace(/[\\/:*?"<>|]/g, "_");
    const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    inputPath = nodePath.join(tmpDir, `${uniq}_${safeName}`);
    await fs.writeFile(inputPath, Buffer.from(docxBase64, "base64"));
    cleanupInput = true;
  } else if (filePath) {
    inputPath = filePath;
  } else {
    throw new Error("内部エラー: 入力パスを決定できない");
  }

  // xlsx: ふりがな (ルビ rPh) を除去した temp コピーを作ってからスクショする。
  // 株主リスト等のヘッダーに「住所ジュウショ」のようにルビが出て見づらいため。
  // 原本は絶対に変更しない (filePath 直指定でも必ず temp コピー上で除去)。
  if (!isDocx) {
    try {
      const tmpDir = nodePath.join(os.tmpdir(), "recast-preview-input");
      await fs.mkdir(tmpDir, { recursive: true });
      const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const strippedPath = nodePath.join(tmpDir, `${uniq}_noruby.xlsx`);
      const PizZip = (await import("pizzip")).default;
      const zip = new PizZip(await fs.readFile(inputPath));
      const ss = zip.file("xl/sharedStrings.xml")?.asText();
      if (ss && /<rPh\b/.test(ss)) {
        const stripped = ss
          .replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "")   // ルビ run を除去
          .replace(/<phoneticPr\b[^>]*\/>/g, "");         // phonetic 表示設定も除去
        zip.file("xl/sharedStrings.xml", stripped);
        await fs.writeFile(strippedPath, zip.generate({ type: "nodebuffer" }));
        // 元が base64-temp ならそれは finally で消えるので、新 temp に差し替え + cleanup 対象に
        if (cleanupInput) { try { await fs.unlink(inputPath); } catch { /* ignore */ } }
        inputPath = strippedPath;
        cleanupInput = true;
      }
    } catch (e) {
      console.warn("[preview-html] ルビ除去スキップ:", e instanceof Error ? e.message : e);
      // 失敗しても元ファイルでスクショ続行
    }
  }

  // docx は常に html (Chromium) で描画する。native (Word) は使わない。
  //   ① native は描画のたびに Word を起動し、大量プレビューで Word プロセスが枯渇 → 0xC0000142 で
  //      プレビューが全滅 → サーバー再起動が必要、という事故が頻発した。
  //   ② native はコメントがあると右側に灰色のマークアップ枠が出て見栄えが悪い。
  // verify の指摘はチェックリストに出るので、プレビュー内にコメントを表示する必要はない。
  const docxRender = "html" as const;

  // 出力 PNG path
  const pngDir = nodePath.join(os.tmpdir(), "recast-preview-png");
  await fs.mkdir(pngDir, { recursive: true });
  const pngUniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const pngPath = nodePath.join(pngDir, `${pngUniq}.png`);

  try {
    // officecli view <file> screenshot
    // xlsx は viewport (--screenshot-width) も縮めないと右側に大きな空白が出る。
    //   A〜F (6 列) に絞った上で --screenshot-width 800 にすると A4 縦長寄りの見た目になる。
    //   1600 のままだと content 750px + 空白 850px で結局横長。
    // 注: --cols A,B,C,D,E,F,G,H,I,J,K,L だと空列 G-L も render に含まれて結局横長になる
    //     (officecli は空列を skip しない)。なので使用列だけを最初から指定する。
    // docx は 1600 のまま (A4 横向き的な見た目で多くの帳票が綺麗に出る)。
    //   --page 1-30 + --render native (Word 経由でコメント表示)。
    const cliArgs = [
      "view", inputPath, "screenshot",
      "-o", pngPath,
      "--screenshot-width", isDocx ? SCREENSHOT_WIDTH : "800",
      ...(isDocx ? ["--page", DOCX_MAX_PAGES, "--render", docxRender] : []),
      ...(!isDocx ? ["--cols", "A,B,C,D,E,F"] : []),
    ];
    const result = await runOfficeCli(cliArgs, { timeoutMs: RENDER_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(`officecli failed (exit ${result.exitCode}): ${result.stderr || result.stdout || "unknown"}`);
    }

    // PNG を base64 → data URL → HTML 埋め込み
    const pngBuf = await fs.readFile(pngPath);
    const dataUrl = `data:image/png;base64,${pngBuf.toString("base64")}`;
    const alt = (fileName || filePath || "").replace(/[<>"']/g, "_");
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>html,body{margin:0;padding:0;background:#f0f0f0;}img{max-width:100%;display:block;margin:0 auto;}</style>
</head><body><img src="${dataUrl}" alt="${alt}" /></body></html>`;
  } finally {
    // 一時ファイル掃除 (Word がまだ掴んでてエラーになる可能性は無視)
    if (cleanupInput) {
      try { await fs.unlink(inputPath); } catch { /* ignore */ }
    }
    try { await fs.unlink(pngPath); } catch { /* ignore */ }
  }
}
