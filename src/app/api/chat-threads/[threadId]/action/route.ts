import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import type { ChatThread, ThreadMessage } from "@/types";
import { onFolderSelected, onFilesConfirmed } from "@/lib/workflow-engine";
import { getWorkspaceConfig } from "@/lib/folders";

const client = new Anthropic();

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
      if (!folderPath) {
        // 選び直し: フォルダ選択カード以降のメッセージを削除
        const folderMsgIdx = thread.messages.findIndex(m => m.id === messageId);
        if (folderMsgIdx >= 0) {
          thread.messages = thread.messages.slice(0, folderMsgIdx + 1);
        }
        thread.folderPath = undefined;
        thread.disabledFiles = undefined;
        break;
      }
      thread.folderPath = folderPath;

      // フォルダ名からチャットタイトルを自動生成
      const folderName = folderPath.split(/[\\/]/).pop() || "";
      const company = config.companies.find(c => c.id === thread.companyId);
      try {
        const res = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 50,
          messages: [{ role: "user", content: `会社「${company?.name || ""}」の案件フォルダ「${folderName}」から、チャットタイトルを1行で生成。日付(YYYY/MM)+内容の形式で簡潔に。名前のみ返してください。` }],
        });
        const title = res.content[0].type === "text" ? res.content[0].text.trim() : "";
        if (title) thread.displayName = title;
      } catch { /* ignore */ }

      nextMessage = await onFolderSelected(folderPath);
      break;
    }

    case "files-confirmed": {
      const disabledFiles = (data.files || [])
        .filter((f: { enabled: boolean }) => !f.enabled)
        .map((f: { path: string }) => f.path);
      thread.disabledFiles = disabledFiles;
      // フォルダ名からテンプレートを推奨
      const folderName = thread.folderPath?.split(/[\\/]/).pop() || "";
      nextMessage = await onFilesConfirmed(config.templateBasePath || "", folderName);
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
