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
 * 新設計: organize で書き込んだ会話履歴の続きとしてユーザーターンを追加するだけ。
 *   Claude は organize で自分が出した整理結果を覚えているので、テンプレや基本情報を
 *   再送する必要がない。
 *
 * 入力:
 *  - threadId（必須）: aiMessages の保存先
 *  - knownMissing: 案件整理で *要確認* となった項目（必ず質問にする）
 *  - previousQA: 過去の Q&A（同スレッド内で再度 clarify を呼ぶ場合の重複回避）
 */
export async function POST(request: NextRequest) {
  const { companyId, previousQA, knownMissing, threadId } = await request.json() as {
    companyId: string;
    templateFolderPath?: string; // 互換のため残すが、ターン1で既に渡している
    previousQA?: { question: string; answer: string }[];
    folderPath?: string;
    disabledFiles?: string[];
    knownMissing?: string[];
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
    // 旧スレッドや、organize がまだの状態 → 質問できない
    return NextResponse.json({ questions: [] });
  }

  // clarify を再実行する場合は、過去の clarify ターンを切り戻す（organize までは保持）
  aiMessages = truncateBeforeStage(aiMessages, "clarify");

  // ユーザーターン: 「不足項目を質問JSONで」
  const knownMissingBlock = (knownMissing && knownMissing.length > 0)
    ? `\n## 必ず質問する項目（案件整理で *要確認* になったもの）\n${knownMissing.map(m => `- ${m}`).join("\n")}\n\nこの項目は全て質問リストに含めてください。必要に応じて、資料から推測される候補を options に入れて選択肢として提示します。\n`
    : "";

  const previousQABlock = (previousQA && previousQA.length > 0)
    ? `\n## これまでの確認結果（既に確定済み。再質問しないこと）\n${previousQA.map(qa => `- Q: ${qa.question}\n  A: ${qa.answer}`).join("\n")}\n`
    : "";

  const userTurnText = `## あなたが今やること（ターン2: 不足項目の確認質問を作る）

ターン1で整理してくれた内容と、テンプレ本体の各スロットを照らし合わせて、
**まだ値が確定していない項目** だけを確認質問として作ってください。

判断基準:
- ターン1の整理結果で値が \`*要確認*\` になっているもの → 必ず質問
- ターン1で値を出せたが、自信がない・複数解釈ができる → 質問
- ターン1で確実に出せた値 → 質問しない

各質問には可能な限り候補を 1〜3 件 options に含める:
- 案件整理で挙げた候補・基本情報の値などを options に入れる
- それぞれ source に出典（どの資料か）を書く
- 手動入力ができる（フロントエンドが自動で追加）ので、分からなければ空の options でも可

${knownMissingBlock}${previousQABlock}
## 出力形式（JSONのみ）
\`\`\`json
[
  {
    "id": "q1",
    "placeholder": "プレースホルダー名（テンプレで使われているラベル名）",
    "question": "質問文",
    "options": [
      { "id": "a1", "label": "選択肢の値", "source": "出典（登記簿 2024/03等）" }
    ]
  }
]
\`\`\`

## 質問してはいけないもの（厳守）
- ターン1の整理結果で確定した値の確認（既に確定済み）
- 基本情報内の変更履歴・過去の辞任・過去の住所移転等、今回の手続きと関係ない過去の事実
- 「これまでの確認結果」に含まれる項目

JSON配列のみ返してください。説明文・前置き不要。`;

  const messagesWithUserTurn = appendUserTurn(aiMessages, userTurnText, "clarify");

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
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

    // previousQA に既に答えた質問を除外
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

    // knownMissing にあるのに AI が質問に含め忘れた項目を追加（安全網）
    const normalize = (s: string): string =>
      s.replace(/[（）\(\)【】「」『』《》<>\[\]/／\\\\\-－‐ー−・,，、。\s　]/g, "")
        .replace(/^日付/, "")
        .replace(/の値$/, "");

    if (knownMissing && knownMissing.length > 0) {
      const answeredNormalized = new Set(
        (previousQA || []).map(qa => {
          const m = qa.question.match(/【([^】]+)】/);
          return normalize(m ? m[1] : "");
        }).filter(Boolean)
      );
      const existingNormalized = new Set([
        ...questions.map(q => normalize(q.placeholder || "")),
        ...questions.map(q => normalize(q.question || "")),
      ].filter(Boolean));

      for (const missing of knownMissing) {
        const norm = normalize(missing);
        if (!norm) continue;
        if (answeredNormalized.has(norm)) continue;
        const alreadyCovered = existingNormalized.has(norm) ||
          [...existingNormalized].some(e => e.includes(norm) || norm.includes(e));
        if (!alreadyCovered) {
          questions.push({
            id: `auto_${questions.length + 1}`,
            placeholder: missing,
            question: `${missing} の値を入力してください（案件整理で特定できませんでした）`,
            options: [],
          });
          existingNormalized.add(norm);
        }
      }
    }

    return NextResponse.json({ questions });
  } catch (e) {
    console.error("[clarify] failed:", e);
    return NextResponse.json({ questions: [] });
  }
}
