import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { logTokenUsage } from "@/lib/token-logger";
import {
  loadAiMessages,
  saveAiMessages,
  truncateBeforeStage,
  appendUserTurn,
  appendAssistantTurn,
  toAnthropicMessages,
  hasStage,
} from "@/lib/case-conversation";
import type { ClarificationQuestion } from "@/types";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

/**
 * 確認質問の生成 = 「1案件1会話」のターン2。
 *
 * 旧設計: テンプレ一覧・基本情報・案件整理テキストを毎回プロンプトに詰めて Claude に送り直していた。
 *   結果として「organize で迷った末に三上春香にした」というような判断が引き継がれず、
 *   clarify が同じことを再度 0 から判断していた。
 *   さらに organize 出力の「⚠ 要確認事項」セクションをテキストパースして knownMissing として
 *   AI に渡し、AI が答え忘れたら自動追加する「安全網」が入っていた。
 *   → 安全網は AI が文言を綺麗に書き直すと「同じ topic」と認識できず、重複質問を量産していた。
 * 新設計: clarify (ターン2) の AI は organize (ターン1) の会話そのものを覚えているため、
 *   自分が ⚠ 要確認 と書いた項目を再質問するのは AI の責務。安全網は廃止。
 *
 * 入力:
 *  - threadId（必須）: aiMessages の保存先
 *  - previousQA: 過去の Q&A（同スレッド内で再度 clarify を呼ぶ場合の重複回避）
 */
export async function POST(request: NextRequest) {
  const { companyId, previousQA, threadId } = await request.json() as {
    companyId: string;
    templateFolderPath?: string; // 互換のため残すが、ターン1で既に渡している
    previousQA?: { question: string; answer: string }[];
    folderPath?: string;
    disabledFiles?: string[];
    knownMissing?: string[]; // 互換のため受け取るが現在は未使用（安全網廃止）
    threadId?: string;
  };

  if (!threadId) {
    return NextResponse.json({ questions: [], error: "threadId が必要です" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ questions: [] });
  }

  // 案件整理（ターン1）の内容を Claude が既に覚えている前提で、続きとしてターン2を書く
  let aiMessages = await loadAiMessages(company.id, threadId);
  if (!hasStage(aiMessages, "organize")) {
    return NextResponse.json({ questions: [] });
  }

  // clarify を再実行する場合は、過去の clarify ターンを切り戻す
  aiMessages = truncateBeforeStage(aiMessages, "clarify");

  const isReCall = !!(previousQA && previousQA.length > 0);
  const previousQABlock = isReCall
    ? `\n## これまでの確認結果（既に確定済み。再質問しないこと）\n${previousQA.map(qa => `- Q: ${qa.question}\n  A: ${qa.answer}`).join("\n")}\n`
    : "";

  const reCallNote = isReCall
    ? `\n再実行: 「これまでの確認結果」にあるものは原則 \`[]\` を返す。回答から新たな矛盾が見えた時だけ追加質問する。\n`
    : "";

  const userTurnText = `## あなたが今やること

ターン1 で出した整理結果と ⚠ 要確認事項を踏まえて、ユーザーに聞くべき質問を JSON 配列で出す。
**この1回で全部** 聞く (後出し追加禁止)。
${reCallNote}
${previousQABlock}

## ルール

- ⚠ 要確認事項に書いた項目は全部この回で出す (重要度で絞らない)
- 同じ topic は1つにまとめる
- ターン1 で確定した値・基本情報の過去履歴は質問しない
- 候補が分かれば 1〜3 件 options に積む (source に出典)
- 質問文は普通の業務日本語。内部用語 (システムエラー / パース失敗 等) は使わない
- **質問本文と options の数字表記を揃える**。混在させない (例: 質問で「7番13号」と書いて
  options で「七番十三号」は NG。同じ住所が違って見えてユーザーが混乱する)
- **住所・氏名・日付などは options に出す形をそのまま質問文にも使う**
  (登記書類の正式表記が漢数字なら、質問文も漢数字に。半角なら半角に統一)

## 出力 (JSON 配列のみ、説明文なし)

\`\`\`json
[
  { "id": "q1", "placeholder": "ラベル名", "question": "質問文",
    "options": [{ "id": "a1", "label": "値", "source": "出典" }] }
]
\`\`\``;

  const messagesWithUserTurn = appendUserTurn(aiMessages, userTurnText, "clarify");

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      temperature: 0,
      messages: toAnthropicMessages(messagesWithUserTurn) as Anthropic.MessageParam[],
    });
    logTokenUsage("/api/document-templates/clarify", MODEL, response.usage);

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    // assistant ターンを保存（produce/verify が読む）
    const finalMessages = appendAssistantTurn(messagesWithUserTurn, text, "clarify");
    await saveAiMessages(company.id, threadId, finalMessages);

    // JSON パース（途切れていたら末尾を補って救出）
    let questions: ClarificationQuestion[] = [];
    const fullMatch = text.match(/\[[\s\S]*\]/);
    if (fullMatch) {
      try {
        questions = JSON.parse(fullMatch[0]);
      } catch { /* fall through to truncation recovery */ }
    }
    if (questions.length === 0) {
      const start = text.indexOf("[");
      const lastBrace = text.lastIndexOf("}");
      if (start >= 0 && lastBrace > start) {
        const patched = text.slice(start, lastBrace + 1) + "]";
        try {
          questions = JSON.parse(patched);
          console.log(`[clarify] recovered from truncated JSON: ${questions.length} questions`);
        } catch { /* give up */ }
      }
    }

    // previousQA に既に答えた質問を除外（AI が重複させないか念のためのフィルタ）
    if (previousQA && previousQA.length > 0 && questions.length > 0) {
      const answeredPlaceholders = new Set(
        previousQA.map(qa => {
          const m = qa.question.match(/【([^】]+)】/);
          return m ? m[1].trim() : "";
        }).filter(Boolean)
      );
      const before = questions.length;
      questions = questions.filter(q => !answeredPlaceholders.has(q.placeholder));
      if (before !== questions.length) {
        console.log(`[clarify] filtered ${before - questions.length} duplicate questions (already answered)`);
      }
    }

    // 末尾に「その他注意点」フリーテキスト質問を追加（任意回答）。
    // AI が想定した特定スロット質問では拾えない、ユーザー側の業務知識（書式の好み・案件特有の事情）を
    // 拾うための受け皿。previousQA に既に答えがあれば再追加しない。
    const generalNoteId = "general_note";
    const alreadyHasGeneralNote = (previousQA || []).some(qa => qa.question.includes("【案件全体の注意点】"));
    if (!alreadyHasGeneralNote) {
      questions.push({
        id: generalNoteId,
        placeholder: "案件全体の注意点",
        question: "他に書類作成時に注意すべき点があれば教えてください（任意・空白OK）",
        options: [],
      });
    }

    return NextResponse.json({ questions });
  } catch (e) {
    console.error("[clarify] failed:", e);
    return NextResponse.json({ questions: [] });
  }
}
