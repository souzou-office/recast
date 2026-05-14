// /api/document-templates/fill
//
// 新パイプラインの「入力」ステージ = 旧 structure-decide + produce を統合した 1 段。
// AI には ★ラベル★ 正規化されたテンプレ本文 + 案件整理 + Q&A を渡し、edit list
// (delete / modify / insert の 3 op だけ) を返してもらう。サーバーは edit-engine で
// 各テンプレ buffer に edit を適用するだけ。
//
// AI 視野からは slot 番号・要入力_N・docxtemplater 概念を一切排除。
// フォールバック保険 (件数検証 / 文脈ヒント / 単位重複除去 / 「削除と書かれた回答は埋めるな」など)
// は一切持たない。失敗したら applyEdits の skipped[] が返るだけで、後段の check が
// 読み直して追加 edit を出す前提。

import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
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
import { normalizeTemplate, type NormalizedTemplate } from "@/lib/template-normalize";
import { applyEdits, type Edit } from "@/lib/edit-engine";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

type ConfirmedAnswer = {
  placeholder: string;
  question: string;
  answer: string;
  options?: { label: string; source?: string }[];
};

export async function POST(request: NextRequest) {
  const {
    companyId,
    threadId,
    templateFolderPath,
    masterContent,
    confirmedAnswers,
  } = await request.json() as {
    companyId: string;
    threadId: string;
    templateFolderPath: string;
    masterContent?: string;
    confirmedAnswers?: ConfirmedAnswer[];
  };

  if (!companyId || !threadId || !templateFolderPath) {
    return new Response(JSON.stringify({ error: "companyId, threadId, templateFolderPath は必須" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return new Response(JSON.stringify({ error: "会社が見つかりません" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  const templateFiles = await readAllFilesInFolder(templateFolderPath);
  const docTemplates = templateFiles
    .filter(f => /\.(docx|doc|docm|xlsx|xls|xlsm)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  if (docTemplates.length === 0) {
    return new Response(JSON.stringify({ error: "テンプレが見つかりません" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // テンプレを ★ラベル★ 正規化
  type TemplateCtx = {
    fileName: string;
    path: string;
    buffer: Buffer;
    normalized: NormalizedTemplate;
  };
  const ctxs: TemplateCtx[] = [];
  for (const tf of docTemplates) {
    let buf: Buffer;
    try { buf = await fs.readFile(tf.path); } catch { continue; }
    // .doc/.docm は同名 .docx を試す (既存仕様)
    let workingBuf = buf;
    const ext = tf.name.toLowerCase().split(".").pop() || "";
    if (ext === "doc" || ext === "docm") {
      const altPath = tf.path.replace(/\.(doc|docm)$/i, ".docx");
      try { workingBuf = await fs.readFile(altPath); } catch { continue; }
    }
    const normalized = await normalizeTemplate(workingBuf, tf.name, tf.path);
    if (!normalized.markedText.trim()) continue;
    ctxs.push({ fileName: tf.name, path: tf.path, buffer: workingBuf, normalized });
  }
  if (ctxs.length === 0) {
    return new Response(JSON.stringify({ error: "★ マーク・プレースホルダーが見つかるテンプレがありません" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // 会話履歴ベースで AI に edit list を返してもらう
  let aiMessages = await loadAiMessages(company.id, threadId);
  if (!hasStage(aiMessages, "organize")) {
    return new Response(JSON.stringify({ error: "案件整理が完了していません" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  aiMessages = truncateBeforeStage(aiMessages, "fill");

  // Q&A
  const qaBlock = (confirmedAnswers || []).length === 0
    ? ""
    : `\n## ユーザー確定回答 (clarify)\n${(confirmedAnswers || []).map(qa =>
        `- 【${qa.placeholder}】\n  Q: ${qa.question || "(質問文なし)"}\n  A: ${qa.answer}`
      ).join("\n")}\n`;

  // 基本情報 (構造化 JSON があれば添付)
  const profileBlock = company.profile?.structured
    ? `\n## 会社の基本情報 (静的事実)\n\`\`\`json\n${JSON.stringify(company.profile.structured, null, 2)}\n\`\`\`\n`
    : "";

  // 案件整理 (ユーザー編集分があれば最新で上書き)
  const masterBlock = masterContent
    ? `\n## 案件整理 (最新)\n${masterContent}\n`
    : "";

  // 各テンプレ本文 + そのテンプレに含まれる ★…★ 文字列の完全一覧
  // AI は「テンプレ本文の ★…★ をリテラルでコピペして find に書く」前提。
  // 一覧を補助として提示するが、本文中の ★…★ をそのまま使うのが基本。
  const templateBlock = ctxs.map(c => {
    const markers = Array.from(c.normalized.markerToSlots.keys());
    const markersBlock = markers.length > 0
      ? `\n**このテンプレに含まれる ★…★ 文字列 (replace の find は必ずこの中の文字列をそのままコピペ)**\n${markers.map(m => `- \`${m}\``).join("\n")}`
      : "";
    return `### ${c.fileName}\n\`\`\`\n${c.normalized.markedText}\n\`\`\`\n${markersBlock}\n`;
  }).join("\n");

  const userTurnText = `## あなたが今やること (ターン: 入力)

これまでの会話 (案件整理・確認質問の回答) と、下に示すテンプレ本文を踏まえて、各書類に必要な編集オペレーションを JSON で返してください。

## 編集オペレーション (3 種類だけ)

出力は \`{ "documents": [{ "fileName": ..., "edits": [...] }] }\` の形式。各 edit は次のどれか:

### replace (テンプレ本文の ★…★ を値で置換)
- \`{ "op": "replace", "find": "★同意書の日付★", "replaceWith": "令和８年５月２８日", "reason"?: "..." }\`
- \`find\` は **テンプレ本文に書かれている ★…★ の文字列をそのままリテラルでコピペ** (★ も含めて完全一致)
- 同じ ★…★ が複数箇所に出ていれば、サーバーが**全箇所**を同じ値で置換する
- 値が**不明 / 案件に該当なし** の slot は **空文字 \`""\`** で返してよい

### delete (テンプレ範囲を削除)
- \`{ "op": "delete", "anchor": "議案２（取締役の報酬に関する件）", "endAnchor": "議案３", "reason": "今回は無報酬のため議案2 ブロックごと削除" }\`
- \`anchor\` を含む段落から、\`endAnchor\` を含む段落の**直前**までを丸ごと削除する
- 議案ブロック / 該当なしのセクション / 不要な但し書きをまとめて消すのに使う
- \`endAnchor\` は省略可だが、省略すると anchor 以降文書末尾まで消えるので**極力指定**すること

### insert (既存パターンを複製して追加)
- \`{ "op": "insert", "copyFromAnchor": "代表取締役 ★代表取締役の氏名★", "copyFromEndAnchor": "代表取締役 ★代表取締役の氏名★", "insertAfterAnchor": "代表取締役 ★代表取締役の氏名★", "replaces": [{ "find": "★代表取締役の氏名★", "replaceWith": "山田太郎" }], "reason": "代表取締役が 2 名" }\`
- テンプレ内の既存パターン段落 (anchor〜endAnchor) を 1 ユニットとして複製し、\`insertAfterAnchor\` の段落の直後に貼る
- \`replaces\` は複製ユニット内の ★…★ を埋めるための find/replaceWith リスト
- **AI が自由に作文することは禁止**。複製元はテンプレに既に存在する段落だけ

## 🔴 絶対に守るべきルール (違反すると edit がスキップされる)

1. **★…★ で表記された箇所以外は触らない**。法的文言を勝手に整えるのは禁止。

2. **\`find\` は「このテンプレに含まれる ★…★ 文字列」リストから**完全一致でコピペ。**言い換え・短縮・要約は禁止**。
   - ❌ テンプレが \`★同意書の日付★\` なのに \`"find": "★株主の同意日★"\` と書く → 一致せずスキップ
   - ❌ テンプレが \`★同意書の日付★\` なのに \`"find": "同意書の日付"\` (★抜き) と書く → 一致せずスキップ
   - ✅ \`"find": "★同意書の日付★"\` (★含めてリテラル一致)

2-A. **🔴 「このテンプレに含まれる ★…★ 文字列」リストの全件に対して replace を必ず出すこと**。
   - 未出力 = 「前案件の値が新書類に残る」事故が起きる (安全網で空文字化されるので最低限ユーザーは気付くが、補完すべき)
   - 値が**不明 / 該当なし** の slot は **必ず \`"replaceWith": ""\`** を出す (削除指示としても兼用)
   - delete で消すブロック内の ★…★ は replace 不要 (削除されるので)

3. **insert の \`copyFromAnchor\` / \`copyFromEndAnchor\` / \`insertAfterAnchor\` は、テンプレ本文 (★…★ 入り) に書かれた文字列そのまま** を使うこと
   - ❌ 「イ．支給開始時期：支給なしより」(値が埋まった後の想像) → テンプレに無いので skip
   - ✅ 「イ．支給開始時期：★支給開始時期★」(テンプレ原文のまま) → ヒットする

4. **削除指示の回答 (例: 「議案2 自体を削除」「報酬なし」) は delete op で表現**。replace の replaceWith に「【議案2 削除】」のような指示語を流し込むな。

5. **不明な値は空文字 replace** で返す (\`replaceWith: ""\`)。チェック段階で AI が読み直して埋めるか、ユーザー手動修正に倒す。

6. **複数書類間で同じ意味の値は揃える** (同じ ★…★ がサーバー側で同じ値で置換されるので、書類間の不一致は構造的に発生しないはず)。

7. **議案番号の繰り上げ**: 議案2 を delete したら、議案3 のラベルを議案2 に変える必要があるなら **replace か delete + insert で表現** すること。サーバーは自動で繰り上げない。

${profileBlock}${masterBlock}${qaBlock}

## 各テンプレ本文 (★ラベル★ 形式)

${templateBlock}

上記をもとに JSON のみ返してください。書類リストは網羅的に。

\`\`\`json
{
  "documents": [
    {
      "fileName": "1.取締役決定書.docx",
      "edits": [
        { "op": "replace", "find": "★作成日★", "replaceWith": "令和８年５月２１日" },
        { "op": "replace", "find": "★代表取締役の氏名★", "replaceWith": "三上春香" },
        { "op": "delete", "anchor": "議案２（取締役の報酬に関する件）", "endAnchor": "議案３", "reason": "今回は無報酬" }
      ]
    }
  ]
}
\`\`\``;

  const messagesWithUserTurn = appendUserTurn(aiMessages, userTurnText, "fill");

  let aiResponseText = "";
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: toAnthropicMessages(messagesWithUserTurn) as Anthropic.MessageParam[],
    });
    logTokenUsage("/api/document-templates/fill", MODEL, response.usage);
    aiResponseText = response.content[0].type === "text" ? response.content[0].text : "";
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "AI 呼び出しに失敗" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // 会話保存
  const finalMessages = appendAssistantTurn(messagesWithUserTurn, aiResponseText, "fill");
  await saveAiMessages(company.id, threadId, finalMessages);

  // 🔍 DEBUG: AI 応答とサーバー側の期待値を突き合わせるためのログ
  console.log("[fill/debug] === markers per template (サーバーが期待する find 文字列) ===");
  for (const ctx of ctxs) {
    const markers = Array.from(ctx.normalized.markerToSlots.keys());
    console.log(`[fill/debug] ${ctx.fileName} (${markers.length} markers):`);
    for (const m of markers) console.log(`[fill/debug]   ${JSON.stringify(m)}`);
  }
  console.log("[fill/debug] === AI raw response (先頭 3000 文字) ===");
  console.log(aiResponseText.substring(0, 3000));
  console.log("[fill/debug] === END ===");

  // edit list パース
  const editsByFile = parseEditsResponse(aiResponseText);

  // 各テンプレに edit を適用
  type DocOut = {
    fileName: string;
    docxBase64: string;
    previewHtml: string;
    appliedCount: number;
    skipped: { reason: string }[];
    edits: Edit[];
  };
  const docs: DocOut[] = [];
  for (const ctx of ctxs) {
    const edits = editsByFile.get(ctx.fileName) || [];
    const result = await applyEdits(ctx.buffer, ctx.fileName, ctx.normalized, edits);
    let previewHtml = "";
    const ext = (ctx.fileName.split(".").pop() || "").toLowerCase();
    if (ext === "docx" || ext === "docm") {
      try {
        const h = await mammoth.convertToHtml({ buffer: result.buffer });
        previewHtml = h.value || "";
      } catch { /* ignore */ }
    }
    docs.push({
      fileName: ctx.fileName,
      docxBase64: result.buffer.toString("base64"),
      previewHtml,
      appliedCount: result.applied.length,
      skipped: result.skipped.map(s => ({ reason: s.reason })),
      edits,
    });
  }

  return new Response(JSON.stringify({ documents: docs }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

// AI 応答から { documents: [{ fileName, edits }] } を取り出す
function parseEditsResponse(text: string): Map<string, Edit[]> {
  const map = new Map<string, Edit[]>();
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return map;
  try {
    const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]) as { documents?: { fileName?: string; edits?: unknown[] }[] };
    for (const d of parsed.documents || []) {
      if (!d.fileName || !Array.isArray(d.edits)) continue;
      const valid: Edit[] = [];
      for (const e of d.edits) {
        if (!e || typeof e !== "object") continue;
        const obj = e as Record<string, unknown>;
        if (obj.op === "replace" && typeof obj.find === "string" && typeof obj.replaceWith === "string") {
          valid.push({ op: "replace", find: obj.find, replaceWith: obj.replaceWith, reason: typeof obj.reason === "string" ? obj.reason : undefined });
        } else if (obj.op === "delete" && typeof obj.anchor === "string") {
          valid.push({ op: "delete", anchor: obj.anchor, endAnchor: typeof obj.endAnchor === "string" ? obj.endAnchor : undefined, reason: typeof obj.reason === "string" ? obj.reason : undefined });
        } else if (obj.op === "insert" && typeof obj.copyFromAnchor === "string" && typeof obj.copyFromEndAnchor === "string" && typeof obj.insertAfterAnchor === "string" && Array.isArray(obj.replaces)) {
          const replaces = (obj.replaces as unknown[]).filter((f): f is { find: string; replaceWith: string } =>
            !!f && typeof f === "object" && typeof (f as Record<string, unknown>).find === "string" && typeof (f as Record<string, unknown>).replaceWith === "string"
          );
          valid.push({
            op: "insert",
            copyFromAnchor: obj.copyFromAnchor,
            copyFromEndAnchor: obj.copyFromEndAnchor,
            insertAfterAnchor: obj.insertAfterAnchor,
            replaces,
            reason: typeof obj.reason === "string" ? obj.reason : undefined,
          });
        }
      }
      map.set(d.fileName, valid);
    }
  } catch { /* parse failure → empty map */ }
  return map;
}
