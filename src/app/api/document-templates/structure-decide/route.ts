import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
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
import type { ProofreadEdit } from "@/lib/proofread-edits";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx");

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

/**
 * Pass 0 (方針決め) = 構造変更の判断ターン。
 *
 * organize (ターン1) と clarify (ターン2) が終わった後、produce (穴埋め) より前に挟む。
 * AI に「テンプレ本文 + 案件情報」を見せて、案件に応じて削除すべきブロック等を
 * **edit list** で出力させる。
 *
 * なぜ必要か:
 *   現状の produce は「テンプレを動かさず穴埋めするだけ」なので、議案2 削除みたいな
 *   構造変更には対応できなかった (verify が指摘 → user が Word で手動削除)。
 *
 * 設計判断:
 *   - AI が出すのは **declarative な edit op** (delete-paragraph 等)。AI が自然言語で
 *     本文を書き換える訳ではない。法的文言の改変リスクは原理的にゼロ。
 *   - テンプレに条件ブロック等の事前仕込みは**不要**。AI が本文を見て自分で anchor を
 *     特定する (universal)。
 *   - 巻き込み事故防止のため、AI に `expectedMatches` を宣言させる。
 *     件数が合わなければサーバー側で適用見送り。
 *
 * 注: ここでは「decide」だけで適用は produce 側に任せる (produce が body の
 *     `previousStructureEdits` を受けて、テンプレ buffer に適用してから slot 抽出する)。
 */

interface ApiResponseDoc {
  fileName: string;
  edits: ProofreadEdit[];
}

async function extractDocumentText(buffer: Buffer, fileName: string): Promise<string> {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  try {
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
  const { companyId, threadId, templateFolderPath } = await request.json() as {
    companyId: string;
    threadId?: string;
    templateFolderPath: string;
  };

  if (!threadId) {
    return NextResponse.json({ error: "threadId が必要" }, { status: 400 });
  }
  if (!templateFolderPath) {
    return NextResponse.json({ error: "templateFolderPath が必要" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // 会話履歴ロード: organize/clarify が完了している前提
  let aiMessages = await loadAiMessages(company.id, threadId);
  if (!hasStage(aiMessages, "organize")) {
    return NextResponse.json({ error: "案件整理 (ターン1) が完了していません" }, { status: 400 });
  }
  // structure を再実行する場合は、structure 以降のターン (produce/verify) も含めて切り戻す
  aiMessages = truncateBeforeStage(aiMessages, "structure");

  // テンプレ本文を読む
  const templateFiles = await readAllFilesInFolder(templateFolderPath);
  const docFiles = templateFiles.filter(f => /\.(docx|doc|docm|xlsx|xls|xlsm)$/i.test(f.name));
  if (docFiles.length === 0) {
    return NextResponse.json({ error: "テンプレフォルダにファイルがありません" }, { status: 400 });
  }

  const docBlocks: string[] = [];
  for (const tf of docFiles) {
    const fs = await import("fs/promises");
    let buf: Buffer;
    try {
      buf = await fs.default.readFile(tf.path);
    } catch { continue; }
    const text = await extractDocumentText(buf, tf.name);
    if (!text) continue;
    docBlocks.push(`### ${tf.name}\n\`\`\`\n${text}\n\`\`\``);
  }
  if (docBlocks.length === 0) {
    return NextResponse.json({ documents: [] });
  }

  const userTurnText = `## あなたが今やること (ターン2.5: 構造の方針決め)

organize (ターン1) と clarify (ターン2) で案件情報が確定しました。
これから書類を生成しますが、その前に**構造変更が必要かどうか**を判断してください。

## 判断対象の構造変更

各テンプレ書類について、案件情報を踏まえて以下を判断:

1. **削除すべきブロック**: テンプレに含まれてるけど今回の案件では不要なセクション/議案/段落
   - 例: 報酬議案を含むテンプレだけど今回は無報酬なので議案2 を削除
   - 例: 第3株主の欄があるけど今回は 2 名なので削除

その他 (variant 選択や行拡張) は本ターンでは扱いません (別の機構で処理)。

## 出力形式 (JSON のみ、説明文不要)

\`\`\`json
{
  "documents": [
    {
      "fileName": "1.取締役決定書.docx",
      "edits": [
        {
          "type": "delete-section",
          "anchor": "議案２（取締役の報酬に関する件）",
          "endAnchor": "議案３",
          "reason": "今回は無報酬の取締役のため議案2 ブロックごと削除"
        }
      ]
    },
    {
      "fileName": "2-1.提案書兼同意書.docx",
      "edits": []
    }
  ]
}
\`\`\`

### edit タイプ
- **delete-section** ← **議案ブロックや見出し配下の複数段落をまとめて消すときはこれを使う (推奨)**
  - \`anchor\` 段落から \`endAnchor\` を含む段落の**直前まで**を一括削除する
  - 例: 議案2 ブロック (見出し + 条文 + ア + イ + ウ + 「記」など複数段落) を消したい
    → anchor: "議案２（取締役の報酬に関する件）", endAnchor: "議案３"
  - 「議案ヘッダーから次の議案ヘッダーの直前まで」を消すのが典型例
  - endAnchor を省略すると anchor 以降文書末尾まで消える (危険なので極力指定すること)
- **delete-paragraph**: \`anchor\` 文字列を含む**段落 1 つだけ**を削除
  - 単一段落だけ消したい場合 (空行、不要な但し書き 1 行など) に使う
  - 議案ブロックのように複数段落で 1 つの意味単位になっているものに使ってはいけない
    (見出しだけ消えて条文が残る、という中途半端な結果になる)

### 必須フィールド
- **anchor**: 削除対象段落を**一意に特定できる文字列**を指定。短すぎると別箇所を巻き込む
  - ❌ 「議案」「年月日」等の一般的すぎる短い文字列
  - ✅ 「議案２（取締役の報酬に関する件）」「第3条 取締役の任期」等の具体的なフレーズ
- **endAnchor** (delete-section 専用): どこまで消すかの**直前**を示す文字列
  - 削除範囲を必ず限定するために、可能な限り指定すること
  - 例: 議案2 を消す → endAnchor: "議案３" (議案3 自身は残る、その直前まで消える)
- **expectedMatches** (delete-paragraph 専用): その anchor がテンプレ内で**何段落 hit するはず**かを宣言
  - 通常は 1
  - サーバー側で実際の件数と比較。一致しなければ**適用見送り** (= 巻き込み事故防止)
- **reason**: 削除理由 (人間が後で見て分かるように)

## 🔴 守るべきルール

1. **判断に確信が持てない構造変更はしない**。空配列を返してOK
   - 「念のため消そうかな」は禁止。間違って必要なブロック消すリスクの方が大きい
2. **値レベルの修正 (氏名揺れ、住所違い等) は本ターンの対象外**。proofread (校正パス) で対応するのでスキップ
3. **anchor は実際にテンプレ本文に存在する文字列**であること。AI が想像で書いた文字列は無効
4. **すべての書類を documents 配列に必ず含める** (edits 空でも OK)。書類名は ### に書かれてるファイル名と完全一致

## 各テンプレの本文と案件情報

${docBlocks.join("\n\n")}

上記を踏まえて、削除が必要なブロックを edit list で返してください。JSON のみ返答。`;

  const messagesWithUserTurn = appendUserTurn(aiMessages, userTurnText, "structure");

  let aiResponseText = "";
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: toAnthropicMessages(messagesWithUserTurn) as Anthropic.MessageParam[],
    });
    logTokenUsage("/api/document-templates/structure-decide", MODEL, response.usage);
    aiResponseText = response.content[0].type === "text" ? response.content[0].text : "";
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "AI 呼び出しに失敗" },
      { status: 500 }
    );
  }

  // assistant ターン保存 (produce/verify が会話履歴で参照)
  const finalMessages = appendAssistantTurn(messagesWithUserTurn, aiResponseText, "structure");
  await saveAiMessages(company.id, threadId, finalMessages);

  // JSON パース
  let parsed: { documents?: ApiResponseDoc[] } = {};
  const jsonMatch = aiResponseText.match(/```json\s*([\s\S]*?)```/) || aiResponseText.match(/(\{[\s\S]*\})/);
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]); } catch { parsed = {}; }
  }
  const aiDocs = parsed.documents || [];

  // 出力構造をクライアントに返す。produce 側が body に乗せて再送する。
  const documents: ApiResponseDoc[] = aiDocs
    .filter(d => d && typeof d.fileName === "string")
    .map(d => ({
      fileName: d.fileName,
      edits: Array.isArray(d.edits)
        ? d.edits.filter(e => e && typeof e === "object" && "type" in e)
        : [],
    }));

  return NextResponse.json({ documents });
}
