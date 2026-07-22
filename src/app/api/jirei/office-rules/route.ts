// 事務所ルール（統一ルール）の管理 API。
//
//   GET /api/jirei/office-rules … { text }
//   PUT /api/jirei/office-rules … { text } → 保存
//
// 正はアプリ内（data/jirei/office-rules.txt）。事由コンパイラと AI チェックがここを読む。
// H: のテンプレフォルダ内 統一ルール.txt は初期取り込み元（以後はこちらが正）。

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const RULES_PATH = path.join(process.cwd(), "data", "jirei", "office-rules.txt");

export async function GET() {
  try {
    const text = await fs.readFile(RULES_PATH, "utf-8");
    return NextResponse.json({ text });
  } catch {
    return NextResponse.json({ text: "" });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const text: string = body.text ?? "";
    await fs.writeFile(RULES_PATH, text, "utf-8");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "保存に失敗しました" },
      { status: 500 }
    );
  }
}
