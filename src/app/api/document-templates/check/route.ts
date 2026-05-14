// /api/document-templates/check
//
// 新パイプラインの「チェック」ステージ = 旧 verify + proofread を統合した 1 段。
// 生成済み書類本文を AI に読み直してもらい、不整合があれば fill と同じ 3 op
// (delete / modify / insert) の追加 edit list を返してもらう。
// サーバーは追加 edit を edit-engine で適用するだけ。
//
// クライアントが「収束するまで繰り返す」のループ駆動を行う前提:
//   - check が空 edit list を返したら停止
//   - 全 edit が skip だったら停止
//   - 上限回数 (クライアントが制御) で打ち切り
//
// AI には**前ターンの fill の出力 + 適用結果 + 現状の書類本文**を渡し、追加修正だけを書かせる。

import { NextRequest } from "next/server";
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
import { normalizeTemplate, type NormalizedTemplate } from "@/lib/template-normalize";
import { applyEdits, type Edit } from "@/lib/edit-engine";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx");

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

interface CheckRequestDoc {
  fileName: string;
  docxBase64: string;
  templatePath?: string; // 元テンプレファイルパス (★ 正規化に必要)
}

export async function POST(request: NextRequest) {
  const {
    companyId,
    threadId,
    documents,
  } = await request.json() as {
    companyId: string;
    threadId: string;
    documents: CheckRequestDoc[];
  };

  if (!companyId || !threadId || !documents || documents.length === 0) {
    return new Response(JSON.stringify({ error: "companyId, threadId, documents が必須" }), {
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

  // 各書類の本文をテキスト抽出 (mammoth / xlsx)
  type DocCtx = {
    fileName: string;
    buffer: Buffer;
    text: string;
    templatePath?: string;
    normalized?: NormalizedTemplate;
  };
  const docCtxs: DocCtx[] = [];
  for (const d of documents) {
    const buf = Buffer.from(d.docxBase64, "base64");
    let text = "";
    const ext = (d.fileName.split(".").pop() || "").toLowerCase();
    try {
      if (ext === "xlsx" || ext === "xlsm" || ext === "xls") {
        const wb = XLSX.read(buf, { type: "buffer" });
        const parts: string[] = [];
        for (const sheetName of wb.SheetNames) {
          const sheet = wb.Sheets[sheetName];
          const csv: string = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
          if (csv.trim()) parts.push(`[シート: ${sheetName}]\n${csv}`);
        }
        text = parts.join("\n\n").trim();
      } else {
        const r = await mammoth.extractRawText({ buffer: buf });
        text = (r.value || "").trim();
      }
    } catch { text = ""; }

    // 追加 edit を適用するには normalize が必要。templatePath が来ていればそれを使う。
    // ただし check はチェック専用で、ここで edit を適用するかどうかはレスポンス受取側 (ChatWorkflow)
    // が判断する。サーバーはまず edit list を AI から取って返すだけ。
    let normalized: NormalizedTemplate | undefined;
    if (d.templatePath) {
      try {
        normalized = await normalizeTemplate(buf, d.fileName, d.templatePath);
      } catch { /* ignore */ }
    }

    docCtxs.push({ fileName: d.fileName, buffer: buf, text, templatePath: d.templatePath, normalized });
  }

  // 会話履歴
  let aiMessages = await loadAiMessages(company.id, threadId);
  if (!hasStage(aiMessages, "fill")) {
    return new Response(JSON.stringify({ error: "入力 (fill) ステージが完了していません" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  aiMessages = truncateBeforeStage(aiMessages, "check");

  // 生成書類本文 + 残っている ★…★ 文字列一覧 (replace の find 候補)
  const docBlock = docCtxs.map(d => {
    const markers = d.normalized ? Array.from(d.normalized.markerToSlots.keys()) : [];
    const markersBlock = markers.length > 0
      ? `\n**まだ残っている ★…★ 文字列 (replace の find はここからリテラルコピペ)**\n${markers.map(m => `- \`${m}\``).join("\n")}`
      : "\n(★…★ は全て埋まっている)";
    return `### ${d.fileName}\n\`\`\`\n${d.text || "(本文抽出失敗)"}\n\`\`\`${markersBlock}\n`;
  }).join("\n");

  const userTurnText = `## あなたが今やること (ターン: チェック)

これまでの会話 (案件整理・Q&A・入力ステージで出した edit) を踏まえて、生成された書類を読み直し、不整合や未完成箇所があれば**追加の編集オペレーション**を返してください。

## チェック観点

- **未埋めの ★…★**: 入力ステージで埋めそこなった slot が残っていないか
- **不要な残骸**: 削除し忘れたブロック (空欄段落 / 「議案2 削除」のような不完全な文)
- **書類間の不一致**: 同じ意味の値が書類によって違っていないか (氏名・日付・住所・金額・株数)
- **議案番号の繰り上げ**: 議案2 を削除した場合、後続「議案3」を「議案2」に書き換えるべきか
- **法的文言の致命的誤り**: 致命的な誤記、登記が通らない可能性のある記載

## 返す edit は入力ステージと**同じ 3 op**

- \`replace\`: \`{ "op": "replace", "find": "★ラベル★", "replaceWith": "..." }\`
  - **find はまだ残っている ★…★ 文字列の中からリテラルコピペ**。
  - check 段階では ★…★ が既に値に置換済みのことが多い → その場合は replace で書き換え不可。delete で行/段落を消して、insert で正しい行を入れ直す等で対応。
- \`delete\`: \`{ "op": "delete", "anchor": "...", "endAnchor": "..." }\`
- \`insert\`: 既存パターン複製。replaces で ★…★ を埋めて挿入。

## 守るべきルール

1. **問題が無ければ \`{ "documents": [] }\`** を返す。これで収束。
2. **確信のないものは出さない**。チェック上限ラウンド (3 回) があるので、ループを回すために無理に edit を出す必要はない。
3. **同じ問題を繰り返し指摘しない** (前ラウンドで skip された edit と同じ anchor で再試行するのは無意味)。

## 現状の各書類本文

${docBlock}

JSON のみ返答。

\`\`\`json
{
  "documents": [
    {
      "fileName": "1.取締役決定書.docx",
      "edits": [
        { "op": "delete", "anchor": "...", "endAnchor": "...", "reason": "..." }
      ]
    }
  ]
}
\`\`\``;

  const messagesWithUserTurn = appendUserTurn(aiMessages, userTurnText, "check");

  let aiResponseText = "";
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: toAnthropicMessages(messagesWithUserTurn) as Anthropic.MessageParam[],
    });
    logTokenUsage("/api/document-templates/check", MODEL, response.usage);
    // 旧実装は `response.content[0]` だけ見ていて取りこぼしバグがあった (fill route と同じ)
    aiResponseText = response.content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text : "")
      .join("");
    console.log("[check/debug] response.content block types:", response.content.map(b => b.type).join(", "));
    console.log("[check/debug] response stop_reason:", response.stop_reason);
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "AI 呼び出しに失敗" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // 会話保存
  const finalMessages = appendAssistantTurn(messagesWithUserTurn, aiResponseText, "check");
  await saveAiMessages(company.id, threadId, finalMessages);

  const editsByFile = parseCheckResponse(aiResponseText);

  // 提案された追加 edit を即適用 (templatePath があれば normalize あり)
  type DocOut = {
    fileName: string;
    docxBase64: string;
    previewHtml: string;
    appliedCount: number;
    skipped: { reason: string }[];
    proposedEdits: Edit[];
    hasIssues: boolean;
  };
  const docs: DocOut[] = [];
  for (const ctx of docCtxs) {
    const proposed = editsByFile.get(ctx.fileName) || [];
    let result: { buffer: Buffer; applied: number[]; skipped: { reason: string }[] };
    if (proposed.length > 0 && ctx.normalized) {
      const r = await applyEdits(ctx.buffer, ctx.fileName, ctx.normalized, proposed);
      result = { buffer: r.buffer, applied: r.applied, skipped: r.skipped.map(s => ({ reason: s.reason })) };
    } else {
      result = { buffer: ctx.buffer, applied: [], skipped: [] };
    }
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
      skipped: result.skipped,
      proposedEdits: proposed,
      hasIssues: proposed.length > 0,
    });
  }

  // 全書類で hasIssues が false ならクライアントはループを止める
  const converged = docs.every(d => !d.hasIssues);

  return new Response(JSON.stringify({ documents: docs, converged }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

function parseCheckResponse(text: string): Map<string, Edit[]> {
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
  } catch { /* ignore */ }
  return map;
}
