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

  // 旧設計では clarify を多段で呼び、毎ラウンド AI が新規 Q を追加していたため
  // 「24 問を 4 ラウンド」みたいな分散が起きていた（AI が「重要なものから」と保守的に出すクセ）。
  // 新設計: 初回呼び出しで**全ての不確かな項目を一度に出させる**。
  // 再呼び出し時 (previousQA あり) は「前回 exhaustive だった前提」で原則ゼロ件を返させる。
  const exhaustiveInstruction = isReCall
    ? `## あなたが今やること（ターン2 再実行: 取りこぼし確認）

前回の clarify で既にユーザーが回答済みの項目が「これまでの確認結果」に入ってます。

**原則: ここでは新規質問を追加しないでください。空配列 \`[]\` を返してください。**

例外として、新規質問を追加してよいのは以下の場合のみ:
- ユーザーの回答内容から**新たな矛盾や不整合**が見えた（例: 株主3名と言ったが回答では2名分しか出てない）
- 回答が**曖昧で**そのまま書類生成に進むと致命的な誤りになる
- 前回の質問では**触れられなかった重要事項**で、書類生成に絶対必要

上記に当てはまらない限り、必ず \`[]\` を返すこと。AI 側で「念のため」を増やさないこと。`
    : `## あなたが今やること（ターン2: 不足項目の確認質問を作る）

ターン1で整理してくれた内容と、テンプレ本体の各スロットを照らし合わせて、
**まだ値が確定していない項目を「この1回で全て」** 確認質問として作ってください。

**最重要ルール**:
- これはユーザーに質問できる**唯一の機会**です。後から「もう一個聞きたい」「次のターンで追加で聞く」は禁止。
- 不確かな項目は**全部この回で列挙**してください。「重要なものから出して、残りは次回」のような分割はしないこと。
- ユーザーは多少多くても1回で全部答える方が楽です。逆に小出しに何度も聞かれる方が遥かに負担。
- 迷ったら「聞く」側に倒す。漏れて後から訂正が入るより、最初に確認した方が結果として早い。

判断基準:
- ターン1の整理結果で値が \`*要確認*\` になっているもの → 必ず質問
- ターン1で「⚠ 要確認事項」セクションに書いた項目 → 必ず質問（ただし1つの懸念に対して質問1個。重複させない）
- ターン1で値を出せたが、自信がない・複数解釈ができる → 質問
- ターン1で確実に出せた値 → 質問しない

**重要**: 同じ topic を別の表現で 2 回質問しないこと。たとえば「会社商号の表記ゆれ」と
「会社名（商号）」は同じ topic なので、1 つの質問にまとめる。`;

  const userTurnText = `${exhaustiveInstruction}

各質問には可能な限り候補を 1〜3 件 options に含める:
- 案件整理で挙げた候補・基本情報の値などを options に入れる
- それぞれ source に出典（どの資料か）を書く
- 手動入力ができる（フロントエンドが自動で追加）ので、分からなければ空の options でも可

${previousQABlock}
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
- 同じ topic の別表現での重複質問

## 質問文の書き方（厳守）
- **内部実装やパース失敗の事情を質問文に出さない**。
  NG例: 「システムエラーで読み取れませんでした」「Excel のセルが日付シリアル値として誤入力されていて…」
  「○○のパースに失敗したため…」
  → ユーザーは内部処理の知識なし。「○○が確認できなかったので教えてください」のようにシンプルに書く
- 業務として自然な日本語で、ユーザー（司法書士）に直接話しかける形で

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
