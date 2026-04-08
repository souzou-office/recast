import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import type { ChatThread } from "@/types";
import { getWorkspaceConfig } from "@/lib/folders";
import { createInitialMessage } from "@/lib/workflow-engine";

const DATA_DIR = path.join(process.cwd(), "data", "chat-threads");

async function ensureDir(companyId: string) {
  const dir = path.join(DATA_DIR, require("crypto").createHash("md5").update(companyId).digest("hex"));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function threadPath(companyId: string, threadId: string) {
  const dir = path.join(DATA_DIR, require("crypto").createHash("md5").update(companyId).digest("hex"));
  return path.join(dir, `${threadId}.json`);
}

// スレッド一覧（companyId指定、メッセージ本文除く）
export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId は必須です" }, { status: 400 });
  }

  const dir = await ensureDir(companyId);
  try {
    const files = await fs.readdir(dir);
    const threads: Omit<ChatThread, "messages">[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf-8");
        const thread: ChatThread = JSON.parse(raw);
        // メッセージは除く（一覧では不要）
        threads.push({
          id: thread.id,
          companyId: thread.companyId,
          displayName: thread.displayName,
          folderPath: thread.folderPath,
          disabledFiles: thread.disabledFiles,
          masterSheet: thread.masterSheet,
          generatedDocuments: thread.generatedDocuments,
          checkResult: thread.checkResult,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        });
      } catch { /* skip corrupt files */ }
    }

    // 新しい順
    threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return NextResponse.json({ threads });
  } catch {
    return NextResponse.json({ threads: [] });
  }
}

// 新規スレッド作成
export async function POST(request: NextRequest) {
  const { companyId, displayName } = await request.json();
  if (!companyId) {
    return NextResponse.json({ error: "companyId は必須です" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);

  // 初期メッセージ（フォルダ選択カード）を生成
  const initialMsg = company
    ? await createInitialMessage(companyId, company.subfolders)
    : null;

  const thread: ChatThread = {
    id: `thread_${Date.now()}`,
    companyId,
    displayName: displayName || "新規チャット",
    messages: initialMsg ? [initialMsg] : [],
    createdAt: now,
    updatedAt: now,
  };

  await ensureDir(companyId);
  await fs.writeFile(threadPath(companyId, thread.id), JSON.stringify(thread, null, 2), "utf-8");

  return NextResponse.json({ thread });
}
