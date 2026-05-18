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
 * Phase 2 clarify (= 書面ルール上の確認質問) = 「1案件1会話」のターン4。
 *
 * analyze (ターン3) が末尾に書いた「## ⚠ Phase 2 要確認事項」リストを、
 * UI 質問カードに変換する。AI は同じ会話の中で自分が書いた要確認事項を覚えているので、
 * テキストパースで knownMissing を渡す必要はない。
 *
 * 入力:
 *  - threadId（必須）
 *  - previousQA: Phase 1 / Phase 2 のすべての Q&A（重複質問の防止）
 *
 * 出力:
 *  - { questions: ClarificationQuestion[] } — Phase 1 と同じスキーマ
 */
export async function POST(request: NextRequest) {
  const { companyId, previousQA, threadId } = (await request.json()) as {
    companyId: string;
    previousQA?: { question: string; answer: string }[];
    threadId?: string;
  };

  if (!threadId) {
    return NextResponse.json({ questions: [], error: "threadId が必要です" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find((c) => c.id === companyId);
  if (!company) {
    return NextResponse.json({ questions: [] });
  }

  // analyze (ターン3) の内容を Claude が既に覚えている前提で、続きとしてターン4を書く
  let aiMessages = await loadAiMessages(company.id, threadId);
  if (!hasStage(aiMessages, "analyze")) {
    return NextResponse.json({ questions: [] });
  }

  // 再実行時は clarify-procedural 以降を切り戻す
  aiMessages = truncateBeforeStage(aiMessages, "clarify-procedural");

  const isReCall = !!(previousQA && previousQA.length > 0);
  const previousQABlock = isReCall
    ? `\n## これまでの確認結果（既に確定済み。再質問しないこと）\n${previousQA
        .map((qa) => `- Q: ${qa.question}\n  A: ${qa.answer}`)
        .join("\n")}\n`
    : "";

  // Phase 1 clarify と同じく「初回は全質問列挙、再呼び出し時は原則ゼロ件」方針
  const exhaustiveInstruction = isReCall
    ? `## あなたが今やること（ターン4 再実行: Phase 2 取りこぼし確認）

前回の Phase 2 clarify で既にユーザーが回答済みの項目が「これまでの確認結果」に入っています。

**原則: ここでは新規質問を追加しないでください。空配列 \`[]\` を返してください。**

例外として、新規質問を追加してよいのは以下の場合のみ:
- ユーザーの回答内容から **新たな書面ルール上の矛盾** が見えた
- 回答が **曖昧で** そのまま書類生成に進むと致命的な誤りになる
- 前回の質問では **触れられなかった重要事項** で、書類生成に絶対必要

上記に当てはまらない限り、必ず \`[]\` を返すこと。`
    : `## あなたが今やること（ターン4: Phase 2 = 書面ルール上の確認質問を作る）

ターン3 (Phase 2 = テンプレ突き合わせ分析) の末尾に書いた **「## ⚠ Phase 2 要確認事項」** リストを、
UI で表示する質問カードに変換してください。

**最重要ルール**:
- これは Phase 2 でユーザーに質問できる **唯一の機会** です。後から追加質問は禁止。
- ターン3 の ⚠ Phase 2 要確認事項に挙げた項目は **全部この回で列挙** してください。
- ユーザーは多少多くても1回で全部答える方が楽です。

**質問の中身**:
- 議案削除の可否（例: 「議事録.docx の第3号議案を削除でよいですか？」）
- 書類間の統一性（例: 「引受人の正式商号は『××株式会社』『株式会社××』どちらに統一しますか？」）
- 書面ルール上の不確実性（例: 「取締役会決議日は 5/20 と 5/22 のどちらで全書類を作成しますか？」）

**質問してはいけないもの**:
- Phase 1 (実体判断) で既に答えてもらった内容（「これまでの確認結果」を参照）
- 値の精密抽出が必要なもの（金額・住所等）→ 次のターンの produce が案件ファイル直接参照で取得する
- 同じ topic の別表現での重複質問`;

  const userTurnText = `${exhaustiveInstruction}

各質問には可能な限り候補を 1〜3 件 options に含める:
- 削除可否の質問なら「はい、削除する」「いいえ、残す」を options に
- 表記揺れの統一なら、候補となる各表記を options に
- それぞれ source に出典（どの資料か / どの書類か）を書く
- 手動入力ができる（フロントエンドが自動で追加）ので、分からなければ空の options でも可

${previousQABlock}
## 出力形式（JSONのみ）
\`\`\`json
[
  {
    "id": "p1",
    "placeholder": "プレースホルダー名（書類名やテンプレ項目名）",
    "question": "質問文",
    "options": [
      { "id": "a1", "label": "選択肢の値", "source": "出典（議事録テンプレ / 投資契約書 等）" }
    ]
  }
]
\`\`\`

## 質問してはいけないもの（厳守）
- ターン1〜3 で確定した値の確認（既に確定済み）
- 「これまでの確認結果」に含まれる項目
- 同じ topic の別表現での重複質問
- 案件ファイル参照で次のターンが取得できる値（金額・住所のスペル等）

ターン3 の「## ⚠ Phase 2 要確認事項」が空または該当なしの場合は、空配列 \`[]\` を返してください。

JSON配列のみ返してください。説明文・前置き不要。`;

  const messagesWithUserTurn = appendUserTurn(aiMessages, userTurnText, "clarify-procedural");

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: toAnthropicMessages(messagesWithUserTurn) as Anthropic.MessageParam[],
    });
    logTokenUsage("/api/document-templates/clarify-procedural", MODEL, response.usage);

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    // assistant ターンを保存（produce が読む）
    const finalMessages = appendAssistantTurn(messagesWithUserTurn, text, "clarify-procedural");
    await saveAiMessages(company.id, threadId, finalMessages);

    // JSON パース（途切れていたら末尾を補って救出）
    let questions: ClarificationQuestion[] = [];
    const fullMatch = text.match(/\[[\s\S]*\]/);
    if (fullMatch) {
      try {
        questions = JSON.parse(fullMatch[0]);
      } catch {
        /* fall through */
      }
    }
    if (questions.length === 0) {
      const start = text.indexOf("[");
      const lastBrace = text.lastIndexOf("}");
      if (start >= 0 && lastBrace > start) {
        const patched = text.slice(start, lastBrace + 1) + "]";
        try {
          questions = JSON.parse(patched);
          console.log(`[clarify-procedural] recovered from truncated JSON: ${questions.length} questions`);
        } catch {
          /* give up */
        }
      }
    }

    // previousQA に既に答えた質問を除外（保険）
    if (previousQA && previousQA.length > 0 && questions.length > 0) {
      const answeredPlaceholders = new Set(
        previousQA
          .map((qa) => {
            const m = qa.question.match(/【([^】]+)】/);
            return m ? m[1].trim() : "";
          })
          .filter(Boolean)
      );
      const before = questions.length;
      questions = questions.filter((q) => !answeredPlaceholders.has(q.placeholder));
      if (before !== questions.length) {
        console.log(
          `[clarify-procedural] filtered ${before - questions.length} duplicate questions (already answered)`
        );
      }
    }

    return NextResponse.json({ questions });
  } catch (e) {
    console.error("[clarify-procedural] failed:", e);
    return NextResponse.json({ questions: [] });
  }
}
