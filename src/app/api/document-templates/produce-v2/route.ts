// /api/document-templates/produce-v2
// 新 produce パイプライン (per-doc Haiku + edit engine)。
//
// 旧 produce との違い:
//   - 書類1つずつに Haiku を呼ぶ (並列)
//   - 各呼び出しに「そのテンプレの marked text + Phase 2 全決定 + Phase 1 Q&A」を渡す
//   - AI は { deletes, adds, fills } を返す
//   - サーバはこれを edit engine (produce-edits.ts) で適用するだけ
//   - 判断はすべて AI 側。サーバはルール判断ゼロ
//
// 出力: produce 旧ルートと同じ { documents: DocOut[] } シェイプ。ChatWorkflow は変更不要に近い。

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { logTokenUsage } from "@/lib/token-logger";
import { applyProduceEditsDocx, applyProduceEditsXlsx } from "@/lib/produce-edits";
import type { ChatThread, Phase2Decisions } from "@/types";

const client = new Anthropic();
const MODEL = "claude-haiku-4-5-20251001";

// 1書類あたりの AI 応答 (JSON)
interface DocResponse {
  deletes?: { anchor: string; expectedMatches?: number }[];
  adds?: { afterAnchor: string; contents: string[]; expectedMatches?: number }[];
  fills?: Record<string, string>;
}

// 旧 produce 互換の出力シェイプ
interface DocOut {
  name: string;
  fileName: string;
  docxBase64: string;
  previewHtml: string;
  templatePath?: string;
}

export async function POST(request: NextRequest) {
  const { companyId, threadId, templateFolderPath } = (await request.json()) as {
    companyId: string;
    threadId: string;
    templateFolderPath: string;
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find((c) => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // thread から phase2Decisions と Phase 1 Q&A を読む
  let thread: ChatThread | null = null;
  try {
    const hash = crypto.createHash("md5").update(company.id).digest("hex");
    const tpath = path.join(process.cwd(), "data", "chat-threads", hash, `${threadId}.json`);
    const raw = await fs.readFile(tpath, "utf-8");
    thread = JSON.parse(raw) as ChatThread;
  } catch (e) {
    return NextResponse.json({ error: "スレッドが読めません: " + (e instanceof Error ? e.message : e) }, { status: 500 });
  }

  const phase2Decisions = thread.phase2Decisions;
  if (!phase2Decisions || !Array.isArray(phase2Decisions.documents)) {
    return NextResponse.json({ error: "Phase 2 決定がありません。analyze を先に走らせてください" }, { status: 400 });
  }

  // Phase 1 Q&A: messages 配下の clarification カードから集める
  const previousQA: { question: string; answer: string }[] = [];
  for (const m of thread.messages) {
    for (const c of m.cards || []) {
      if (c.type !== "clarification") continue;
      for (const q of c.questions) {
        let ans = "";
        if (q.selectedOptionId === "_manual") ans = q.manualInput || "";
        else if (q.selectedOptionId) {
          const opt = q.options.find((o) => o.id === q.selectedOptionId);
          ans = opt?.label || "";
        }
        if (ans) previousQA.push({ question: `【${q.placeholder}】${q.question}`, answer: ans });
      }
    }
  }

  // テンプレファイル一覧 (docx + xlsx)
  const tpFiles = await readAllFilesInFolder(templateFolderPath);
  const targetFiles = tpFiles.filter(
    (f) => /\.(docx|docm|xlsx|xlsm|xls)$/i.test(f.name) && !f.name.endsWith(".labels.json")
  );

  if (targetFiles.length === 0) {
    return NextResponse.json({ error: "対象テンプレートが見つかりません" }, { status: 400 });
  }

  // テンプレ別に marked text を作る (★label★ 入り)
  const { getMarkedDocumentTextWithSlots } = await import("@/lib/docx-marker-parser");
  const { getXlsxMarkedTextWithSlots } = await import("@/lib/xlsx-marker-parser");
  const { ensureDocxLabels, ensureXlsxLabels } = await import("@/lib/template-labels");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mammoth = require("mammoth");

  // 書類別に並列で AI 呼び出し → edit 適用
  const docOuts = await Promise.all(
    targetFiles.map(async (f): Promise<DocOut | null> => {
      try {
        const buf = await fs.readFile(f.path);
        const ext = f.name.toLowerCase().split(".").pop() || "";
        const isXlsx = ext === "xlsx" || ext === "xlsm" || ext === "xls";

        // marked text + labels を取得
        let rawText = "";
        let labels = null as Awaited<ReturnType<typeof ensureDocxLabels>> | null;
        if (isXlsx) {
          const r = getXlsxMarkedTextWithSlots(buf);
          rawText = r.text;
          labels = await ensureXlsxLabels(f.path);
        } else {
          const r = getMarkedDocumentTextWithSlots(buf);
          rawText = r.text;
          labels = await ensureDocxLabels(f.path);
        }
        const labelById = new Map<number, string>();
        for (const s of labels?.slots || []) {
          if (s.label && s.label !== "不明") labelById.set(s.slotId, s.label);
        }
        const markedText = rawText.replace(/［要入力_(\d+)］/g, (_, idStr) => {
          const id = Number(idStr);
          const lbl = labelById.get(id) || `要入力_${id}`;
          return `★${lbl}★`;
        });

        // 該当書類の Phase 2 決定 (slots / deletes / unconfirmed) を集める
        const myDecision = phase2Decisions.documents.find(
          (d) => d.templateFile === f.name || d.templateFile === f.name.replace(/\.[^.]+$/, "")
        );

        // Phase 2 全決定を AI に渡す (穴埋めデータ全件投げる = 全体齟齬防止)
        const allDecisionsBlock = `\`\`\`json\n${JSON.stringify(phase2Decisions, null, 2)}\n\`\`\``;

        const myDecisionBlock = myDecision
          ? `\`\`\`json\n${JSON.stringify(myDecision, null, 2)}\n\`\`\``
          : "(この書類向けの Phase 2 決定なし)";

        const qaBlock =
          previousQA.length > 0
            ? `\n## Phase 1 確認質問と回答\n${previousQA.map((qa, i) => `${i + 1}. Q: ${qa.question}\n   A: ${qa.answer}`).join("\n")}\n`
            : "";

        const prompt = `## あなたが今やること

書類「${f.name}」に対する編集オペレーションを JSON で返す。
あなたは Phase 2 で全書類の決定を済ませている。このターンはそれを **この書類1つに適用する** だけ。

## テンプレ本文 (★label★ = 穴埋め位置)
\`\`\`
${markedText}
\`\`\`

## この書類向けの Phase 2 決定
${myDecisionBlock}

## 全書類の Phase 2 決定 (整合性確認用、参考)
${allDecisionsBlock}
${qaBlock}

## 出力形式

\`\`\`json
{
  "deletes": [
    { "anchor": "削除する段落の中の一意な文字列", "expectedMatches": 1 }
  ],
  "adds": [
    { "afterAnchor": "挿入位置の前段落の一意な文字列", "contents": ["新しい段落1の本文 (★label★ 含めて OK)"], "expectedMatches": 1 }
  ],
  "fills": {
    "★label★": "値"
  }
}
\`\`\`

## ルール

- anchor / afterAnchor は **他の段落と被らない一意な文字列** を選ぶ (段落見出し全体や ★label★ 等)
- fills のキーは ★ で囲んだラベル名そのまま。値は最終形式 (令和8年5月29日 / 株式会社JINGS 等)
- adds.contents で新段落を作るとき、★label★ を含めて OK (後段の fills で埋まる)
- 不要な操作は省略可 (deletes: [], adds: [] でも OK)
- expectedMatches で件数指定 (省略時は 1)。1件しかマッチしない anchor を使うのが原則
- 個人 vs 法人で構造を変えるケース等は、適切に deletes + adds を組み合わせる
- JSON のみ返す (説明文不要)`;

        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
        });
        logTokenUsage(`/api/document-templates/produce-v2 (${f.name})`, MODEL, response.usage);

        const aiText = response.content[0].type === "text" ? response.content[0].text : "";

        // JSON 抽出
        let edits: DocResponse = {};
        const jsonMatch = aiText.match(/```json\s*([\s\S]*?)```/) || aiText.match(/\{[\s\S]*\}/);
        const jsonText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : "";
        try {
          edits = JSON.parse(jsonText);
        } catch (e) {
          console.warn(`[produce-v2] JSON parse failed for ${f.name}:`, e instanceof Error ? e.message : e);
          return null;
        }

        // edit engine で適用 (xlsx / docx の振り分け)
        const result = isXlsx
          ? await applyProduceEditsXlsx(buf, edits, labels)
          : await applyProduceEditsDocx(buf, edits, labels);
        if (result.skipped.length > 0) {
          console.warn(`[produce-v2] ${f.name} skipped:`, result.skipped);
        }
        console.log(`[produce-v2] ${f.name} applied: ${result.applied.length}, skipped: ${result.skipped.length}`);

        // previewHtml: docx は mammoth で、xlsx は簡易な空表示 (フロントの FilePreview が xlsx も扱える前提)
        let previewHtml = "";
        if (!isXlsx) {
          try {
            const { value } = await mammoth.convertToHtml({ buffer: result.buf });
            previewHtml = value;
          } catch (e) {
            console.warn(`[produce-v2] mammoth failed for ${f.name}:`, e instanceof Error ? e.message : e);
          }
        }

        return {
          name: f.name.replace(/\.[^.]+$/, ""),
          fileName: f.name,
          docxBase64: result.buf.toString("base64"),
          previewHtml,
          templatePath: f.path,
        };
      } catch (e) {
        console.error(`[produce-v2] ${f.name} failed:`, e instanceof Error ? e.stack || e.message : e);
        return null;
      }
    })
  );

  const documents = docOuts.filter((d): d is DocOut => d !== null);

  return NextResponse.json({ documents });
}
