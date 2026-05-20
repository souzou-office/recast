import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { logTokenUsage } from "@/lib/token-logger";
import {
  applyProofreadEditsDocx,
  applyProofreadEditsXlsx,
  type ProofreadEdit,
} from "@/lib/proofread-edits";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx");

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

/**
 * 書類校正 (proofread) = 1回目 produce 後の修正パス。
 *
 * 仕組み:
 *   1. クライアントから「修正したい指摘リスト」と「現在の docx 群」が POST される
 *   2. AI に「これらの指摘を直すための edit list を JSON で返せ」と指示
 *      - 各書類について `replace` (文字列置換) と `delete-paragraph` / `delete-row` のみ
 *      - 法的文言の改変リスクを抑えるため「指摘に関係ない箇所は触らない」を厳命
 *   3. サーバー側で edit list を docx/xlsx の XML に適用 (書式維持)
 *   4. 修正版 docx (base64) を返却
 *
 * 設計判断:
 *   - AI に全文を書き直させるのではなく **edit list** で返させる:
 *       法的文言が AI の「いい感じに整える」で改変されるリスクを最小化。
 *       書式 (太字・表・インデント) も維持できる。
 *   - 1 書類 1 AI 呼び出しではなく**まとめて 1 回呼ぶ**: トークン効率優先。
 *     書類間で同じ氏名揺れがあれば一貫した edit が生成される。
 */

interface ProofreadDoc {
  fileName: string;
  docxBase64: string;
  /** 適用すべき指摘 (verify 出力から user が選択したもの) */
  issues: Array<{
    severity?: "error" | "warn" | "info";
    aspect?: string;
    problem: string;
    expected?: string;
    slotId?: number;
  }>;
}

// 生成書類の base64 からテキストを抽出 (verify と同じロジック)
async function extractDocumentText(base64: string, fileName: string): Promise<string> {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  try {
    const buffer = Buffer.from(base64, "base64");
    if (ext === "xlsx" || ext === "xlsm" || ext === "xls") {
      const wb = XLSX.read(buffer, { type: "buffer" });
      const parts: string[] = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        const csv: string = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        if (csv.trim()) parts.push(`[シート: ${sheetName}]\n${csv}`);
      }
      return parts.join("\n\n").trim();
    }
    const result = await mammoth.extractRawText({ buffer });
    return result.value?.trim() || "";
  } catch {
    return "";
  }
}

export async function POST(request: NextRequest) {
  const { companyId, documents } = await request.json() as {
    companyId: string;
    documents: ProofreadDoc[];
  };

  if (!companyId || !documents || documents.length === 0) {
    return NextResponse.json({ error: "companyId と documents が必須です" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // 各書類のテキスト抽出 (AI に「現状の文面」を見せる用)
  const docBlocks: string[] = [];
  for (const d of documents) {
    if (d.issues.length === 0) continue;
    const text = await extractDocumentText(d.docxBase64, d.fileName);
    const issuesText = d.issues.map((iss, i) => {
      const sev = iss.severity ? `[${iss.severity}] ` : "";
      const expectedPart = iss.expected ? `\n  → 期待値: ${iss.expected}` : "";
      const slotPart = typeof iss.slotId === "number" ? ` (slotId=${iss.slotId})` : "";
      return `${i + 1}. ${sev}${iss.problem}${slotPart}${expectedPart}`;
    }).join("\n");
    docBlocks.push(`### ${d.fileName}

#### 修正すべき指摘事項
${issuesText}

#### 現在の本文 (この書類の内容)
\`\`\`
${text}
\`\`\`
`);
  }

  if (docBlocks.length === 0) {
    return NextResponse.json({ error: "修正対象の指摘がありません" }, { status: 400 });
  }

  const prompt = `あなたは校正者です。1回目の書類生成 (穴埋め方式) で作られた docx に対し、verify で指摘された問題を修正してください。

## 出力形式 (JSON のみ、説明文不要)

書類ごとに「edit list」を返してください。edit のタイプは 3 種類:

\`\`\`json
{
  "documents": [
    {
      "fileName": "1.取締役決定書.docx",
      "edits": [
        { "type": "replace", "old": "藤崎伊久哉", "new": "藤﨑伊久哉" },
        { "type": "replace", "old": "50000", "new": "49000" },
        { "type": "delete-paragraph", "anchor": "議案２（取締役の報酬に関する件）" }
      ]
    }
  ]
}
\`\`\`

### edit タイプの説明

- **replace**: \`old\` の文字列を \`new\` に**全置換**する。氏名揺れ、数値ミス、住所違い等の単純な置換に使う。**old は文書内に確実に存在する文字列を指定**すること (部分一致ではなく完全一致で検索)
- **delete-paragraph**: \`anchor\` 文字列を含む**段落 (=改行までのひとかたまり) を丸ごと削除**。議案ブロック削除等。docx 専用
- **delete-row**: \`anchor\` 文字列を含む**行を削除**。空白の重複行削除等。xlsx 専用

## 🔴 守るべきルール

1. **指摘に関係ない箇所は絶対に触らない**。AI 側で「ついでに整える」「文章を綺麗にする」のは禁止。法律文書なので 1 文字の改変も結果として効力に影響しうる。
2. **edit が指摘ごとに必要十分か慎重に検討**: 例えば「氏名表記揺れ」なら replace 1 件で済むが、「複数箇所の数値ずれ」なら replace を複数 (各箇所分) 必要かも
3. **構造的に edit list で表現できない指摘はスキップ**: 例: 「セルの書式設定がおかしい」「全体の構成を見直すべき」みたいな抽象的な指摘は、edit list で対応できないので何も返さない
4. **delete-paragraph / delete-row の anchor は段落/行を一意に特定できる文字列**を選ぶこと。短すぎると他の段落も誤削除されかねない (本実装は最初の 1 件しか削除しないが念のため)
5. **replace の old は短すぎないこと**: 「年」みたいな一般的すぎる文字列は他の箇所も巻き込む。「令和８年」「藤崎伊久哉」のように特定的なものを使う
6. **削除不要な指摘** (例: 業務判断確認の「就任承諾書要否」等) はスキップ
7. **削除でも編集でも、判断に迷うものはスキップ** (false positive で間違って削るより、user 側で手動修正するほうが安全)

## 各書類の現状と指摘事項

${docBlocks.join("\n---\n\n")}

上記の指摘を edit list で表現してください。JSON のみ返答。`;

  let aiResponseText = "";
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    logTokenUsage("/api/document-templates/proofread", MODEL, response.usage);
    aiResponseText = response.content[0].type === "text" ? response.content[0].text : "";
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "AI 呼び出しに失敗" },
      { status: 500 }
    );
  }

  // JSON パース
  type ParsedDoc = { fileName: string; edits: ProofreadEdit[] };
  let parsed: { documents?: ParsedDoc[] } = {};
  const jsonMatch = aiResponseText.match(/```json\s*([\s\S]*?)```/) || aiResponseText.match(/(\{[\s\S]*\})/);
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]); } catch { parsed = {}; }
  }
  const aiDocs = parsed.documents || [];

  // ファイル名 → edit list のマップ
  const editsByFile = new Map<string, ProofreadEdit[]>();
  for (const d of aiDocs) {
    if (!d.fileName) continue;
    if (!Array.isArray(d.edits)) continue;
    editsByFile.set(d.fileName, d.edits.filter(e => e && typeof e === "object" && "type" in e));
  }

  // 各書類に edit を適用
  const updatedDocs: Array<{
    fileName: string;
    docxBase64?: string;
    previewHtml?: string;
    applied: number;
    skipped: { reason: string }[];
    edits: ProofreadEdit[];
  }> = [];

  for (const d of documents) {
    const baseName = d.fileName.replace(/\.[^.]+$/, "");
    // AI 応答のファイル名は厳密一致 / 拡張子なし / 接頭辞付き等のいずれかでマッチ
    let editList: ProofreadEdit[] = editsByFile.get(d.fileName) || [];
    if (editList.length === 0) {
      for (const [k, v] of editsByFile) {
        const kBase = k.replace(/\.[^.]+$/, "");
        if (k === d.fileName || kBase === baseName || d.fileName.endsWith(k) || baseName.endsWith(kBase)) {
          editList = v;
          break;
        }
      }
    }

    if (editList.length === 0) {
      updatedDocs.push({ fileName: d.fileName, applied: 0, skipped: [], edits: [] });
      continue;
    }

    const buffer = Buffer.from(d.docxBase64, "base64");
    const ext = (d.fileName.split(".").pop() || "").toLowerCase();
    let result;
    if (ext === "docx" || ext === "docm") {
      result = applyProofreadEditsDocx(buffer, editList);
    } else if (ext === "xlsx" || ext === "xlsm" || ext === "xls") {
      result = applyProofreadEditsXlsx(buffer, editList);
    } else {
      updatedDocs.push({ fileName: d.fileName, applied: 0, skipped: [], edits: editList });
      continue;
    }

    // mammoth プレビュー (docx のみ)
    let previewHtml = "";
    if (ext === "docx" || ext === "docm") {
      try {
        const html = await mammoth.convertToHtml({ buffer: result.buffer });
        previewHtml = html.value || "";
      } catch { /* ignore */ }
    }

    updatedDocs.push({
      fileName: d.fileName,
      docxBase64: result.buffer.toString("base64"),
      previewHtml,
      applied: result.applied.length,
      skipped: result.skipped,
      edits: editList,
    });
  }

  return NextResponse.json({ documents: updatedDocs });
}
