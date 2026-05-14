// template-normalize.ts
//
// テンプレに混在する 4 系統のマーク (黄色塗り / 赤フォント / 【…】 / {{…}}) を AI 視野では
// **★ラベル★ の 1 種類だけ** に正規化する。AI は ★ラベル★ の付近の文脈から意味を判断して、
// 「★ラベル★ にこの値を入れる」「この段落を削除する」だけを返す。slot 番号や置換テーブルの
// 概念は AI 視野には一切出さない。
//
// 旧設計 (要入力_N + labels.json + 各種フォールバック) は捨てた。
//
// このモジュールは「マーク → AI 視野」だけ担当する。edit を docx/xlsx に適用するのは
// edit-engine.ts の責務。

import { ensureDocxLabels, ensureXlsxLabels } from "./template-labels";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

const decodeXml = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/**
 * SlotRef は **★ラベル★ がテンプレ内のどこに対応するか** を、サーバーが内部で
 * 物理位置として保持するための値。AI には絶対に渡さない。
 *
 * - `kind="docx-highlight"`: docx の黄色塗り or 赤フォントの run 群。replaceMarkedFieldsBySlot
 *   と同じ走査順で振った slotId を保持。modify は slotId を介して既存ロジックで実施。
 * - `kind="docx-placeholder"`: docx の 【…】 / {{…}} 系プレースホルダー。テキスト直接置換。
 * - `kind="xlsx-highlight"`: xlsx の黄色セル / 赤フォントセル / 赤 run。slotId は
 *   replaceXlsxMarkedCellsBySlot の走査順。
 * - `kind="xlsx-placeholder"`: xlsx の 【…】 / {{…}} 系プレースホルダー。テキスト直接置換。
 */
export type SlotRef =
  | { kind: "docx-highlight"; slotId: number; originalValue: string }
  | { kind: "docx-placeholder"; placeholder: string; openClose: [string, string] }
  | { kind: "xlsx-highlight"; slotId: number; originalValue: string }
  | { kind: "xlsx-placeholder"; placeholder: string; openClose: [string, string] };

export interface NormalizedTemplate {
  /**
   * AI に見せるテキスト。マーク部は全て `★ラベル★` に置換済み。
   * AI は本文中の `★ラベル★` をそのままコピーして edit の `find` 欄に入れる前提。
   */
  markedText: string;
  /**
   * **★ を含む完全な文字列** (例: `★同意書の日付★`) → 物理 slot 参照リスト。
   * 同じ marker が複数箇所に出ていれば全 ref に同じ値を流し込む。
   *
   * 設計判断: 旧 `labelToSlots` (key = "同意書の日付") では AI が意味を優先して
   * "株主の同意日" のような別名に言い換えてしまい、key 一致しなくなる事故が頻発した。
   * key を ★ 込みの完全文字列にすると、AI は本文中の文字列を**リテラル引用**するだけで済む
   * (言い換えると一致しない → 自然にコピペが促される) ので、言い換え問題が構造的に消える。
   */
  markerToSlots: Map<string, SlotRef[]>;
}

// --- docx 用 ---

// docx-marker-parser と同じハイライト判定 (黄色塗り or 赤フォント)
function hasHighlight(runXml: string): boolean {
  return /<w:highlight\s+w:val="[^"]*"\s*\/>/.test(runXml) || /<w:color\s+w:val="FF0000"\s*\/>/i.test(runXml);
}

function getRunText(runXml: string): string {
  const texts: string[] = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(runXml)) !== null) texts.push(m[1]);
  return decodeXml(texts.join(""));
}

/** ハイライト slot のテキストから「意味のあるラベル」を作る。labels.json があればそれを優先。 */
function pickLabelForHighlightSlot(
  slotId: number,
  originalValue: string,
  labelByCacheId: Map<number, string> | null,
): string {
  // labels.json から取れたラベルが第一優先 (Sonnet 4.6 が文脈で付けたラベル)
  if (labelByCacheId) {
    const cached = labelByCacheId.get(slotId);
    if (cached && cached !== "不明") return cached;
  }
  // フォールバック: originalValue が短ければそれ自体をラベルに (見出し・氏名等)、
  // 長すぎる/空なら "未分類_N" にする (AI が前後文脈で意味を判断する)
  const trimmed = originalValue.trim();
  if (trimmed && trimmed.length <= 30) return trimmed;
  return `未分類_${slotId}`;
}

/** プレースホルダー `【foo】` `{{foo}}` `｛｛foo｝｝` `＜foo＞` `［foo］` を抽出 */
const PLACEHOLDER_PATTERNS: { open: string; close: string; re: RegExp }[] = [
  { open: "【", close: "】", re: /【([^】]+)】/g },
  { open: "{{", close: "}}", re: /\{\{([^}]+)\}\}/g },
  { open: "｛｛", close: "｝｝", re: /｛｛([^｝]+)｝｝/g },
  { open: "＜", close: "＞", re: /＜([^＞]+)＞/g },
  { open: "［", close: "］", re: /［([^\］]+)］/g },
];

/**
 * docx Buffer を ★ラベル★ 正規化形に。
 *
 * 戦略:
 *   1. labels.json を取得 (黄色塗り・赤フォント slot に意味ラベルを付与)
 *   2. document.xml を走査し、段落ごとにテキストを再構築
 *   3. ハイライト run 群は ★labels.json のラベル★ に置換、SlotRef を労 push
 *   4. 段落内のプレーンテキストに 【foo】系プレースホルダーが残っていればそれも ★foo★ に置換、SlotRef を push
 */
export async function normalizeDocxTemplate(
  buffer: Buffer,
  templatePath?: string,
): Promise<NormalizedTemplate> {
  const zip = new PizZip(buffer);
  let docXml = zip.file("word/document.xml")?.asText();
  if (!docXml) return { markedText: "", markerToSlots: new Map() };
  // <mc:AlternateContent> 内の偽 <w:p> は除去 (docx-marker-parser と同じ前処理)
  docXml = docXml.replace(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g, "");

  // labels.json (テンプレ別キャッシュ) を取得
  let labelByCacheId: Map<number, string> | null = null;
  if (templatePath) {
    try {
      const labels = await ensureDocxLabels(templatePath);
      if (labels) {
        labelByCacheId = new Map();
        for (const s of labels.slots) {
          labelByCacheId.set(s.slotId, s.label);
        }
      }
    } catch { /* ignore: ラベル無しでも動かす */ }
  }

  const markerToSlots = new Map<string, SlotRef[]>();
  const pushSlot = (label: string, ref: SlotRef) => {
    // marker は ★ラベル★ そのもの。AI が find に書く文字列とそのまま一致させる
    const marker = `★${label}★`;
    const list = markerToSlots.get(marker) || [];
    list.push(ref);
    markerToSlots.set(marker, list);
  };

  // 段落ごとの ★ラベル★ 化 (docx-marker-parser の getMarkedDocumentTextWithSlots と同じ走査順)
  const lines: string[] = [];
  let slotId = 0;
  const pRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(docXml as string)) !== null) {
    const pXml = pm[0];
    // テキストボックス内は別段落として扱うので除去
    const inner = pXml.replace(/<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g, "");
    const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    let rm: RegExpExecArray | null;
    let lineText = "";
    let currentGroupText = "";
    const flushGroup = () => {
      if (!currentGroupText) return;
      const label = pickLabelForHighlightSlot(slotId, currentGroupText, labelByCacheId);
      pushSlot(label, { kind: "docx-highlight", slotId, originalValue: currentGroupText });
      lineText += `★${label}★`;
      slotId++;
      currentGroupText = "";
    };
    while ((rm = runRe.exec(inner)) !== null) {
      const text = getRunText(rm[0]);
      if (!text) continue;
      if (hasHighlight(rm[0])) {
        currentGroupText += text;
      } else {
        flushGroup();
        lineText += text;
      }
    }
    flushGroup();
    if (lineText.trim()) lines.push(lineText);
  }

  let markedText = lines.join("\n");

  // 段落テキスト内に残った 【foo】系プレースホルダーを ★foo★ に置換し、SlotRef も push
  for (const p of PLACEHOLDER_PATTERNS) {
    markedText = markedText.replace(p.re, (_, name: string) => {
      const label = name.trim();
      if (label.startsWith("#") || label.startsWith("/")) {
        // 条件分岐 {{#flag}}...{{/flag}} の制御マーカーは ★化しない (delete edit で対応)
        return `${p.open}${name}${p.close}`;
      }
      pushSlot(label, { kind: "docx-placeholder", placeholder: name, openClose: [p.open, p.close] });
      return `★${label}★`;
    });
  }

  return { markedText, markerToSlots };
}

// --- xlsx 用 ---

/**
 * xlsx Buffer を ★ラベル★ 正規化形に。
 *
 * 戦略:
 *   1. labels.json (xlsx 用) を取得 (黄色セル・赤フォントセル・赤 run に意味ラベルを付与)
 *   2. 既存の getXlsxMarkedTextWithSlots でハイライト slot を ［要入力_N] 形式で取得
 *   3. ［要入力_N] を ★ラベル★ に変換、SlotRef を push
 *   4. プレースホルダー (【foo】等) も同様に ★foo★ に置換
 */
export async function normalizeXlsxTemplate(
  buffer: Buffer,
  templatePath?: string,
): Promise<NormalizedTemplate> {
  const { getXlsxMarkedTextWithSlots } = await import("./xlsx-marker-parser");

  let labelByCacheId: Map<number, string> | null = null;
  if (templatePath) {
    try {
      const labels = await ensureXlsxLabels(templatePath);
      if (labels) {
        labelByCacheId = new Map();
        for (const s of labels.slots) {
          labelByCacheId.set(s.slotId, s.label);
        }
      }
    } catch { /* ignore */ }
  }

  const markerToSlots = new Map<string, SlotRef[]>();
  const pushSlot = (label: string, ref: SlotRef) => {
    // marker は ★ラベル★ そのもの。AI が find に書く文字列とそのまま一致させる
    const marker = `★${label}★`;
    const list = markerToSlots.get(marker) || [];
    list.push(ref);
    markerToSlots.set(marker, list);
  };

  const { text, slots } = getXlsxMarkedTextWithSlots(buffer);

  // ［要入力_N] を ★ラベル★ に置き換え、SlotRef を push
  let markedText = text.replace(/［要入力_(\d+)］/g, (_full: string, idStr: string) => {
    const id = parseInt(idStr, 10);
    const originalValue = slots.get(id) ?? "";
    const label = pickLabelForHighlightSlot(id, originalValue, labelByCacheId);
    pushSlot(label, { kind: "xlsx-highlight", slotId: id, originalValue });
    return `★${label}★`;
  });

  // テキスト内に残っている 【foo】等 placeholder も ★foo★ に正規化
  for (const p of PLACEHOLDER_PATTERNS) {
    markedText = markedText.replace(p.re, (_, name: string) => {
      const label = name.trim();
      if (label.startsWith("#") || label.startsWith("/")) {
        return `${p.open}${name}${p.close}`;
      }
      pushSlot(label, { kind: "xlsx-placeholder", placeholder: name, openClose: [p.open, p.close] });
      return `★${label}★`;
    });
  }

  return { markedText, markerToSlots };
}

// --- ファイル種別ディスパッチ ---

export async function normalizeTemplate(
  buffer: Buffer,
  fileName: string,
  templatePath?: string,
): Promise<NormalizedTemplate> {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (ext === "xlsx" || ext === "xls" || ext === "xlsm") {
    return normalizeXlsxTemplate(buffer, templatePath);
  }
  // .docx / .doc / .docm
  return normalizeDocxTemplate(buffer, templatePath);
}
