/**
 * チャットスレッド (data/chat-threads/<md5(companyId)>/<threadId>.json) を
 * サーバー側から読む小さなヘルパー。
 *
 * 設計意図: 案件整理（masterSheet）・生成書類・folderPath 等は「そのスレッドの案件」に
 * 紐付く情報。company レベルの caseRooms/masterSheet を横断的に拾うと別案件の情報が
 * 混ざるバグが出るため、API ルートは必ず threadId 起点でスレッドを読むこと。
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { ChatThread } from "@/types";

function threadPath(companyId: string, threadId: string): string {
  const hash = crypto.createHash("md5").update(companyId).digest("hex");
  return path.join(process.cwd(), "data", "chat-threads", hash, `${threadId}.json`);
}

export async function loadThread(
  companyId: string,
  threadId: string
): Promise<ChatThread | null> {
  try {
    const raw = await fs.readFile(threadPath(companyId, threadId), "utf-8");
    return JSON.parse(raw) as ChatThread;
  } catch {
    return null;
  }
}
