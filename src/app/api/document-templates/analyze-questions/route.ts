import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import fs from "fs/promises";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import {
  loadAiMessages,
  saveAiMessages,
  truncateBeforeStage,
  appendUserTurn,
  appendAssistantTurn,
  toAnthropicMessages,
  hasStage,
} from "@/lib/case-conversation";
import { logTokenUsage } from "@/lib/token-logger";
import type { CaseAiContentBlock } from "@/types";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

/**
 * Phase 2-A: テンプレを見て、穴埋めで迷うポイントを抽出する「質問フェーズ」。
 *
 * 設計意図:
 *   旧設計では analyze が「fill / delete-row / unconfirmed」の3択で全部一気に決めていた。
 *   AI は「unconfirmed にすると後で聞かれるので、推測で fill」しがちで、表記揺れ
 *   (徳/德) のような業務判断が必要な箇所まで勝手にルール推論してしまっていた。
 *
 *   新設計では Phase 2 を 3 段階に分ける:
 *     2-A (このルート): テンプレを見て「穴埋めで迷うポイント」を抽出 → 質問化
 *     2-B (既存 clarify カード): ユーザー回答受け取り
 *     2-C (既存 analyze): 回答揃った前提で「fill / delete-row の2択」で穴埋め決定
 *
 *   これで「人間が判断するもの」と「AI が機械的に埋めるもの」が完全に分離される。
 */

// 質問抽出用の tool 定義。AI には ClarificationQuestion[] 相当を返してもらう。
const CLARIFICATION_TOOL = {
  name: "submit_clarification_questions",
  description: "テンプレ穴埋めで迷う点をユーザーに確認するための質問リストを送る。質問が無ければ空配列を返す。",
  input_schema: {
    type: "object" as const,
    properties: {
      questions: {
        type: "array",
        description: "質問の配列。穴埋め前に確認すべきことのみ。質問が無ければ空配列。",
        items: {
          type: "object",
          properties: {
            placeholder: { type: "string", description: "短い識別子 (例: '代表取締役の表記', '払込期日')" },
            question: { type: "string", description: "ユーザーに見せる質問文。なぜ確認するかを必ず含める" },
            options: {
              type: "array",
              description: "選択肢の配列。具体的な候補値と出典を列挙する",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "選択肢として表示する値 (例: '徳永優也', '德永優也', '令和8年5月29日')" },
                  source: { type: "string", description: "出典 (例: '📋登記簿', '📋株主名簿', '📇基本情報', '推測', '✏️手入力')" },
                },
                required: ["label", "source"],
              },
            },
          },
          required: ["placeholder", "question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

export async function POST(request: NextRequest) {
  const { companyId, threadId, templateFolderPath, previousQA } = (await request.json()) as {
    companyId: string;
    threadId: string;
    templateFolderPath?: string;
    previousQA?: { question: string; answer: string }[];
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find((c) => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // Phase 1 (organize) 完了が前提
  let aiMessages = await loadAiMessages(company.id, threadId);
  if (!hasStage(aiMessages, "organize")) {
    return NextResponse.json({ error: "案件整理 (Phase 1) が完了していません" }, { status: 400 });
  }
  // analyze 系のターン (clarify-procedural / analyze) より前に切り戻す
  aiMessages = truncateBeforeStage(aiMessages, "clarify-procedural");

  // テンプレ本文 (markedText) を読み込む
  const templateBlocks: string[] = [];
  if (templateFolderPath) {
    try {
      const { getMarkedDocumentTextWithSlots } = await import("@/lib/docx-marker-parser");
      const { getXlsxMarkedTextWithSlots } = await import("@/lib/xlsx-marker-parser");
      const { ensureDocxLabels, ensureXlsxLabels } = await import("@/lib/template-labels");

      const tpFiles = await readAllFilesInFolder(templateFolderPath);
      for (const f of tpFiles) {
        if (f.name.endsWith(".txt") || f.name.endsWith(".md")) continue;
        if (f.name.endsWith(".labels.json")) continue;
        if (f.base64) continue;

        const ext = f.name.toLowerCase().split(".").pop() || "";
        let markedText = "";

        if (ext === "docx" || ext === "docm") {
          try {
            const buf = await fs.readFile(f.path);
            const { text } = getMarkedDocumentTextWithSlots(buf);
            const labels = await ensureDocxLabels(f.path);
            const labelById = new Map<number, string>();
            for (const s of labels?.slots || []) {
              if (s.label && s.label !== "不明") labelById.set(s.slotId, s.label);
            }
            markedText = text.replace(/［要入力_(\d+)］/g, (_, idStr) => {
              const id = Number(idStr);
              const lbl = labelById.get(id) || `要入力_${id}`;
              return `★${lbl}★`;
            });
          } catch (e) {
            console.warn(`[analyze-questions] docx marker read failed (${f.name}):`, e instanceof Error ? e.message : e);
          }
        } else if (ext === "xlsx" || ext === "xlsm" || ext === "xls") {
          try {
            const buf = await fs.readFile(f.path);
            const { text } = getXlsxMarkedTextWithSlots(buf);
            const labels = await ensureXlsxLabels(f.path);
            const labelById = new Map<number, string>();
            for (const s of labels?.slots || []) {
              if (s.label && s.label !== "不明") labelById.set(s.slotId, s.label);
            }
            markedText = text.replace(/［要入力_(\d+)］/g, (_, idStr) => {
              const id = Number(idStr);
              const lbl = labelById.get(id) || `要入力_${id}`;
              return `★${lbl}★`;
            });
          } catch (e) {
            console.warn(`[analyze-questions] xlsx marker read failed (${f.name}):`, e instanceof Error ? e.message : e);
          }
        }

        if (!markedText && f.content) markedText = f.content;
        if (!markedText) continue;
        markedText = markedText.replace(/(\(空\)\n)(\(空\)\n)+/g, "(空)\n");
        templateBlocks.push(`### ${f.name}\n\`\`\`\n${markedText}\n\`\`\``);
      }
    } catch (e) {
      console.warn("[analyze-questions] template read failed:", e instanceof Error ? e.message : e);
    }
  }
  const templateBodyBlock =
    templateBlocks.length > 0
      ? `\n## テンプレート本文 (★ラベル★ が埋めるべき穴)\n\n${templateBlocks.join("\n\n")}\n`
      : "\n## テンプレート本文\n(読めませんでした)\n";

  const qaBlock =
    previousQA && previousQA.length > 0
      ? `\n## Phase 1 確認質問と回答 (ユーザー確定済み)\n${previousQA
          .map((qa, i) => `${i + 1}. Q: ${qa.question}\n   A: ${qa.answer}`)
          .join("\n")}\n`
      : "";

  const profileBlock = company.profile?.structured
    ? `\n## 会社の基本情報 (参照データ)\n\`\`\`json\n${JSON.stringify(company.profile.structured, null, 2)}\n\`\`\`\n`
    : "";

  const promptText = `## あなたが今やること (Phase 2-A: 穴埋めで迷うポイントを抽出して質問化)

これからテンプレ書類に値を穴埋めしようとしています。
**穴埋めを始める前に**、ユーザーに確認すべき「迷うポイント」だけを抽出してください。

決まったルールで機械的に埋められるものは質問しない。
推測が必要なもの・選択の余地があるもの・業務判断が要るものだけを質問する。

${qaBlock}
${profileBlock}
${templateBodyBlock}

## 質問にすべきケース (どれか1つでも当てはまれば質問)

1. **表記揺れ・異体字**
   - 「徳/德」「沢/澤」「斉/齊」「高/髙」「広/廣」など、複数資料で表記が違う人名・地名
   - 住所の番地表記 (1-2-3 / 1丁目2番3号、漢数字/算用数字)
   - グローバルルールに「○○優先」と書いてあっても、具体的にどちらを使うかは依頼人確認

2. **複数候補があり、文脈だけで絞れない値**
   - 払込期日・決議日・効力発生日が複数候補ある
   - 同じ意味の値が複数資料で食い違う

3. **案件特有の業務判断**
   - 「就任承諾書は別途準備するか / このテンプレに含めるか」など
   - 監査役関連議案を入れるか・省くか

4. **どこにも書かれていない値**
   - 基本情報・案件資料・案件整理結果のどれにも明確に書かれていない値

## 質問にしなくていいケース

1. 案件資料・基本情報に**明確に書かれていて**、複数資料で**一致している**値
   (会社名・本店所在地・既存役員 etc)
2. 標準的で迷う余地のない slot
3. **既に Phase 1 で答えてもらった内容** (previousQA に含まれているもの)

## 重要原則

- **「○○のはず」「○○だろう」と思った時点で質問にする**。推測で済まさない
- options には**具体的な候補値**と**出典**を必ず付ける (「📋登記簿」「📋株主名簿」「📇基本情報」「推測」「✏️手入力」など)
- 質問が**1つもない**場合は空配列で返す (無理に質問を作らない)
- 同じ意味の質問を複数書類で繰り返さない (1書類でユーザーが答えれば全書類に適用される前提)

## 出力

submit_clarification_questions tool で質問リストを返してください。`;

  const userTurnContent: CaseAiContentBlock[] = [{ type: "text", text: promptText }];
  const messagesWithUserTurn = appendUserTurn(aiMessages, userTurnContent, "clarify-procedural");

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      temperature: 0,
      tools: [CLARIFICATION_TOOL],
      tool_choice: { type: "tool", name: "submit_clarification_questions" },
      messages: toAnthropicMessages(messagesWithUserTurn) as Anthropic.MessageParam[],
    });
    logTokenUsage("/api/document-templates/analyze-questions", MODEL, response.usage);

    const toolBlock = response.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use"
    );
    let questions: Array<{ id: string; placeholder: string; question: string; options: Array<{ id: string; label: string; source?: string }> }> = [];
    if (toolBlock?.name === "submit_clarification_questions") {
      const input = toolBlock.input as { questions?: Array<{ placeholder?: string; question?: string; options?: Array<{ label?: string; source?: string }> }> };
      questions = (input.questions || []).map((q, i) => ({
        id: `q_${i + 1}`,
        placeholder: q.placeholder || "確認",
        question: q.question || "",
        options: (q.options || []).map((o, j) => ({
          id: `c${j + 1}`,
          label: o.label || "",
          source: o.source,
        })).filter(o => o.label.trim()),
      }));
    }

    // 会話履歴に「質問抽出した」記録を残す (analyze で参照される)
    const summaryText = questions.length > 0
      ? `Phase 2-A: 穴埋めで迷うポイントを ${questions.length} 件抽出:\n${questions.map((q, i) => `${i + 1}. [${q.placeholder}] ${q.question}`).join("\n")}`
      : "Phase 2-A: 穴埋めで迷うポイントは抽出されませんでした (全て自動穴埋め可能)。";
    const finalMessages = appendAssistantTurn(messagesWithUserTurn, summaryText, "clarify-procedural");
    await saveAiMessages(company.id, threadId, finalMessages);

    return NextResponse.json({ questions });
  } catch (e) {
    console.error("[analyze-questions] failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "失敗", questions: [] }, { status: 500 });
  }
}
