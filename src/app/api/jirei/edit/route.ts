// 木の編集 API（コンソール v2 の裏側）。
//
//   GET /api/jirei/edit?id=<jireiId>  … 木の生 JSON（編集用）
//   PUT /api/jirei/edit               … { id, jirei } を検証して保存
//
// 保存前に検証する（loader は無検証なので、壊れた木は「分岐が無言で死ぬ」形で現れる。
// 編集 UI 経由の保存はここで堰き止める）:
//   - when が参照する questionId が実在するか
//   - when の anyOf が参照先 choice 質問の選択肢に含まれるか
//   - slots の answer が参照する questionId が実在するか
// 旧版は data/jirei/history/<id>/ にバックアップしてから上書きする（戻せる）。

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { loadJirei } from "@/lib/jirei/loader";
import { validateJirei } from "@/lib/jirei/validate";
import type { Jirei } from "@/types/jirei";

const JIREI_DIR = path.join(process.cwd(), "data", "jirei");

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id は必須です" }, { status: 400 });
  const jirei = await loadJirei(id);
  if (!jirei) return NextResponse.json({ error: "事由が見つかりません" }, { status: 404 });
  return NextResponse.json({ jirei });
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const id: string | undefined = body.id;
    const jirei: Jirei | undefined = body.jirei;
    if (!id || !jirei) return NextResponse.json({ error: "id と jirei は必須です" }, { status: 400 });
    if (jirei.id !== id) return NextResponse.json({ error: "id が一致しません" }, { status: 400 });
    if (!/^[a-z0-9-]+$/.test(id)) return NextResponse.json({ error: "不正な id です" }, { status: 400 });

    const { errors, warnings } = validateJirei(jirei);
    if (errors.length > 0) return NextResponse.json({ error: "検証エラー", errors, warnings }, { status: 422 });

    // 旧版をバックアップしてから上書き（編集ミスから戻せるように）
    const target = path.join(JIREI_DIR, `${id}.json`);
    try {
      const old = await fs.readFile(target, "utf-8");
      const histDir = path.join(JIREI_DIR, "history", id);
      await fs.mkdir(histDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.writeFile(path.join(histDir, `${stamp}.json`), old, "utf-8");
    } catch {
      /* 新規（バックアップ対象なし） */
    }
    await fs.writeFile(target, JSON.stringify(jirei, null, 2), "utf-8");
    return NextResponse.json({ ok: true, warnings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "保存に失敗しました" }, { status: 500 });
  }
}
