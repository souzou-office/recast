/**
 * 1案件=1会話: Claude との連続会話を「スレッド」と紐付けて管理する。
 *
 * なぜこうするか:
 *  - 旧設計では execute / clarify / produce / verify が **毎回ステートレス** に Claude を呼んでいた。
 *    各 API は前段の「結論（表・JSON）」しか引き継げず、「なぜその結論にしたか（判断・迷い）」が消えていた。
 *  - その結果、別ステップが同じ問題を独立に判断し直し、微妙にブレが出ていた（代表取締役の取り違え等）。
 *  - 本ヘルパーは aiMessages を 1 つ持ち回るだけで「同じ Claude が最後まで担当する」状態を作る。
 *
 * 使い方:
 *   const messages = await loadAiMessages(companyId, threadId);
 *   const trimmed  = truncateBeforeStage(messages, "produce"); // 再実行時に当該ステージから先を切る
 *   const next     = appendUserTurn(trimmed, [...blocks], "produce");
 *   // Claude API を呼ぶときは toAnthropicMessages(next) を使う
 *   // 応答が来たら appendAssistantTurn(next, finalText, "produce") して saveAiMessages
 */

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { CaseAiMessage, CaseAiContentBlock, ChatThread } from "@/types";

function threadPath(companyId: string, threadId: string): string {
  const hash = crypto.createHash("md5").update(companyId).digest("hex");
  return path.join(process.cwd(), "data", "chat-threads", hash, `${threadId}.json`);
}

/** スレッドファイルから aiMessages だけ読む（無ければ空配列） */
export async function loadAiMessages(
  companyId: string,
  threadId: string
): Promise<CaseAiMessage[]> {
  try {
    const raw = await fs.readFile(threadPath(companyId, threadId), "utf-8");
    const thread = JSON.parse(raw) as ChatThread;
    return thread.aiMessages || [];
  } catch {
    return [];
  }
}

/** スレッドファイルの aiMessages を上書き保存（他フィールドは保持） */
export async function saveAiMessages(
  companyId: string,
  threadId: string,
  aiMessages: CaseAiMessage[]
): Promise<void> {
  const file = threadPath(companyId, threadId);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const thread = JSON.parse(raw) as ChatThread;
    thread.aiMessages = aiMessages;
    thread.updatedAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(thread, null, 2), "utf-8");
  } catch (e) {
    console.error("[case-conversation] saveAiMessages failed:", e);
  }
}

/**
 * 指定ステージを再実行するときに、それ以降の履歴を捨てる。
 *
 * 例: organize を再実行 → aiMessages を [] に戻す
 *     produce を再実行  → 直前の clarify の assistant 応答までを残し、produce の user/assistant ターンを削除
 *
 * 「stage に該当するターン」だけでなく「それ以降にあるターン全部」を切る。
 * これは再実行が論理的に「やり直し」だから、後続結果を保持しない方が自然。
 */
export function truncateBeforeStage(
  messages: CaseAiMessage[],
  stage: NonNullable<CaseAiMessage["stage"]>
): CaseAiMessage[] {
  const idx = messages.findIndex(m => m.stage === stage);
  if (idx === -1) return messages;
  return messages.slice(0, idx);
}

/** 末尾にユーザーターンを追加 */
export function appendUserTurn(
  messages: CaseAiMessage[],
  content: string | CaseAiContentBlock[],
  stage?: CaseAiMessage["stage"]
): CaseAiMessage[] {
  return [...messages, { role: "user", content, stage }];
}

/** 末尾にアシスタント応答を追加 */
export function appendAssistantTurn(
  messages: CaseAiMessage[],
  text: string,
  stage?: CaseAiMessage["stage"]
): CaseAiMessage[] {
  return [...messages, { role: "assistant", content: text, stage }];
}

/**
 * Anthropic API の messages 形式に変換。
 *
 * - 末尾の user ターンの最後のテキストブロックに cache_control: ephemeral を付ける
 *   → 次回ターンで「ここまで」がキャッシュ参照され、過去の長文添付が安く再利用できる
 * - 過去ターンの cache_control は保持（古いキャッシュポイントは自動的に古くなって失効する）
 */
type AnthropicMsg = { role: "user" | "assistant"; content: CaseAiContentBlock[] };

export function toAnthropicMessages(messages: CaseAiMessage[]): AnthropicMsg[] {
  const result: AnthropicMsg[] = messages.map(m => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? [{ type: "text", text: m.content } as CaseAiContentBlock]
        : m.content,
  }));

  // 最後のメッセージの最後のテキストブロックに cache_control を付与
  if (result.length > 0) {
    const last = result[result.length - 1];
    for (let i = last.content.length - 1; i >= 0; i--) {
      const blk = last.content[i];
      if (blk.type === "text") {
        // 既に付いていれば触らない
        if (!blk.cache_control) {
          (last.content[i] as { type: "text"; text: string; cache_control?: { type: "ephemeral" } }).cache_control = { type: "ephemeral" };
        }
        break;
      }
    }
  }
  return result;
}

/**
 * 履歴に「すでにそのステージのターンが含まれているか」を返す。
 * organize の前提資料を毎回送ると無駄なので、このフラグで条件分岐する。
 */
export function hasStage(
  messages: CaseAiMessage[],
  stage: NonNullable<CaseAiMessage["stage"]>
): boolean {
  return messages.some(m => m.stage === stage);
}
