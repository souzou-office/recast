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

// 1書類あたりの AI 応答 (JSON) — 段落番号方式
interface DocResponse {
  deletes?: { paragraphIndex: number }[];
  inserts?: { afterParagraphIndex: number; contents: string[] }[];
  rewrites?: { paragraphIndex: number; newText: string }[];
  replaces?: { anchor: string; replacement: string }[];
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
        const markedTextRaw = rawText.replace(/［要入力_(\d+)］/g, (_, idStr) => {
          const id = Number(idStr);
          const lbl = labelById.get(id) || `要入力_${id}`;
          return `★${lbl}★`;
        });
        // 段落番号を 1-indexed で付与する。
        // docx: 各行 (= getMarkedDocumentTextWithSlots は段落単位で改行している)
        // xlsx: 各行 (= getXlsxMarkedTextWithSlots は行単位で改行)
        // 空行 (内容なし) は番号を付けない (= 段落 index には数えない)
        let lineCounter = 0;
        const markedText = markedTextRaw
          .split("\n")
          .map((line) => {
            if (line.trim().length === 0) return line; // empty lines kept as-is
            lineCounter++;
            return `段落${lineCounter}: ${line}`;
          })
          .join("\n");

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
    { "paragraphIndex": 11 },
    { "paragraphIndex": 12 }
  ],
  "inserts": [
    { "afterParagraphIndex": 10, "contents": ["新しい段落の本文 (★label★ 含めて OK)"] }
  ],
  "rewrites": [
    { "paragraphIndex": 23, "newText": "議案２　代表取締役選任の件" }
  ],
  "replaces": [
    { "anchor": "議案３", "replacement": "議案２" }
  ],
  "fills": {
    "★label★": "値"
  }
}
\`\`\`

## ルール (操作 5 種類)

**deletes**: 段落番号で削除。テンプレに \`段落11: 取締役 ★...★\` とあれば \`paragraphIndex: 11\`。
- **議案ブロック等の複数段落をまとめて消したい場合は、各段落の番号を全部列挙する** (例:
  議案2 ブロックが 段落14〜19 の 6 段落なら \`deletes\` に 6 件)

**inserts**: 指定段落の直後に新規段落を挿入。\`afterParagraphIndex: 10\` で段落 10 の直後に。
contents は段落単位の配列。各要素に ★label★ を含めて OK (後段の fills で値が入る)。

**rewrites**: 段落本文を丸ごと書き換え (フォント等は元のまま、テキストだけ差し替え)。
\`paragraphIndex\` で対象段落、\`newText\` で新しい本文。
- 議案番号繰り上げで見出し全体を書き換えるとき等に使う
  例: \`{ paragraphIndex: 23, newText: "議案２　代表取締役選任の件" }\`

**replaces**: 全文書から anchor 文字列を探して replacement に一括置換。
- 複数箇所に出てくる議案番号参照を全部書き換えるときに便利
  例: \`{ anchor: "議案３", replacement: "議案２" }\` で「議案３」を全部「議案２」に

**fills**: ★label★ マーカーを値で置換。
- キーは \`★label★\` の形式そのまま (★ で囲む)。値は最終形式 (令和8年5月29日 等)

## ルール (補助)

- 段落番号 (paragraphIndex / afterParagraphIndex) は **テンプレ本文の \`段落N:\` の数字**。1-indexed
- 不要な操作は省略可 (deletes: [], inserts: [] 等空配列で OK)
- JSON のみ返す (説明文不要)

## Phase 2 決定との対応 (必須)

「この書類向けの Phase 2 決定」の \`deletes\` に書かれている項目は **全件もれなく**
deletes に反映すること。件数を数えて一致を確認。
- Phase 2 deletes が「選任される取締役2の氏名」「選任される取締役3の氏名」「議案２...」の 3 項目
  → テンプレ本文から ★選任される取締役2の氏名★ / ★選任される取締役3の氏名★ / 議案2 ブロック
  が含まれる段落番号を全部見つけて deletes に積む

## 削除/追加の波及効果 (必須・自分でチェック)

delete / insert で構造を変えたら、テンプレ本文の他の場所も辻褄を合わせる:

1. **議案番号の繰り上げ**: 議案2 を削除 → 「議案３」「議案４」は「議案２」「議案３」に繰り上げ
   → \`replaces\` か \`rewrites\` で対応 (見出し丸ごとなら rewrites、本文中の参照なら replaces)
2. **項番の繰り上げ**: (1)(2)(3) や ア．イ．ウ． 等
3. **件数の修正**: 「取締役3名」→「取締役2名」等
4. **参照の整合**: 「上記○○」「下記○○」が指す先が削除されたら直す

deletes / inserts を決めた後、**テンプレ本文を頭から最後まで読み返して**、書き換える箇所を
全部 replaces / rewrites に積む。サーバは AI の指示通り動くだけ。AI が見落としたら書類が壊れる。`;

        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          temperature: 0,
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

        // AI が返した編集 JSON をログに残す (デバッグ用)
        console.log(
          `[produce-v2] ${f.name} edits summary:`,
          JSON.stringify({
            deletes: edits.deletes?.length ?? 0,
            inserts: edits.inserts?.length ?? 0,
            rewrites: edits.rewrites?.length ?? 0,
            replaces: edits.replaces?.length ?? 0,
            fills: Object.keys(edits.fills || {}).length,
          })
        );
        console.log(`[produce-v2] ${f.name} parsed edits FULL:`, JSON.stringify(edits, null, 2));
        console.log(`[produce-v2] ${f.name} AI raw response (first 2000 chars):`, aiText.slice(0, 2000));
        // デバッグ用に AI の生応答と edits を /tmp に保存 (後で内容を inspect できるように)
        try {
          const debugDir = path.join(process.cwd(), "data", "produce-v2-debug");
          await fs.mkdir(debugDir, { recursive: true });
          const slug = f.name.replace(/[^\w.\-]/g, "_");
          await fs.writeFile(
            path.join(debugDir, `${threadId}_${slug}.json`),
            JSON.stringify({ markedText, aiResponseText: aiText, parsedEdits: edits }, null, 2),
            "utf-8"
          );
        } catch (e) {
          console.warn("[produce-v2] debug write failed:", e instanceof Error ? e.message : e);
        }
        if (edits.deletes && edits.deletes.length > 0) {
          console.log(`[produce-v2] ${f.name} delete indices:`, edits.deletes.map((d) => d.paragraphIndex));
        }
        // Phase 2 の deletes 件数とマッチするかチェック (議案ブロック等は複数段落の可能性あり)
        const myDecisionForCheck = phase2Decisions.documents.find(
          (d) => d.templateFile === f.name || d.templateFile === f.name.replace(/\.[^.]+$/, "")
        );
        if (myDecisionForCheck && (edits.deletes?.length ?? 0) < myDecisionForCheck.deletes.length) {
          console.warn(
            `[produce-v2] ${f.name} delete count mismatch: Phase 2 says ${myDecisionForCheck.deletes.length}, AI returned ${edits.deletes?.length ?? 0}`,
            "Phase 2 deletes:",
            myDecisionForCheck.deletes.map((d) => d.block)
          );
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
