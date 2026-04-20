// テンプレートの★ハイライトに対して意味ラベル＋記載形式を付与するユーティリティ。
// テンプレごとに1度だけ AI に解析させ、結果を隣の <template>.labels.json にキャッシュする。
// テンプレ本体の sha256 が変わっていたら再生成する。

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const client = new Anthropic();

export interface TemplateSlotLabel {
  slotId: number;
  oldValue: string;
  label: string;         // 意味ラベル（例: 取締役決定書の作成日、代表取締役の氏名）
  format: string;        // 記載形式（例: 令和○年○月○日、○○●●）
  sourceHint?: string;   // 推定される出典（例: 基本情報の役員、案件スケジュール表）
}

export interface TemplateLabels {
  templateHash: string;
  generatedAt: string;
  slots: TemplateSlotLabel[];
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function labelsPathFor(templatePath: string): string {
  return templatePath + ".labels.json";
}

async function loadCachedLabels(templatePath: string, expectedHash: string): Promise<TemplateLabels | null> {
  try {
    const raw = await fs.readFile(labelsPathFor(templatePath), "utf-8");
    const parsed = JSON.parse(raw) as TemplateLabels;
    if (parsed.templateHash === expectedHash) return parsed;
    return null; // ハッシュ不一致 → 再生成
  } catch {
    return null; // ファイルなし
  }
}

async function saveLabels(templatePath: string, labels: TemplateLabels): Promise<void> {
  await fs.writeFile(labelsPathFor(templatePath), JSON.stringify(labels, null, 2), "utf-8");
}

// ★マーク付き文書テキスト + 各スロットの元値を AI に投げて意味ラベルを得る
async function askAiForLabels(markedText: string, oldValues: { slotId: number; value: string }[]): Promise<TemplateSlotLabel[]> {
  const valueList = oldValues.map(v => `- slot ${v.slotId}: "${v.value}"`).join("\n");

  const prompt = `以下の書類テンプレートを読んで、★マーク★で囲まれた各スロットの意味を判断してください。
★マーク★部分は「前案件の値（次の案件ではこの位置に値を入れる）」です。

## テンプレート全文（★マーク★が可変箇所）
${markedText}

## 各スロットの前案件の値
${valueList}

## タスク
各スロットについて、以下の 3 つを JSON 配列で返してください。

1. **label**: そのスロットの意味（日本語、短く具体的に）
   - 例: "取締役決定書の作成日", "代表取締役の氏名", "募集株式の数", "募集株式の払込金額",
         "増加する資本金の額", "増加する資本準備金の額", "払込期日", "引受人の名称"
2. **format**: 記載形式（人が見て分かる書式、具体的な数値は使わず ○ や ●）
   - 例: "令和○年○月○日", "○○●●", "○，○○○", "○，○○○，○○○円", "株式会社○○○"
3. **sourceHint**: 推定される出典（案件のどこから値を取るか）
   - 例: "基本情報の役員（代表取締役）", "案件スケジュール表", "投資契約書の第N条",
         "登記簿", "（ユーザー確認）"

## 出力形式（JSON のみ）
\`\`\`json
[
  { "slotId": 0, "label": "取締役決定書の作成日", "format": "令和○年○月○日", "sourceHint": "案件スケジュール表" },
  { "slotId": 1, "label": "取締役総数", "format": "○名", "sourceHint": "基本情報の役員リスト人数" },
  ...
]
\`\`\`

ルール:
- **全てのスロットに対して出力する**（省略不可）
- 周辺の文脈（「募集株式の数 ○○○株」「代表取締役　○○●●」等）を手がかりに意味を特定
- 同じ型の値が複数あっても、文脈から区別する（例: 払込期日 vs 決議日 vs 作成日）
- 推測が難しいときは label を "不明" にしてよい（format/sourceHint は空でも可）
- JSON のみ返す（説明文不要）`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\[[\s\S]*\])/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1] || match[0]) as TemplateSlotLabel[];
    return parsed.filter(s => typeof s.slotId === "number");
  } catch {
    return [];
  }
}

// docx テンプレートのラベル集。キャッシュ優先、無ければ AI で生成して保存。
export async function ensureDocxLabels(templatePath: string): Promise<TemplateLabels | null> {
  try {
    const buf = await fs.readFile(templatePath);
    const hash = sha256(buf);
    const cached = await loadCachedLabels(templatePath, hash);
    if (cached) return cached;

    const { extractMarkedFields, getMarkedDocumentText } = await import("./docx-marker-parser");
    const fields = extractMarkedFields(buf);
    if (fields.length === 0) return null;

    const markedText = getMarkedDocumentText(buf);
    const oldValues = fields.map(f => ({ slotId: f.id, value: f.originalValue }));

    const aiLabels = await askAiForLabels(markedText, oldValues);
    // fields に対応する slotId で埋める（AI がスキップしたものはフィールドの id から推測）
    const bySlot = new Map<number, TemplateSlotLabel>();
    for (const l of aiLabels) bySlot.set(l.slotId, l);

    const slots: TemplateSlotLabel[] = fields.map(f => {
      const existing = bySlot.get(f.id);
      return existing ?? {
        slotId: f.id,
        oldValue: f.originalValue,
        label: f.comment || "不明",
        format: "",
        sourceHint: "",
      };
    });
    // oldValue を必ず保存（AI が返したのとは独立に extractMarkedFields 由来）
    for (const s of slots) {
      const f = fields.find(x => x.id === s.slotId);
      if (f) s.oldValue = f.originalValue;
    }

    const result: TemplateLabels = {
      templateHash: hash,
      generatedAt: new Date().toISOString(),
      slots,
    };
    await saveLabels(templatePath, result);
    return result;
  } catch {
    return null;
  }
}

// xlsx テンプレートのラベル集（黄色セル）。docx 同様キャッシュ。
export async function ensureXlsxLabels(templatePath: string): Promise<TemplateLabels | null> {
  try {
    const buf = await fs.readFile(templatePath);
    const hash = sha256(buf);
    const cached = await loadCachedLabels(templatePath, hash);
    if (cached) return cached;

    const { extractXlsxMarkedCells, getXlsxMarkedText } = await import("./xlsx-marker-parser");
    const cells = extractXlsxMarkedCells(buf);
    if (cells.length === 0) return null;

    const markedText = getXlsxMarkedText(buf);
    const oldValues = cells.map((c, idx) => ({ slotId: idx, value: c.value }));

    const aiLabels = await askAiForLabels(markedText, oldValues);
    const bySlot = new Map<number, TemplateSlotLabel>();
    for (const l of aiLabels) bySlot.set(l.slotId, l);

    const slots: TemplateSlotLabel[] = cells.map((c, idx) => {
      const existing = bySlot.get(idx);
      return existing ?? {
        slotId: idx,
        oldValue: c.value,
        label: `セル${c.ref}`,
        format: "",
        sourceHint: "",
      };
    });
    for (const s of slots) {
      const c = cells[s.slotId];
      if (c) s.oldValue = c.value;
    }

    const result: TemplateLabels = {
      templateHash: hash,
      generatedAt: new Date().toISOString(),
      slots,
    };
    await saveLabels(templatePath, result);
    return result;
  } catch {
    return null;
  }
}

// フォルダ内の全テンプレートに対して一括でラベルを準備
export async function ensureFolderLabels(templateFolderPath: string): Promise<Record<string, TemplateLabels>> {
  const result: Record<string, TemplateLabels> = {};
  try {
    const entries = await fs.readdir(templateFolderPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (e) => {
        if (e.isDirectory()) return;
        const p = path.join(templateFolderPath, e.name);
        const ext = path.extname(e.name).toLowerCase();
        let labels: TemplateLabels | null = null;
        if (ext === ".docx" || ext === ".docm") labels = await ensureDocxLabels(p);
        else if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") labels = await ensureXlsxLabels(p);
        if (labels) result[e.name] = labels;
      })
    );
  } catch { /* ignore */ }
  return result;
}
