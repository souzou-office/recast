import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { ChatThread } from "@/types";
import { getWorkspaceConfig } from "@/lib/folders";
import { createInitialMessage } from "@/lib/workflow-engine";

// スレッドの初期カード（フォルダ選択）を生成して追加する。
// POST /api/chat-threads/[threadId]/initial
//   body: { companyId }
//
// POST /api/chat-threads の軽量化のため、重たい listFiles を含む初期カード生成を
// ここに分離。既にメッセージがあるスレッドでは何もしない。
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const { threadId } = await params;
  const body = await request.json() as { companyId?: string };
  if (!body.companyId) {
    return NextResponse.json({ error: "companyId が必須" }, { status: 400 });
  }

  const companyHash = crypto.createHash("md5").update(body.companyId).digest("hex");
  const filePath = path.join(process.cwd(), "data", "chat-threads", companyHash, `${threadId}.json`);

  let thread: ChatThread;
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    thread = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "スレッドが見つかりません" }, { status: 404 });
  }

  // 既にメッセージがある場合はスキップ（冪等性）
  if (thread.messages && thread.messages.length > 0) {
    return NextResponse.json({ thread });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === body.companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  const initialMsg = await createInitialMessage(body.companyId, company.subfolders);
  thread.messages = [initialMsg];
  thread.updatedAt = new Date().toISOString();

  await fs.writeFile(filePath, JSON.stringify(thread, null, 2), "utf-8");
  return NextResponse.json({ thread });
}
