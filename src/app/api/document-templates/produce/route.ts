import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { logTokenUsage } from "@/lib/token-logger";
import fs from "fs/promises";
import {
  loadAiMessages,
  saveAiMessages,
  truncateBeforeStage,
  appendUserTurn,
  appendAssistantTurn,
  toAnthropicMessages,
  hasStage,
} from "@/lib/case-conversation";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Docxtemplater = require("docxtemplater");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

/**
 * 書類のスロット値生成 = 「1案件1会話」のターン3。
 *
 * 旧設計: 書類ごとに独立した AI 呼び出しをしていた。
 *   produce 自身も「代表取締役は誰か」を毎ファイル独立判断していたためブレが出た。
 * 新設計: ターン3で 1 回だけ Claude を呼び、全書類の全スロット値を per-doc JSON で返してもらう。
 *   Claude はターン1（organize）・ターン2（clarify）の自分の判断を覚えているので、書類間で一貫した値が出る。
 *
 * ファイル置換（docx/xlsx XML 操作）は決定的処理として AI の外で実行する。
 */

// --- ヘルパー ---

function extractPlaceholders(text: string): { raw: string; name: string; delimiters: [string, string] }[] {
  const patterns = [
    { regex: /【([^】]+)】/g, start: "【", end: "】" },
    { regex: /\{\{([^}]+)\}\}/g, start: "{{", end: "}}" },
    { regex: /｛｛([^｝]+)｝｝/g, start: "｛｛", end: "｝｝" },
    { regex: /＜([^＞]+)＞/g, start: "＜", end: "＞" },
    { regex: /［([^\］]+)］/g, start: "［", end: "］" },
  ];
  const found = new Map<string, { raw: string; name: string; delimiters: [string, string] }>();
  for (const p of patterns) {
    let m;
    while ((m = p.regex.exec(text)) !== null) {
      const name = m[1].trim();
      if (name.startsWith("#") || name.startsWith("/")) continue;
      if (!found.has(name)) {
        found.set(name, { raw: m[0], name, delimiters: [p.start, p.end] });
      }
    }
  }
  return Array.from(found.values());
}

function extractConditionFlags(text: string): string[] {
  const flags = new Set<string>();
  const patterns = [
    /\{\{#([^}\/]+)\}\}/g,
    /｛｛#([^｝\/]+)｝｝/g,
    /【#([^】\/]+)】/g,
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(text)) !== null) flags.add(m[1].trim());
  }
  return Array.from(flags);
}

function toFullWidth(str: string): string {
  return str.replace(/[A-Za-z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
}

function toHalfWidth(str: string): string {
  // 改行を含む値（複数行セル）は行ごとに処理して整合をとる
  if (/\r?\n/.test(str)) {
    return str.split(/(\r?\n)/).map(part => /\r?\n/.test(part) ? part : toHalfWidth(part)).join("");
  }
  let result = str
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, ".").replace(/，/g, ",").replace(/－/g, "-").replace(/＋/g, "+")
    .replace(/（/g, "(").replace(/）/g, ")").replace(/％/g, "%").replace(/＆/g, "&")
    .replace(/　/g, " ");
  const trimmed = result.trim();
  const isPureNumber = /^-?[\d,]+(\.\d+)?$/.test(trimmed);
  // 「日付値」とみなすのは、その行の主要部分が日付パターンの場合のみ
  // 「令和X年X月X日」「2025年X月X日」「X月X日」「YYYY-MM-DD」など
  // 行内に他の文字（会社名、氏名、住所等）が混ざってるときは日付扱いしない
  const isDateOnly =
    /^(?:令和|平成|昭和|大正|明治|西暦)?\d{1,4}年\d{1,2}月\d{1,2}日$/.test(trimmed) ||
    /^\d{1,2}月\d{1,2}日$/.test(trimmed) ||
    /^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed);
  if (isDateOnly) {
    result = result.replace(/[0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
  } else if (!isPureNumber) {
    result = result.replace(/[A-Za-z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
  }
  return result;
}

const TRAILING_UNIT_RE = /[個日月年円様殿株名通時分秒歳枚件回点本冊行]/;
function stripDuplicatedUnit(value: string, key: string, templateContent: string): string {
  if (!value) return value;
  const placeholders = [`【${key}】`, `{{${key}}}`, `｛｛${key}｝｝`];
  let trailingUnit: string | null = null;
  let consistent = true;
  for (const ph of placeholders) {
    let pos = templateContent.indexOf(ph);
    while (pos !== -1) {
      const next = templateContent[pos + ph.length];
      if (next && TRAILING_UNIT_RE.test(next)) {
        if (trailingUnit === null) trailingUnit = next;
        else if (trailingUnit !== next) { consistent = false; break; }
      }
      pos = templateContent.indexOf(ph, pos + 1);
    }
    if (!consistent) break;
  }
  if (consistent && trailingUnit && value.endsWith(trailingUnit)) {
    return value.slice(0, -trailingUnit.length);
  }
  return value;
}

// テンプレ別の .labels.json を読む（slotId → ラベル情報）
async function loadSlotLabelsFor(templateFilePath: string): Promise<Map<number, { label: string; format: string; sourceHint?: string }>> {
  const map = new Map<number, { label: string; format: string; sourceHint?: string }>();
  try {
    const raw = await fs.readFile(templateFilePath + ".labels.json", "utf-8");
    const parsed = JSON.parse(raw) as { slots?: { slotId: number; label: string; format: string; sourceHint?: string }[] };
    for (const s of parsed.slots || []) {
      map.set(s.slotId, { label: s.label, format: s.format, sourceHint: s.sourceHint });
    }
  } catch { /* .labels.json が無ければ空マップ */ }
  return map;
}

// --- メイン ---

type FilledSlotOut = { slotId: number; label: string; value: string; format?: string; sourceHint?: string; copyIndex?: number };
type DocOut = { name: string; docxBase64: string; previewHtml: string; fileName: string; templatePath?: string; filledSlots?: FilledSlotOut[] };

type AnalysisHighlightDocx = {
  kind: "highlight-docx";
  file: { name: string; path: string; content: string };
  baseName: string;
  ext: "docx" | "doc" | "docm";
  workingBuffer: Buffer;
  rawBuffer: Buffer;
  docSlots: Map<number, string>;
  markedDocText: string;
  slotLabels: Map<number, { label: string; format: string; sourceHint?: string }>;
};
type AnalysisHighlightXlsx = {
  kind: "highlight-xlsx";
  file: { name: string; path: string; content: string };
  baseName: string;
  workingBuffer: Buffer;
  xlSlots: Map<number, string>;
  xlMarkedText: string;
  slotLabels: Map<number, { label: string; format: string; sourceHint?: string }>;
};
type AnalysisPlaceholderDocx = {
  kind: "placeholder-docx";
  file: { name: string; path: string; content: string };
  baseName: string;
  ext: "docx" | "doc" | "docm";
  rawBuffer: Buffer;
  placeholders: string[];
};
type AnalysisPlaceholderXlsx = {
  kind: "placeholder-xlsx";
  file: { name: string; path: string; content: string };
  baseName: string;
  rawBuffer: Buffer;
  placeholders: string[];
};
type DocAnalysis = AnalysisHighlightDocx | AnalysisHighlightXlsx | AnalysisPlaceholderDocx | AnalysisPlaceholderXlsx;

export async function POST(request: NextRequest) {
  const { companyId, templateFolderPath, mode, masterContent: directMasterContent, confirmedAnswers: rawConfirmedAnswers, threadId } = await request.json() as {
    companyId: string;
    templateFolderPath: string;
    mode?: "fill" | "generate";
    masterContent?: string;
    confirmedAnswers?:
      | Record<string, string>
      | { placeholder: string; question: string; answer: string; options?: { label: string; source?: string }[] }[];
    folderPath?: string;
    disabledFiles?: string[];
    threadId?: string;
  };

  if (!threadId) {
    return new Response(JSON.stringify({ error: "threadId が必要です" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // 旧形式 → 新形式に正規化
  type QAEntry = { placeholder: string; question: string; answer: string; options?: { label: string; source?: string }[] };
  const confirmedQA: QAEntry[] = Array.isArray(rawConfirmedAnswers)
    ? rawConfirmedAnswers
    : rawConfirmedAnswers && typeof rawConfirmedAnswers === "object"
      ? Object.entries(rawConfirmedAnswers).map(([placeholder, answer]) => ({
          placeholder, question: "", answer: String(answer),
        }))
      : [];

  const renderQABlock = (): string => {
    if (confirmedQA.length === 0) return "";
    const lines = confirmedQA.map(qa => {
      const q = qa.question ? `Q: ${qa.question}` : "";
      const a = `A: ${qa.answer}`;
      return `- 【${qa.placeholder}】\n  ${q ? q + "\n  " : ""}${a}`;
    });
    return `\n## ユーザー確定済みの質問と回答（これらは絶対にこの値を使う。再解釈しない）\n${lines.join("\n")}\n`;
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return new Response(JSON.stringify({ error: "会社が見つかりません" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  const templateFiles = await readAllFilesInFolder(templateFolderPath);
  if (templateFiles.length === 0) {
    return new Response(JSON.stringify({ error: "テンプレートフォルダにファイルがありません" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // generate モード（テンプレ無しの全文生成）は会話化対象外。今回は呼ばれない想定だが、安全弁で残す。
  if (mode === "generate") {
    return new Response(JSON.stringify({ error: "generate モードは現在の会話化フローでは未対応" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const docxFilesAll = templateFiles.filter(f => /\.(docx|doc|docm|xlsx|xls)$/i.test(f.name));
  if (docxFilesAll.length === 0) {
    return new Response(JSON.stringify({ error: "テンプレートに置換可能なファイルがありません" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // ファイル名順にソート（番号順 = 手続き順）
  docxFilesAll.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));

  // --- 1) 各テンプレを解析: ハイライト方式 / プレースホルダー方式 のどちらか ---
  const { extractMarkedFields, replaceMarkedFields, getMarkedDocumentTextWithSlots } = await import("@/lib/docx-marker-parser");
  const { extractXlsxMarkedCells, replaceXlsxMarkedCells, getXlsxMarkedTextWithSlots, expandYellowRowBlock } = await import("@/lib/xlsx-marker-parser");

  const analyses: DocAnalysis[] = [];

  for (const df of docxFilesAll) {
    const ext = df.name.toLowerCase().split(".").pop() || "";
    const baseName = df.name.replace(/\.[^.]+$/, "");
    let rawBuffer: Buffer;
    try {
      rawBuffer = await fs.readFile(df.path);
    } catch {
      console.warn(`[produce] cannot read ${df.path}`);
      continue;
    }

    if (ext === "xlsx" || ext === "xls" || ext === "xlsm") {
      // Excel: プレースホルダー優先、無ければハイライト
      const xlPlaceholders = extractPlaceholders(df.content);
      if (xlPlaceholders.length > 0) {
        analyses.push({
          kind: "placeholder-xlsx",
          file: { name: df.name, path: df.path, content: df.content },
          baseName,
          rawBuffer,
          placeholders: xlPlaceholders.map(p => p.name),
        });
        continue;
      }
      // ハイライト方式
      try {
        // 行ブロック拡張: 株主リスト等で「マーカー付き行が足りない場合」に最終行を複製する。
        // 旧: 全配列の最大長 (Math.max(events, 株主, 役員, ...)) を使っていたため、事業目的6項目が
        //     2人株主の株主リストに 6 行分の Deep30 コピーを生成 → SI キー衝突で空欄化バグ。
        // 新: 「株主」「役員」など、テンプレ名に対応する配列だけを使う保守的な方針に変更。
        //     対応が分からない場合は拡張しない（テンプレで予め十分な行数を用意しておく前提）。
        const structured = (company.profile?.structured || {}) as Record<string, unknown>;
        const lowerName = df.name.toLowerCase();
        const baseLowerName = baseName.toLowerCase();
        let desiredRows = 0;
        const findArrayByKeyword = (keywords: string[]): number => {
          for (const [k, v] of Object.entries(structured)) {
            if (!Array.isArray(v) || v.length < 2) continue;
            if (keywords.some(kw => k.includes(kw))) return v.length;
          }
          return 0;
        };
        if (lowerName.includes("株主") || baseLowerName.includes("株主")) {
          desiredRows = findArrayByKeyword(["株主", "発起人"]);
        } else if (lowerName.includes("役員") || baseLowerName.includes("役員") || lowerName.includes("取締役")) {
          desiredRows = findArrayByKeyword(["役員", "取締役"]);
        }
        // それ以外のテンプレでは拡張しない（既存テンプレの行数を信じる）
        let workingBuffer: Buffer = rawBuffer;
        if (desiredRows > 0) {
          const expanded = expandYellowRowBlock(rawBuffer, desiredRows);
          if (expanded !== rawBuffer) workingBuffer = expanded;
        }

        const cells = extractXlsxMarkedCells(workingBuffer);
        if (cells.length === 0) continue; // 何も無ければスキップ

        const { text: xlMarkedText, slots: xlSlots } = getXlsxMarkedTextWithSlots(workingBuffer);
        const slotLabels = await loadSlotLabelsFor(df.path);

        analyses.push({
          kind: "highlight-xlsx",
          file: { name: df.name, path: df.path, content: df.content },
          baseName,
          workingBuffer,
          xlSlots,
          xlMarkedText,
          slotLabels,
        });
      } catch (e) {
        console.warn(`[produce] xlsx analyze failed ${df.name}:`, e instanceof Error ? e.message : e);
      }
      continue;
    }

    // Word: doc/docm の場合は同名 .docx を試す（既存仕様）
    let workingBuffer = rawBuffer;
    if (ext === "doc" || ext === "docm") {
      const docxPath = df.path.replace(/\.(doc|docm)$/i, ".docx");
      try {
        workingBuffer = await fs.readFile(docxPath);
      } catch {
        // .docx が無ければスキップ
        continue;
      }
    }

    // プレースホルダー優先、無ければハイライト
    const placeholders = extractPlaceholders(df.content);
    if (placeholders.length > 0) {
      analyses.push({
        kind: "placeholder-docx",
        file: { name: df.name, path: df.path, content: df.content },
        baseName,
        ext: ext as "docx" | "doc" | "docm",
        rawBuffer: workingBuffer,
        placeholders: placeholders.map(p => p.name),
      });
      continue;
    }
    // ハイライト方式
    try {
      const markedFields = extractMarkedFields(workingBuffer);
      if (markedFields.length === 0) continue;
      const { text: markedDocText, slots: docSlots } = getMarkedDocumentTextWithSlots(workingBuffer);
      const slotLabels = await loadSlotLabelsFor(df.path);
      analyses.push({
        kind: "highlight-docx",
        file: { name: df.name, path: df.path, content: df.content },
        baseName,
        ext: ext as "docx" | "doc" | "docm",
        workingBuffer,
        rawBuffer,
        docSlots,
        markedDocText,
        slotLabels,
      });
    } catch (e) {
      console.warn(`[produce] docx analyze failed ${df.name}:`, e instanceof Error ? e.message : e);
    }
  }

  if (analyses.length === 0) {
    return new Response(JSON.stringify({ error: "解析できるテンプレートがありません" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // --- 2) 会話履歴ベースで AI に「全書類の全スロット値」を一括で返してもらう ---
  let aiMessages = await loadAiMessages(company.id, threadId);
  if (!hasStage(aiMessages, "organize")) {
    return new Response(JSON.stringify({ error: "案件整理（ターン1）が完了していません" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  // produce 再実行時は produce より後のターンを切り戻す
  aiMessages = truncateBeforeStage(aiMessages, "produce");

  // 共通ルールはターン1で渡している前提だが、最新の masterContent (案件整理の編集後) があれば
  // ここで参考として再注入する（編集を反映させるため）
  const masterUpdateBlock = directMasterContent
    ? `\n## 案件整理の最新版（ユーザーが編集した可能性あり、こちらを優先）\n${directMasterContent}\n`
    : "";

  // 各書類の slot 一覧をプロンプトに明示する（ターン1で見せたが、ここで再掲することで「キーの形式」を固定）
  // **前案件の値は出さない**。AI が前案件の値に引きずられて同じ値を返すのを防ぐため、
  // ラベル・形式・出典候補だけ載せる。元の値の参照は produce 側の決定的処理で内部的にやる。
  const docPromptLines: string[] = [];
  for (const a of analyses) {
    docPromptLines.push(`### ${a.file.name}`);
    if (a.kind === "highlight-docx") {
      for (const [slotId] of a.docSlots) {
        const meta = a.slotLabels.get(slotId);
        const labelPart = meta?.label ? ` — ${meta.label}` : "";
        const formatPart = meta?.format ? ` 形式: ${meta.format}` : "";
        const sourcePart = meta?.sourceHint ? ` 出典候補: ${meta.sourceHint}` : "";
        docPromptLines.push(`- 要入力_${slotId}${labelPart}${formatPart}${sourcePart}`);
      }
    } else if (a.kind === "highlight-xlsx") {
      for (const [slotId] of a.xlSlots) {
        const meta = a.slotLabels.get(slotId);
        const labelPart = meta?.label ? ` — ${meta.label}` : "";
        const formatPart = meta?.format ? ` 形式: ${meta.format}` : "";
        const sourcePart = meta?.sourceHint ? ` 出典候補: ${meta.sourceHint}` : "";
        docPromptLines.push(`- 要入力_${slotId}${labelPart}${formatPart}${sourcePart}`);
      }
    } else {
      // placeholder
      for (const ph of a.placeholders) {
        docPromptLines.push(`- ${ph}`);
      }
    }
    docPromptLines.push("");
  }

  // 条件分岐フラグ（{{#flag}}...{{/flag}}）の収集
  const allConditionFlags = new Set<string>();
  for (const a of analyses) {
    if (a.kind === "placeholder-docx" || a.kind === "placeholder-xlsx") {
      for (const f of extractConditionFlags(a.file.content)) allConditionFlags.add(f);
    }
  }
  const conditionFlagBlock = allConditionFlags.size > 0
    ? `\n## 条件分岐フラグ（true/false で返す）\n${[...allConditionFlags].map(f => `- ${f}`).join("\n")}\n`
    : "";

  const userTurnText = `## あなたが今やること（ターン3: 各書類のスロットに何を入れるかを決める）

ターン1で整理した内容、ターン2で確認した質問の回答を踏まえて、
**全ての書類の全てのスロット**に入れる値を JSON で返してください。

${renderQABlock()}${masterUpdateBlock}
## 各書類のスロット一覧（このキー名で返答すること）

${docPromptLines.join("\n")}
${conditionFlagBlock}
## 出力形式（JSON のみ。説明文・前置き不要）

\`\`\`json
{
  "documents": [
    {
      "fileName": "書類のファイル名（上で指定したものと完全一致）",
      "values": {
        "要入力_0": "三上春香",
        "要入力_3": "令和８年１月１５日"
      },
      "conditionFlags": { "出資者は法人": false, "出資者は個人": true }
    }
  ]
}
\`\`\`

## 重要ルール

### 値の型と形式
- **人名**: ターン1の整理内容・基本情報の役員/株主から正しい氏名を採用
- **会社名**: 基本情報の商号
- **日付**: 「令和○年○月○日」形式の和暦全角数字（例: 令和７年１月２１日）
- **金額・株数**: テンプレ前後に「円」「株」等の単位がある場合、値には単位を含めない（テンプレ側に既に書かれているため）
- **割合**: 5% は「5.00%」のようなパーセント文字列

### スロットの中身は空欄
- \`要入力_N\` は **空のスロット** です。前案件の値は隠してあるので AI には見えません
- 各スロットが何を表すかは「ラベル」「形式」「出典候補」と前後の文脈から判断してください

### スロット分割（住所・氏名等が複数スロットに分かれている場合）
- 住所が「東京都渋谷区...」「クレール西原102」のように2スロット → 先頭=全体, 後続=空文字 ""
- 氏名が「福田」「峻介」のように2スロット → 先頭=全体, 後続=空文字 ""

### 株主毎の繰り返し
- 共通ルールに「株主毎に1枚」等の指示があれば、その書類だけ \`values\` の代わりに \`copies: [{ ... }, { ... }]\` で複数組返してよい

### 全角/半角
- AI 側では考えず、上記の生の値を返す（半角→全角変換はサーバー側で実施）

### 複数行を含むスロット（Excel の alt+Enter セル）
- 元のスロットが複数行（\\n を含む）なら、新しい値も**同じ構造の改行で返す**
- 例: 元「日付\\n\\n会社名\\n代表取締役名」→ 新「新日付\\n\\n新会社名\\n新代表取締役名」
- 行頭の全角空白（インデント）も維持する
- 1 行に潰さない

### データに無い値
- ターン1の整理・ユーザー確定回答・基本情報のいずれにも無い値は \`"（要確認）"\` を返す

**全ての書類・全てのスロットを必ず含めて返答すること。**`;

  const messagesWithUserTurn = appendUserTurn(aiMessages, userTurnText, "produce");

  let aiResponseText = "";
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: toAnthropicMessages(messagesWithUserTurn) as Anthropic.MessageParam[],
    });
    logTokenUsage("/api/document-templates/produce", MODEL, response.usage);
    aiResponseText = response.content[0].type === "text" ? response.content[0].text : "";
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "AI 呼び出しに失敗" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // assistant ターンを保存（verify が読む）
  const finalMessages = appendAssistantTurn(messagesWithUserTurn, aiResponseText, "produce");
  await saveAiMessages(company.id, threadId, finalMessages);

  // JSON パース（途切れ救出付き）
  type AiDoc = { fileName: string; values?: Record<string, string | string[] | boolean>; copies?: Record<string, string | boolean>[]; conditionFlags?: Record<string, boolean> };
  let parsed: { documents?: AiDoc[] } = {};
  const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      const lb = jsonMatch[0].lastIndexOf("}");
      if (lb > 0) {
        try { parsed = JSON.parse(jsonMatch[0].substring(0, lb + 1)); } catch { /* give up */ }
      }
    }
  }
  const aiDocs: AiDoc[] = parsed.documents || [];
  const aiDocByName = new Map<string, AiDoc>();
  for (const d of aiDocs) {
    if (d.fileName) aiDocByName.set(d.fileName, d);
  }

  // --- 3) 各テンプレに対して決定的に置換 → docx 生成 ---
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mammoth = require("mammoth");
  const documents: DocOut[] = [];

  for (const a of analyses) {
    const aiDoc = aiDocByName.get(a.file.name);
    if (!aiDoc) {
      console.warn(`[produce] AI did not return values for ${a.file.name}`);
      continue;
    }

    try {
      if (a.kind === "highlight-docx") {
        // AI 応答は文字列だけの想定だが、型上は string|string[]|boolean を許容（後段の typeof で除外）
        const setsRaw: Record<string, string | string[] | boolean>[] = aiDoc.copies && aiDoc.copies.length > 0
          ? aiDoc.copies
          : [aiDoc.values || {}];

        for (let ci = 0; ci < setsRaw.length; ci++) {
          const setObj = setsRaw[ci];
          // AI応答の "要入力_N" → 元の値 → 置換マップ
          const replacements: Record<string, string> = {};
          const filledSlots: FilledSlotOut[] = [];
          for (const [k, v] of Object.entries(setObj)) {
            if (typeof v !== "string") continue;
            const idMatch = k.match(/要入力_(\d+)/);
            if (!idMatch) continue;
            const id = parseInt(idMatch[1]);
            const origValue = a.docSlots.get(id);
            if (!origValue) continue;
            const fullW = toFullWidth(v);
            replacements[origValue] = fullW;
          }
          // filledSlots は docSlots（slotId → 元の値）を起点に書く
          for (const [slotId, origValue] of a.docSlots) {
            const newValue = replacements[origValue];
            if (newValue === undefined) continue;
            const meta = a.slotLabels.get(slotId);
            filledSlots.push({
              slotId, label: meta?.label || `slot_${slotId}`, value: String(newValue),
              format: meta?.format, sourceHint: meta?.sourceHint,
              copyIndex: setsRaw.length > 1 ? ci + 1 : undefined,
            });
          }

          const outputBuffer = replaceMarkedFields(a.workingBuffer, replacements);
          const suffix = setsRaw.length > 1 ? `_${ci + 1}` : "";
          const fileName = `${company.name}_${a.baseName}${suffix}.docx`;
          let previewHtml = "";
          try { previewHtml = (await mammoth.convertToHtml({ buffer: outputBuffer })).value; } catch { /* ignore */ }
          documents.push({
            name: setsRaw.length > 1 ? `${a.baseName}_${ci + 1}` : a.baseName,
            docxBase64: outputBuffer.toString("base64"),
            previewHtml, fileName,
            templatePath: a.file.path,
            filledSlots,
          });
        }
        continue;
      }

      if (a.kind === "highlight-xlsx") {
        const valuesObj = aiDoc.values || {};
        const xlReplacements: Record<string, string> = {};
        const xlFilledSlots: FilledSlotOut[] = [];
        for (const [k, v] of Object.entries(valuesObj)) {
          if (typeof v !== "string") continue;
          const idMatch = k.match(/要入力_(\d+)/);
          if (!idMatch) continue;
          const id = parseInt(idMatch[1]);
          const origValue = a.xlSlots.get(id);
          if (!origValue) continue;
          const normalized = toHalfWidth(v);
          xlReplacements[origValue] = normalized;
          const meta = a.slotLabels.get(id);
          xlFilledSlots.push({
            slotId: id,
            label: meta?.label || `slot_${id}`,
            value: normalized,
            format: meta?.format,
            sourceHint: meta?.sourceHint,
          });
        }
        const outBuf = replaceXlsxMarkedCells(a.workingBuffer, xlReplacements);
        const fileName = `${company.name}_${a.baseName}.xlsx`;
        documents.push({
          name: a.baseName,
          docxBase64: outBuf.toString("base64"),
          previewHtml: "",
          fileName,
          templatePath: a.file.path,
          filledSlots: xlFilledSlots,
        });
        continue;
      }

      if (a.kind === "placeholder-docx") {
        const valuesObj = aiDoc.values || {};
        const flags = aiDoc.conditionFlags || {};
        const setsRaw: Record<string, string | boolean>[] = aiDoc.copies && aiDoc.copies.length > 0
          ? aiDoc.copies.map(c => ({ ...c, ...flags }))
          : [{ ...valuesObj as Record<string, string>, ...flags }];

        for (let ci = 0; ci < setsRaw.length; ci++) {
          const setObj = setsRaw[ci];
          const templateData: Record<string, string | boolean> = {};
          for (const [key, val] of Object.entries(setObj)) {
            if (typeof val === "boolean") {
              templateData[key] = val;
            } else if (typeof val === "string") {
              templateData[key] = toFullWidth(stripDuplicatedUnit(val, key, a.file.content));
            }
          }

          const zip = new PizZip(a.rawBuffer);
          // 区切り文字を {{ }} に統一
          for (const fn of Object.keys(zip.files)) {
            if (!fn.endsWith(".xml") && !fn.endsWith(".xml.rels")) continue;
            const content = zip.file(fn)?.asText();
            if (!content) continue;
            const normalized = content
              .replace(/｛｛/g, "{{")
              .replace(/｝｝/g, "}}")
              .replace(/【/g, "{{")
              .replace(/】/g, "}}");
            if (normalized !== content) zip.file(fn, normalized);
          }
          const doc = new Docxtemplater(zip, {
            delimiters: { start: "{{", end: "}}" },
            paragraphLoop: true,
            linebreaks: true,
            nullGetter: () => "（要確認）",
          });
          doc.render(templateData);
          const outputBuffer = doc.getZip().generate({ type: "nodebuffer" });
          const suffix = setsRaw.length > 1 ? `_${ci + 1}` : "";
          const fileName = `${company.name}_${a.baseName}${suffix}.docx`;
          let previewHtml = "";
          try { previewHtml = (await mammoth.convertToHtml({ buffer: outputBuffer })).value; } catch { /* ignore */ }
          documents.push({
            name: setsRaw.length > 1 ? `${a.baseName}_${ci + 1}` : a.baseName,
            docxBase64: outputBuffer.toString("base64"),
            previewHtml, fileName,
            templatePath: a.file.path,
          });
        }
        continue;
      }

      if (a.kind === "placeholder-xlsx") {
        const valuesObj = aiDoc.values || {};
        const rawData: Record<string, string> = {};
        for (const [key, value] of Object.entries(valuesObj)) {
          if (typeof value === "boolean") continue;
          const v = Array.isArray(value) ? value[0] || "（要確認）" : value;
          rawData[key] = toHalfWidth(stripDuplicatedUnit(v, key, a.file.content));
        }

        const zip = new PizZip(a.rawBuffer);
        const ssPath = "xl/sharedStrings.xml";
        const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        // 1) 文字列置換
        for (const fn of Object.keys(zip.files)) {
          if (!fn.endsWith(".xml") && !fn.endsWith(".xml.rels")) continue;
          let content = zip.file(fn)?.asText();
          if (!content) continue;
          let changed = false;
          for (const [key, replacement] of Object.entries(rawData)) {
            const patterns = [`【${key}】`, `{{${key}}}`, `｛｛${key}｝｝`];
            const escaped = xmlEscape(replacement);
            for (const pat of patterns) {
              if (content.includes(pat)) {
                content = content.split(pat).join(escaped);
                changed = true;
              }
            }
          }
          if (changed) zip.file(fn, content);
        }

        // 2) sharedStrings.xml からルビ除去
        const ssContent = zip.file(ssPath)?.asText();
        if (ssContent) {
          const cleaned = ssContent
            .replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "")
            .replace(/<phoneticPr\b[^>]*\/>/g, "")
            .replace(/<phoneticPr\b[^>]*>[\s\S]*?<\/phoneticPr>/g, "");
          if (cleaned !== ssContent) zip.file(ssPath, cleaned);
        }

        // 3) 純数値の共有文字列を検出 → セル型を数値型に
        const extractSiText = (siInner: string): string => {
          const stripped = siInner
            .replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")
            .replace(/<phoneticPr\b[^>]*\/>/g, "");
          const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
          let text = "";
          let tm: RegExpExecArray | null;
          while ((tm = tRegex.exec(stripped)) !== null) text += tm[1];
          return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        };
        const numericSiIndexes = new Map<number, string>();
        let currentSsXml = zip.file(ssPath)?.asText();
        if (currentSsXml) {
          const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
          let m: RegExpExecArray | null;
          let i = 0;
          while ((m = siRegex.exec(currentSsXml)) !== null) {
            const decoded = extractSiText(m[1]);
            const cleaned = decoded.replace(/,/g, "").trim();
            if (cleaned !== "" && /^-?\d+(\.\d+)?$/.test(cleaned)) {
              numericSiIndexes.set(i, cleaned);
            }
            i++;
          }
        }

        const isNumericStr = (s: string): string | null => {
          const cleaned = s.replace(/,/g, "").trim();
          if (cleaned === "") return null;
          return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
        };

        for (const fn of Object.keys(zip.files)) {
          if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fn)) continue;
          let sheetXml = zip.file(fn)?.asText();
          if (!sheetXml) continue;
          let sheetChanged = false;

          if (numericSiIndexes.size > 0) {
            sheetXml = sheetXml.replace(
              /<c\b([^>]*\bt="s"[^>]*)>\s*<v>(\d+)<\/v>\s*<\/c>/g,
              (whole: string, attrs: string, idxStr: string) => {
                const num = numericSiIndexes.get(parseInt(idxStr, 10));
                if (num === undefined) return whole;
                sheetChanged = true;
                const newAttrs = attrs.replace(/\s*\bt="s"/, "");
                return `<c${newAttrs}><v>${num}</v></c>`;
              }
            );
          }

          sheetXml = sheetXml.replace(
            /<c\b([^>]*\bt="inlineStr"[^>]*)>\s*<is>([\s\S]*?)<\/is>\s*<\/c>/g,
            (whole: string, attrs: string, isInner: string) => {
              const text = extractSiText(isInner);
              const num = isNumericStr(text);
              if (num === null) return whole;
              sheetChanged = true;
              const newAttrs = attrs.replace(/\s*\bt="inlineStr"/, "");
              return `<c${newAttrs}><v>${num}</v></c>`;
            }
          );

          sheetXml = sheetXml.replace(
            /<c\b([^>]*)>(\s*<f\b[^>]*(?:\/>|>[\s\S]*?<\/f>))\s*<v>[^<]*<\/v>\s*<\/c>/g,
            (_whole: string, attrs: string, fEl: string) => {
              sheetChanged = true;
              const newAttrs = attrs.replace(/\s*\bt="[^"]*"/, "");
              return `<c${newAttrs}>${fEl}</c>`;
            }
          );

          if (sheetChanged) zip.file(fn, sheetXml);
        }

        // 4) sharedStrings count 更新
        currentSsXml = zip.file(ssPath)?.asText();
        if (currentSsXml) {
          let totalStringRefs = 0;
          for (const fn of Object.keys(zip.files)) {
            if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fn)) continue;
            const sheetXml = zip.file(fn)?.asText();
            if (sheetXml) totalStringRefs += (sheetXml.match(/<c\b[^>]*\bt="s"[^>]*>/g) || []).length;
          }
          const updatedSsXml = currentSsXml.replace(
            /<sst\b[^>]*>/,
            (tag: string) => tag.replace(/\bcount="[^"]*"/, `count="${totalStringRefs}"`)
          );
          if (updatedSsXml !== currentSsXml) zip.file(ssPath, updatedSsXml);
        }

        // 5) calcChain 削除
        if (zip.file("xl/calcChain.xml")) {
          zip.remove("xl/calcChain.xml");
          const relsPath = "xl/_rels/workbook.xml.rels";
          const relsXml = zip.file(relsPath)?.asText();
          if (relsXml) {
            const cleanedRels = relsXml.replace(/<Relationship\b[^>]*\bTarget="calcChain\.xml"[^>]*\/>/g, "");
            if (cleanedRels !== relsXml) zip.file(relsPath, cleanedRels);
          }
          const ctPath = "[Content_Types].xml";
          const ctXml = zip.file(ctPath)?.asText();
          if (ctXml) {
            const cleanedCt = ctXml.replace(/<Override\b[^>]*\bPartName="\/xl\/calcChain\.xml"[^>]*\/>/g, "");
            if (cleanedCt !== ctXml) zip.file(ctPath, cleanedCt);
          }
        }

        const outputBuffer = zip.generate({ type: "nodebuffer" });
        const fileName = `${company.name}_${a.baseName}.xlsx`;
        documents.push({
          name: a.baseName,
          docxBase64: outputBuffer.toString("base64"),
          previewHtml: "",
          fileName,
          templatePath: a.file.path,
        });
        continue;
      }
    } catch (e) {
      console.error(`[produce] failed for ${a.file.name}:`, e instanceof Error ? e.message : e);
    }
  }

  return new Response(JSON.stringify({ documents }), {
    headers: { "Content-Type": "application/json" },
  });
}
