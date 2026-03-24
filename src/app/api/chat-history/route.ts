import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import type { ChatMessage } from "@/types";

const DATA_DIR = path.join(process.cwd(), "data", "chat-history");

function getFilePath(companyId: string): string {
  return path.join(DATA_DIR, `${companyId}.json`);
}

// 履歴取得
export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ messages: [] });
  }

  try {
    const raw = await fs.readFile(getFilePath(companyId), "utf-8");
    const messages: ChatMessage[] = JSON.parse(raw);
    return NextResponse.json({ messages });
  } catch {
    return NextResponse.json({ messages: [] });
  }
}

// 履歴保存
export async function POST(request: NextRequest) {
  const { companyId, messages } = await request.json() as {
    companyId: string;
    messages: ChatMessage[];
  };

  if (!companyId) {
    return NextResponse.json({ error: "companyId は必須です" }, { status: 400 });
  }

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(getFilePath(companyId), JSON.stringify(messages, null, 2), "utf-8");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "保存に失敗しました" },
      { status: 500 }
    );
  }
}

// 履歴削除
export async function DELETE(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId は必須です" }, { status: 400 });
  }

  try {
    await fs.unlink(getFilePath(companyId));
  } catch { /* ファイルがなくてもOK */ }

  return NextResponse.json({ ok: true });
}
