// インボックスの下書き永続化 — 「消えない器」の最小実装（設計書 §3-1）。
//
//   GET    /api/jirei/inbox … { draft } （無ければ draft: null）
//   PUT    /api/jirei/inbox … { draft } を丸ごと保存
//   DELETE /api/jirei/inbox … 下書きを破棄
//
// 実務では資料が数日かけて届くため、放り込んだ資料・貼り付けメモ・推定結果・回答は
// リロードやタブ切替で消えてはならない。v1 は「進行中の案件は常に1件」の割り切りで
// 単一の下書きファイルに保存する（案件の複数管理は案件レコード設計で別途）。
// 内容はローカルの data/ 配下のみ。Web 展開時はクライアント側ストレージに差し替える層。

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const DRAFT_DIR = path.join(process.cwd(), "data", "jirei-inbox");
const DRAFT_PATH = path.join(DRAFT_DIR, "draft.json");

export async function GET() {
  try {
    const raw = await fs.readFile(DRAFT_PATH, "utf-8");
    return NextResponse.json({ draft: JSON.parse(raw) });
  } catch {
    return NextResponse.json({ draft: null });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body || typeof body.draft !== "object" || body.draft === null) {
      return NextResponse.json({ error: "draft は必須です" }, { status: 400 });
    }
    await fs.mkdir(DRAFT_DIR, { recursive: true });
    // 書き込み途中のクラッシュで下書きを壊さない（tmp → rename）
    const tmp = `${DRAFT_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ ...body.draft, updatedAt: new Date().toISOString() }), "utf-8");
    await fs.rename(tmp, DRAFT_PATH);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "保存に失敗しました" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    await fs.rm(DRAFT_PATH, { force: true });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "破棄に失敗しました" },
      { status: 500 }
    );
  }
}
