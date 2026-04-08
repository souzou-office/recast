import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import type { ChatThread } from "@/types";

const DATA_DIR = path.join(process.cwd(), "data", "chat-threads");

function threadPath(companyId: string, threadId: string) {
  const dir = path.join(DATA_DIR, Buffer.from(companyId).toString("base64url"));
  return path.join(dir, `${threadId}.json`);
}

async function loadThread(companyId: string, threadId: string): Promise<ChatThread | null> {
  try {
    const raw = await fs.readFile(threadPath(companyId, threadId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveThread(thread: ChatThread): Promise<void> {
  const dir = path.join(DATA_DIR, Buffer.from(thread.companyId).toString("base64url"));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(threadPath(thread.companyId, thread.id), JSON.stringify(thread, null, 2), "utf-8");
}

// スレッド詳細取得
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const { threadId } = await params;
  const companyId = request.nextUrl.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId は必須です" }, { status: 400 });
  }

  const thread = await loadThread(companyId, threadId);
  if (!thread) {
    return NextResponse.json({ error: "スレッドが見つかりません" }, { status: 404 });
  }

  return NextResponse.json({ thread });
}

// スレッド更新（名前変更、メッセージ追加、ワークフロー成果物保存）
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const { threadId } = await params;
  const body = await request.json();
  const companyId = body.companyId;
  if (!companyId) {
    return NextResponse.json({ error: "companyId は必須です" }, { status: 400 });
  }

  const thread = await loadThread(companyId, threadId);
  if (!thread) {
    return NextResponse.json({ error: "スレッドが見つかりません" }, { status: 404 });
  }

  if (body.displayName !== undefined) thread.displayName = body.displayName;
  if (body.message) thread.messages.push(body.message);
  if (body.folderPath !== undefined) thread.folderPath = body.folderPath;
  if (body.disabledFiles !== undefined) thread.disabledFiles = body.disabledFiles;
  if ("masterSheet" in body) thread.masterSheet = body.masterSheet || undefined;
  if ("generatedDocuments" in body) thread.generatedDocuments = body.generatedDocuments;
  if ("checkResult" in body) thread.checkResult = body.checkResult || undefined;

  // カード更新（特定メッセージのカードを更新）
  if (body.updateCard) {
    const { messageId, cardIndex, cardData } = body.updateCard;
    const msg = thread.messages.find(m => m.id === messageId);
    if (msg && msg.cards && msg.cards[cardIndex]) {
      msg.cards[cardIndex] = { ...msg.cards[cardIndex], ...cardData };
    }
  }

  thread.updatedAt = new Date().toISOString();
  await saveThread(thread);

  return NextResponse.json({ thread });
}

// スレッド削除
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const { threadId } = await params;
  const companyId = request.nextUrl.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId は必須です" }, { status: 400 });
  }

  try {
    await fs.unlink(threadPath(companyId, threadId));
  } catch { /* ignore */ }

  return NextResponse.json({ ok: true });
}
