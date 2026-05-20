// spec-generator.ts
// 「テンプレートを見て、新事実に合わせて、上から順に必要最低限の値リストを出す」AI 呼び出し。
// 検証で確認した「試行3」のプロンプト戦略を構造化したもの。
//
// 入力: 構造化docx（docx-structure-parser）+ 案件整理テキスト（+任意で参照案件・ラベル）
// 出力: 議案ブロック単位の取捨判断 + 位置順の値リスト（要確認フラグ付き）
//
// 既存の produce フローは変更しない。新規モジュールとして並走させ、
// 段階的に produce 側へ統合する想定。

import Anthropic from "@anthropic-ai/sdk";
import {
  parseDocxStructure,
  formatStructureForAI,
  type StructuredDocx,
} from "./docx-structure-parser";
import { logTokenUsage } from "./token-logger";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

// ブロック単位の構造判断（Pass 1相当）
export interface BlockDecision {
  section: string;             // 議案名・セクション名（テンプレ内表記そのまま）
  decision: "keep" | "remove" | "add";
  reason: string;              // 判断根拠（短く）
}

// 値単位の差分（Pass 2相当）
export interface ValueDecision {
  anchorId: string;            // 構造化docxの anchor 参照
  section?: string;            // 所属セクション
  label: string;               // この値の意味（例: 「決議日」「代表取締役の氏名」）
  oldValue?: string;           // 元値（既存ハイライト由来、無ければ未定義）
  newValue: string;            // 新しい値（uncertain なら空文字でも可）
  reason: string;              // なぜこの値か（事実のどこから来たか）
  uncertain: boolean;          // 自信なし＝要確認
}

export interface DocumentSpec {
  templateName: string;
  blocks: BlockDecision[];
  values: ValueDecision[];
  // AI生成のメタ（デバッグ用）
  modelOutput?: string;
}

export interface GenerateSpecInput {
  templateBuffer: Buffer;
  templateName: string;
  // 案件整理（事実の整理テキスト）
  masterContent: string;
  // 任意: 参照案件のテキスト（過去の同種案件をそのまま渡したい場合）
  referenceCaseText?: string;
  // 任意: 既に分かっている回答（要確認に対するユーザー回答等）
  confirmedAnswers?: Record<string, string>;
}

// プロンプト本体。試行3で効いた構造を組み込む:
//   ・テンプレを見て（構造化アンカー列）
//   ・上から固有名詞が必要な順に（position 順、出力もその順）
//   ・必要最低限の項目で（不要議案は blocks で remove）
//   ・必要な情報を書き出して（values で位置×ラベル×新値）
const SYSTEM_PROMPT = `あなたは法務書類の作成を支援するAI「recast」です。
これから「参照書類のテンプレート構造」と「今回の新案件の事実」を渡します。
あなたの仕事は、テンプレを上から順に見て、新案件に合わせて
「何をどう変えるか」の仕様書を作ることです。

【重要な原則】
1. 議案・条項が今回の案件に該当しないなら、その議案ブロックは decision: "remove" にする
   （例: 「役員報酬の決定の件」は事実に役員報酬の決議がなければ remove）
2. 該当する議案は keep。中の値（名前・日付・金額・株数等）は values で個別に指示
3. 法律用語・形式文言は **絶対に変更しない**
   （取締役会、決議、商号、議長、出席取締役、…等のフォーマル語彙）
4. 値が事実から特定できない場合は uncertain: true で要確認として残す
   （勝手に推測しない。空文字や placeholder でもよい）
5. 出力は位置順（テンプレで上に出てくる値から順に）

【出力】JSON のみ。説明文や前置きは不要。
{
  "blocks": [
    { "section": "<議案名そのまま>", "decision": "keep" | "remove" | "add", "reason": "..." }
  ],
  "values": [
    { "anchorId": "<構造内のID>", "section": "<所属セクション>", "label": "...", "oldValue": "...", "newValue": "...", "reason": "...", "uncertain": false }
  ]
}`;

function buildUserPrompt(
  structure: StructuredDocx,
  input: GenerateSpecInput,
): string {
  const parts: string[] = [];

  parts.push(`# 参照書類のテンプレート構造\n`);
  parts.push(`書類名: ${input.templateName}\n`);
  if (structure.sections.length > 0) {
    parts.push(`検出されたセクション:`);
    structure.sections.forEach((s, i) => parts.push(`  ${i + 1}. ${s}`));
    parts.push("");
  }
  parts.push(`位置順のアンカー列（各 [anchorId] が編集対象になりうる位置）:`);
  parts.push(formatStructureForAI(structure));
  parts.push("");

  parts.push(`# 今回の新案件の事実（案件整理）`);
  parts.push(input.masterContent);
  parts.push("");

  if (input.referenceCaseText && input.referenceCaseText.trim()) {
    parts.push(`# 参考: 過去案件の本文（同種の完成書類）`);
    parts.push(input.referenceCaseText);
    parts.push("");
  }

  if (input.confirmedAnswers && Object.keys(input.confirmedAnswers).length > 0) {
    parts.push(`# 既に確認済みの値（ユーザー回答）`);
    for (const [k, v] of Object.entries(input.confirmedAnswers)) {
      parts.push(`- ${k}: ${v}`);
    }
    parts.push("");
  }

  parts.push(`# タスク`);
  parts.push(
    `上のテンプレート構造を見て、新案件に合わせた仕様書を JSON で返してください。`,
  );
  parts.push(
    `- まず blocks で議案ブロックの取捨を判断（テンプレに無いブロックを足す場合は decision: "add"）`,
  );
  parts.push(`- 次に values で位置順に新しい値を列挙`);
  parts.push(`- 値が確定できなければ uncertain: true、newValue は空文字でよい`);
  parts.push(`- 形式文言（取締役会・決議等）は絶対に変えない`);

  return parts.join("\n");
}

// AI 応答から JSON ブロックを抽出
function extractJson(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  // フェンスが無くても先頭から最後の } までを試す
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return null;
}

// メイン: テンプレ Buffer + 案件整理 → 仕様書
export async function generateDocumentSpec(
  input: GenerateSpecInput,
): Promise<DocumentSpec> {
  const structure = parseDocxStructure(input.templateBuffer);
  const userPrompt = buildUserPrompt(structure, input);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  logTokenUsage("spec-generator", MODEL, response.usage);

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const jsonStr = extractJson(text);

  let blocks: BlockDecision[] = [];
  let values: ValueDecision[] = [];

  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr) as Partial<DocumentSpec>;
      if (Array.isArray(parsed.blocks)) blocks = parsed.blocks as BlockDecision[];
      if (Array.isArray(parsed.values)) values = parsed.values as ValueDecision[];
    } catch {
      // パース失敗時は空の仕様書を返す（呼び出し側で modelOutput を見て対応）
    }
  }

  // 値リストを position 順（anchorId のドキュメント内位置順）にソート
  const positionOf = new Map<string, number>();
  for (const a of structure.anchors) positionOf.set(a.anchorId, a.position);
  values.sort((a, b) => {
    const pa = positionOf.get(a.anchorId) ?? Number.MAX_SAFE_INTEGER;
    const pb = positionOf.get(b.anchorId) ?? Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });

  return {
    templateName: input.templateName,
    blocks,
    values,
    modelOutput: text,
  };
}

// 複数テンプレを並列に処理して仕様書セットを返すユーティリティ。
// 「書類ごとに個別処理する」検証結果に沿った形。
export async function generateDocumentSpecsParallel(
  inputs: GenerateSpecInput[],
): Promise<DocumentSpec[]> {
  return Promise.all(inputs.map((i) => generateDocumentSpec(i)));
}

// 仕様書を人が読める Markdown に整形（デバッグ・UI 表示用）
export function formatSpecAsMarkdown(spec: DocumentSpec): string {
  const lines: string[] = [];
  lines.push(`# 仕様書: ${spec.templateName}`);
  lines.push("");

  if (spec.blocks.length > 0) {
    lines.push(`## 議案ブロックの取捨`);
    for (const b of spec.blocks) {
      const mark =
        b.decision === "keep" ? "✓" : b.decision === "remove" ? "✗" : "＋";
      lines.push(`- ${mark} **${b.section}** — ${b.decision}: ${b.reason}`);
    }
    lines.push("");
  }

  if (spec.values.length > 0) {
    lines.push(`## 値の差分（位置順）`);
    for (const v of spec.values) {
      const section = v.section ? `[${v.section}] ` : "";
      const confidence = v.uncertain ? " ⚠️要確認" : "";
      const old = v.oldValue ? `（元値: ${v.oldValue}）` : "";
      lines.push(
        `- ${section}**${v.label}**: ${v.newValue || "(未確定)"}${old}${confidence}`,
      );
      lines.push(`  - 根拠: ${v.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
