import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import type { ChatThread } from "@/types";
import { getWorkspaceConfig } from "@/lib/folders";
import { writeThreadRecords } from "@/lib/records-writer";

const DATA_DIR = path.join(process.cwd(), "data", "chat-threads");

function threadPath(companyId: string, threadId: string) {
  const dir = path.join(DATA_DIR, require("crypto").createHash("md5").update(companyId).digest("hex"));
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
  const dir = path.join(DATA_DIR, require("crypto").createHash("md5").update(thread.companyId).digest("hex"));
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
  // 複数メッセージを上書き保存（クライアント側で thread.messages 全体を再構成した場合に使う）
  // 旧: body.message (単数) しか handle してなかったため、proofread 後の docxBase64 更新等が
  // 永続化されない不具合があった。複数版もサポートして、call site の意図通りに保存できるように。
  if (Array.isArray(body.messages)) thread.messages = body.messages;
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

  // recordsBasePath が設定されていれば、自動で書き出す（best-effort、失敗しても 200 を返す）
  // Google Drive 等のクラウドストレージのフォルダを指定すれば自動同期で他 PC・他人と即共有できる
  try {
    const config = await getWorkspaceConfig();
    if (config.recordsBasePath) {
      const company = config.companies.find(c => c.id === companyId);
      if (company) {
        const r = await writeThreadRecords(thread, company, config.recordsBasePath);
        if (!r.ok) console.warn(`[chat-threads PATCH] records write failed: ${r.error}`);
      }
    }
  } catch (e) {
    console.warn("[chat-threads PATCH] records write threw:", e);
  }

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
