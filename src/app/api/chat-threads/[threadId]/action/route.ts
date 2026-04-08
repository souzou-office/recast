import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import type { ChatThread, ThreadMessage } from "@/types";
import { onFolderSelected, onFilesConfirmed } from "@/lib/workflow-engine";
import { getWorkspaceConfig } from "@/lib/folders";

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

// カード操作→次ステップ
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const { threadId } = await params;
  const body = await request.json();
  const { companyId, action, messageId, cardIndex, data } = body;

  if (!companyId) {
    return NextResponse.json({ error: "companyId は必須です" }, { status: 400 });
  }

  const thread = await loadThread(companyId, threadId);
  if (!thread) {
    return NextResponse.json({ error: "スレッドが見つかりません" }, { status: 404 });
  }

  const config = await getWorkspaceConfig();

  // カードを更新
  if (messageId && cardIndex !== undefined) {
    const msg = thread.messages.find(m => m.id === messageId);
    if (msg?.cards?.[cardIndex]) {
      msg.cards[cardIndex] = { ...msg.cards[cardIndex], ...data };
    }
  }

  let nextMessage: ThreadMessage | null = null;

  switch (action) {
    case "folder-selected": {
      const folderPath = data.selectedPath;
      thread.folderPath = folderPath;
      nextMessage = await onFolderSelected(folderPath);
      break;
    }

    case "files-confirmed": {
      const disabledFiles = (data.files || [])
        .filter((f: { enabled: boolean }) => !f.enabled)
        .map((f: { path: string }) => f.path);
      thread.disabledFiles = disabledFiles;
      nextMessage = await onFilesConfirmed(config.templateBasePath || "");
      break;
    }

    case "template-selected": {
      // テンプレート選択後→案件整理+書類生成をストリーミングで実行
      // ここではメッセージだけ返して、実際の処理はクライアント側でSSE呼び出し
      nextMessage = {
        id: `msg_${Date.now()}`,
        role: "assistant",
        content: "案件を整理して書類を生成しています...",
        timestamp: new Date().toISOString(),
      };
      break;
    }

    case "check-accepted": {
      nextMessage = {
        id: `msg_${Date.now()}`,
        role: "assistant",
        content: "チェックを実行しています...",
        timestamp: new Date().toISOString(),
      };
      break;
    }
  }

  if (nextMessage) {
    thread.messages.push(nextMessage);
  }

  thread.updatedAt = new Date().toISOString();
  await saveThread(thread);

  return NextResponse.json({ thread, nextMessage });
}
