import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { getWorkspaceConfig } from "@/lib/folders";
import type { ChatThread, ClarificationQuestion } from "@/types";

/**
 * Phase 2 clarify (= 書面ルール上の確認質問) = 「1案件1会話」のターン4。
 *
 * Phase 2 (analyze) が thread.phase2Decisions に「unconfirmed」リストを書き込んでいる。
 * このルートはそれを ClarificationQuestion[] に変換するだけ。
 *
 * 旧設計 (このコミット以前): analyze が md で「⚠ Phase 2 要確認事項」を書く → このルートが
 * AI に「md を JSON に変換して」と依頼 → Phase 1 で答えた内容まで重複質問してくる事故が出ていた。
 * 新設計: analyze が構造化 JSON で unconfirmed を出すようになったので、AI 呼び出し不要。
 * 機械的に変換する。
 */
export async function POST(request: NextRequest) {
  const { companyId, threadId, previousQA } = (await request.json()) as {
    companyId: string;
    threadId?: string;
    previousQA?: { question: string; answer: string }[];
  };

  if (!threadId) {
    return NextResponse.json({ questions: [], error: "threadId が必要です" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find((c) => c.id === companyId);
  if (!company) {
    return NextResponse.json({ questions: [] });
  }

  // thread から phase2Decisions を読む
  let thread: ChatThread | null = null;
  try {
    const hash = crypto.createHash("md5").update(company.id).digest("hex");
    const filePath = path.join(process.cwd(), "data", "chat-threads", hash, `${threadId}.json`);
    const raw = await fs.readFile(filePath, "utf-8");
    thread = JSON.parse(raw) as ChatThread;
  } catch (e) {
    console.warn("[clarify-procedural] thread read failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ questions: [] });
  }

  const decisions = thread.phase2Decisions;
  if (!decisions || !Array.isArray(decisions.documents)) {
    return NextResponse.json({ questions: [] });
  }

  // previousQA で既に回答済みの placeholder を集める。
  // previousQA[].question は `【${placeholder}】${question}` 形式 (ChatWorkflow が組み立てている)。
  const answeredPlaceholders = new Set<string>();
  for (const qa of previousQA || []) {
    const m = qa.question.match(/^【([^】]+)】/);
    if (m) answeredPlaceholders.add(m[1].trim());
  }

  // unconfirmed 群を ClarificationQuestion[] に変換 (回答済みは除外)
  const questions: ClarificationQuestion[] = [];
  for (const doc of decisions.documents) {
    for (const u of doc.unconfirmed) {
      const placeholder = `${doc.templateFile}:${u.slot}`;
      if (answeredPlaceholders.has(placeholder)) continue;
      const options = (u.candidates || []).map((c, j) => ({
        id: `c${j + 1}`,
        label: c.value,
        source: c.source,
      }));
      questions.push({
        id: `p_${questions.length + 1}`,
        placeholder,
        question: `${u.slot} (${doc.templateFile}): ${u.reason}`,
        options,
      });
    }
  }

  return NextResponse.json({ questions });
}
