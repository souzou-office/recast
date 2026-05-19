// produce-edits.ts
// 新 produce パイプラインの編集エンジン。
//
// AI (per-doc Haiku) が返す JSON:
//   { deletes: [{anchor}], adds: [{afterAnchor, contents[]}], fills: {★label★: value} }
// このエンジンが docx に対して:
//   1. flatten: ハイライト/赤フォント を ★label★ プレーンテキストに変換
//   2. deletes: anchor を含む段落を削除
//   3. adds: afterAnchor の直後に新規段落を挿入
//   4. fills: ★label★ をプレーンテキストで値置換
// の順に適用する。判断ゼロ。AI が anchor を指定し、サーバは指示通りに動くだけ。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");
import type { TemplateLabels } from "./template-labels";
import { replaceXlsxMarkedCellsBySlot } from "./xlsx-marker-parser";

export interface DeleteOp {
  anchor: string;
  expectedMatches?: number; // default 1
}
export interface AddOp {
  afterAnchor: string;
  contents: string[]; // 各要素 = 新しい1段落の本文
  expectedMatches?: number; // default 1
}
export type FillsOp = Record<string, string>; // { "★label★": "value" }

export interface ProduceEdits {
  deletes?: DeleteOp[];
  adds?: AddOp[];
  fills?: FillsOp;
}

export interface EditResult {
  buf: Buffer;
  applied: { kind: string; detail: string }[];
  skipped: { kind: string; detail: string; reason: string }[];
}

// --- XML ヘルパー ---

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// <mc:AlternateContent> ブロックを除去 (内部の偽 <w:p> が段落マッチを壊すため)
function stripAlternateContent(xml: string): string {
  return xml.replace(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g, "");
}

// <w:r> からテキストを抽出
function getRunText(runXml: string): string {
  const texts: string[] = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(runXml)) !== null) texts.push(m[1]);
  return decodeXml(texts.join(""));
}
function hasHighlight(runXml: string): boolean {
  return (
    /<w:highlight\s+w:val="[^"]*"\s*\/>/.test(runXml) ||
    /<w:color\s+w:val="FF0000"\s*\/>/i.test(runXml)
  );
}

// ネスト <w:p> を考慮した「トップレベル <w:p>」の列挙
type ParaRange = { start: number; end: number; openEnd: number };
function findTopLevelParagraphs(xml: string): ParaRange[] {
  const results: ParaRange[] = [];
  let pos = 0;
  const pOpenRe = /<w:p\b[^>]*>/g;
  while (pos < xml.length) {
    pOpenRe.lastIndex = pos;
    const mOpen = pOpenRe.exec(xml);
    if (!mOpen) break;
    if (results.some((r) => r.start < mOpen.index && mOpen.index < r.end)) {
      pos = mOpen.index + mOpen[0].length;
      continue;
    }
    const openEnd = mOpen.index + mOpen[0].length;
    let i = openEnd;
    let pDepth = 0;
    let closeAt = -1;
    while (i < xml.length) {
      if (/^<w:p[\s>]/.test(xml.slice(i, i + 5))) {
        pDepth++;
        const tagEnd = xml.indexOf(">", i);
        if (tagEnd < 0) break;
        i = tagEnd + 1;
        continue;
      }
      if (xml.startsWith("</w:p>", i)) {
        if (pDepth === 0) {
          closeAt = i;
          break;
        }
        pDepth--;
        i += "</w:p>".length;
        continue;
      }
      i++;
    }
    if (closeAt < 0) {
      pos = openEnd;
      continue;
    }
    results.push({ start: mOpen.index, end: closeAt + "</w:p>".length, openEnd });
    pos = closeAt + "</w:p>".length;
  }
  return results;
}

function getParagraphText(pXml: string): string {
  const texts: string[] = [];
  const re = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  let m;
  while ((m = re.exec(pXml)) !== null) texts.push(getRunText(m[0]));
  return texts.join("");
}

// --- ステップ 1: ハイライトを ★label★ プレーンテキストに変換 ---

function flattenHighlights(docXml: string, labels: TemplateLabels | null): string {
  const labelById = new Map<number, string>();
  for (const s of labels?.slots || []) {
    if (s.label && s.label !== "不明") labelById.set(s.slotId, s.label);
  }

  let slotId = 0;
  const paragraphs = findTopLevelParagraphs(docXml);

  // 各段落を後ろから処理して位置ずれを防ぐ
  for (let p = paragraphs.length - 1; p >= 0; p--) {
    const para = paragraphs[p];
    const inner = docXml.slice(para.openEnd, para.end - "</w:p>".length);
    // テキストボックス内の <w:p> はスキップ (= 別段落として扱わない)
    const innerNoTxbx = inner.replace(/<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g, "");

    // 段落内の連続したハイライトラン群を 1 つの slot として扱い、★label★ プレーン run に置換
    const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    const runMatches: { start: number; end: number; highlighted: boolean; text: string }[] = [];
    let m;
    while ((m = runRe.exec(inner)) !== null) {
      // テキストボックス内の run は除外
      const txbxStart = inner.indexOf("<w:txbxContent", 0);
      const txbxEnd = inner.indexOf("</w:txbxContent>", 0);
      if (txbxStart >= 0 && txbxEnd > txbxStart && m.index > txbxStart && m.index < txbxEnd) continue;
      const text = getRunText(m[0]);
      if (!text) continue;
      runMatches.push({
        start: m.index,
        end: m.index + m[0].length,
        highlighted: hasHighlight(m[0]),
        text,
      });
    }
    // この段落でハイライトされた slot を確認しないことには slotId を進められない (順番依存)。
    // 一度走査して slot 範囲を抽出する。
    const slotGroups: { start: number; end: number; slotId: number; label: string }[] = [];
    let groupStart: number | null = null;
    let groupEnd: number | null = null;
    const flushGroup = () => {
      if (groupStart !== null && groupEnd !== null) {
        const label = labelById.get(slotId) || `要入力_${slotId}`;
        slotGroups.push({ start: groupStart, end: groupEnd, slotId, label });
        slotId++;
        groupStart = null;
        groupEnd = null;
      }
    };
    for (const r of runMatches) {
      if (r.highlighted) {
        if (groupStart === null) groupStart = r.start;
        groupEnd = r.end;
      } else {
        flushGroup();
      }
    }
    flushGroup();

    if (slotGroups.length === 0) continue;

    // 段落内の文字列を slot ごとに「★label★ プレーン run」に置き換える (後ろから)
    let newInner = inner;
    // 段落 inner は元の docXml の slice なので、置換は inner ベースで行う。
    // slotGroups の start/end は inner 内 offset。
    for (let g = slotGroups.length - 1; g >= 0; g--) {
      const grp = slotGroups[g];
      const replacement = makePlainRun(`★${grp.label}★`);
      newInner = newInner.slice(0, grp.start) + replacement + newInner.slice(grp.end);
    }

    // 段落本体を更新 (テキストボックス含む inner を更新)
    // ただし上記の slotGroups は innerNoTxbx ベースでなく inner ベースで取った。
    // テキストボックス内の run は除外したので、置換位置はテキストボックス外。
    docXml = docXml.slice(0, para.openEnd) + newInner + docXml.slice(para.end - "</w:p>".length);
    void innerNoTxbx; // unused
  }

  return docXml;
}

function makePlainRun(text: string): string {
  return `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function makeParagraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

// --- ステップ 2: 削除 ---

function applyDeletes(
  docXml: string,
  deletes: DeleteOp[],
  log: { applied: { kind: string; detail: string }[]; skipped: { kind: string; detail: string; reason: string }[] }
): string {
  for (const d of deletes) {
    const expected = d.expectedMatches ?? 1;
    const paragraphs = findTopLevelParagraphs(docXml);
    const matched: ParaRange[] = [];
    for (const p of paragraphs) {
      const innerXml = docXml.slice(p.openEnd, p.end - "</w:p>".length);
      const text = getParagraphText(innerXml);
      if (text.includes(d.anchor)) matched.push(p);
    }
    if (matched.length === 0) {
      log.skipped.push({ kind: "delete", detail: d.anchor, reason: "anchor が見つからない" });
      continue;
    }
    if (matched.length !== expected) {
      log.skipped.push({
        kind: "delete",
        detail: d.anchor,
        reason: `expectedMatches=${expected} と実マッチ数 ${matched.length} が一致しない`,
      });
      continue;
    }
    // 後ろから削除して位置ずれ防止
    for (let i = matched.length - 1; i >= 0; i--) {
      const r = matched[i];
      docXml = docXml.slice(0, r.start) + docXml.slice(r.end);
    }
    log.applied.push({ kind: "delete", detail: d.anchor });
  }
  return docXml;
}

// --- ステップ 3: 追加 ---

function applyAdds(
  docXml: string,
  adds: AddOp[],
  log: { applied: { kind: string; detail: string }[]; skipped: { kind: string; detail: string; reason: string }[] }
): string {
  for (const a of adds) {
    const expected = a.expectedMatches ?? 1;
    const paragraphs = findTopLevelParagraphs(docXml);
    const matched: ParaRange[] = [];
    for (const p of paragraphs) {
      const innerXml = docXml.slice(p.openEnd, p.end - "</w:p>".length);
      const text = getParagraphText(innerXml);
      if (text.includes(a.afterAnchor)) matched.push(p);
    }
    if (matched.length === 0) {
      log.skipped.push({ kind: "add", detail: a.afterAnchor, reason: "afterAnchor が見つからない" });
      continue;
    }
    if (matched.length !== expected) {
      log.skipped.push({
        kind: "add",
        detail: a.afterAnchor,
        reason: `expectedMatches=${expected} と実マッチ数 ${matched.length} が一致しない`,
      });
      continue;
    }
    // 最初のマッチの直後に挿入 (後ろから処理する必要なし。1 箇所のみ)
    const target = matched[0];
    const newParagraphs = a.contents.map(makeParagraph).join("");
    docXml = docXml.slice(0, target.end) + newParagraphs + docXml.slice(target.end);
    log.applied.push({ kind: "add", detail: `${a.afterAnchor} → ${a.contents.length} 段落` });
  }
  return docXml;
}

// --- ステップ 4: ★label★ → 値 のテキスト置換 ---

function applyFills(
  docXml: string,
  fills: FillsOp,
  log: { applied: { kind: string; detail: string }[]; skipped: { kind: string; detail: string; reason: string }[] }
): string {
  for (const [marker, rawValue] of Object.entries(fills)) {
    if (!marker) continue;
    // XML 内のテキストノード (<w:t>...</w:t>) の中身を対象に置換する。
    // marker は flattenHighlights 後に <w:t> 内の連続テキストとして存在しているはず
    const value = escapeXml(rawValue ?? "");
    const escapedMarker = escapeXml(marker);
    let count = 0;
    docXml = docXml.replace(
      /<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g,
      (m, attrs, txt) => {
        if (!txt.includes(escapedMarker)) return m;
        const replaced = txt.split(escapedMarker).join(value);
        count += (txt.length - replaced.length) / Math.max(1, escapedMarker.length - value.length || 1);
        // attrs 内の xml:space="preserve" は維持する
        const hasPreserve = /xml:space="preserve"/.test(attrs);
        const newAttrs = hasPreserve ? attrs : `${attrs} xml:space="preserve"`;
        return `<w:t${newAttrs}>${replaced}</w:t>`;
      }
    );
    if (count > 0) log.applied.push({ kind: "fill", detail: `${marker} (${count}件)` });
    else log.skipped.push({ kind: "fill", detail: marker, reason: "テンプレに該当マーカーが存在しない" });
  }
  return docXml;
}

// --- 公開関数 ---

export async function applyProduceEditsDocx(
  buf: Buffer,
  edits: ProduceEdits,
  labels: TemplateLabels | null
): Promise<EditResult> {
  const zip = new PizZip(buf);
  let docXml: string = zip.file("word/document.xml")?.asText() || "";
  docXml = stripAlternateContent(docXml);

  const log = {
    applied: [] as { kind: string; detail: string }[],
    skipped: [] as { kind: string; detail: string; reason: string }[],
  };

  // 1. flatten (highlights → ★label★ plain text)
  docXml = flattenHighlights(docXml, labels);

  // 2. deletes
  if (edits.deletes && edits.deletes.length > 0) {
    docXml = applyDeletes(docXml, edits.deletes, log);
  }

  // 3. adds
  if (edits.adds && edits.adds.length > 0) {
    docXml = applyAdds(docXml, edits.adds, log);
  }

  // 4. fills
  if (edits.fills && Object.keys(edits.fills).length > 0) {
    docXml = applyFills(docXml, edits.fills, log);
  }

  zip.file("word/document.xml", docXml);
  const outBuf = zip.generate({ type: "nodebuffer" });
  return { buf: outBuf, applied: log.applied, skipped: log.skipped };
}

// ===========================================================================
// xlsx
// ===========================================================================

// 共有文字列を解析して string[] にする
function parseSharedStrings(ssXml: string): string[] {
  const result: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(ssXml)) !== null) {
    // <rPh> や <phoneticPr> は除外
    const stripped = m[1]
      .replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")
      .replace(/<phoneticPr\b[^>]*\/>/g, "");
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    const parts: string[] = [];
    let tm;
    while ((tm = tRe.exec(stripped)) !== null) parts.push(decodeXml(tm[1]));
    result.push(parts.join(""));
  }
  return result;
}

// 1セル分のテキストを解決 (shared string / inline string / direct value)
function resolveCellText(cellAttrs: string, cellInner: string, sharedStrings: string[]): string {
  const tMatch = cellAttrs.match(/\bt="([^"]*)"/);
  const t = tMatch ? tMatch[1] : "";
  if (t === "s") {
    const vMatch = cellInner.match(/<v>(\d+)<\/v>/);
    if (vMatch) return sharedStrings[parseInt(vMatch[1], 10)] || "";
    return "";
  }
  if (t === "inlineStr") {
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    const parts: string[] = [];
    let m;
    while ((m = tRe.exec(cellInner)) !== null) parts.push(decodeXml(m[1]));
    return parts.join("");
  }
  // direct value
  const vMatch = cellInner.match(/<v>([^<]*)<\/v>/);
  return vMatch ? decodeXml(vMatch[1]) : "";
}

// row r="N" 属性と内部の <c r="ColN"> を delta だけシフト (afterRowNum より大きい行が対象)
function shiftRowsAfterXlsx(sheetXml: string, afterRowNum: number, delta: number): string {
  return sheetXml.replace(
    /<row\b([^>]*?)r="(\d+)"([^>]*?)>([\s\S]*?)<\/row>/g,
    (match: string, pre: string, n: string, post: string, inner: string) => {
      const num = parseInt(n, 10);
      if (num <= afterRowNum) return match;
      const newNum = num + delta;
      if (newNum <= 0) return match;
      const newInner = inner.replace(/(r=")([A-Z]+)(\d+)(")/g, (mm: string, p1: string, col: string, n2: string, p4: string) => {
        const cellRow = parseInt(n2, 10);
        if (cellRow !== num) return mm;
        return `${p1}${col}${newNum}${p4}`;
      });
      return `<row${pre}r="${newNum}"${post}>${newInner}</row>`;
    }
  );
}

// 数式 (<f>...</f>) 内のセル参照を delta だけシフト (afterRowNum より大きい行参照が対象)。
// row.r や cell.r とは別軸: 数式は他のセルを「住所」で指しているので、シフトされた行の cell を
// 参照している式は全部更新する必要がある (formula の存在場所は関係ない)。
//
// 対応する参照:
//   - 単純参照: A1, $A$1, A$1, $A1
//   - 範囲: A1:A10 (各端点を独立に更新)
//   - シート修飾: Sheet1!A1 (regex がそのまま A1 部分を拾うので動く)
//   - キャッシュ値 <v> は更新しない (Excel が開いたとき自動再計算)
//
// 対応しない: 名前定義 (workbook.xml の definedName) / 条件付き書式の範囲 / グラフ系
function shiftFormulaRefs(sheetXml: string, afterRowNum: number, delta: number): string {
  return sheetXml.replace(/<f\b([^>]*)>([\s\S]*?)<\/f>/g, (match: string, attrs: string, formula: string) => {
    const newFormula = formula.replace(
      /(\$?)([A-Z]+)(\$?)(\d+)/g,
      (_: string, dollarCol: string, col: string, dollarRow: string, n: string) => {
        const num = parseInt(n, 10);
        if (num <= afterRowNum) return `${dollarCol}${col}${dollarRow}${n}`;
        const newNum = num + delta;
        if (newNum <= 0) return `${dollarCol}${col}${dollarRow}${n}`; // would be #REF! in Excel
        return `${dollarCol}${col}${dollarRow}${newNum}`;
      }
    );
    return `<f${attrs}>${newFormula}</f>`;
  });
}

// 行 anchor 検索: anchor を含むセルがある最初の row を返す
function findRowWithAnchorXlsx(
  sheetXml: string,
  anchor: string,
  sharedStrings: string[]
): { rowNum: number; start: number; end: number } | null {
  const rowRe = /<row\b[^>]*?r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let m;
  while ((m = rowRe.exec(sheetXml)) !== null) {
    const rowNum = parseInt(m[1], 10);
    const inner = m[2];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(inner)) !== null) {
      const text = resolveCellText(cm[1], cm[2] || "", sharedStrings);
      if (text.includes(anchor)) {
        return { rowNum, start: m.index, end: m.index + m[0].length };
      }
    }
  }
  return null;
}

// 列番号 → A,B,C... AA,AB...
function colLetter(idx: number): string {
  let n = idx;
  let s = "";
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function makeXlsxRow(rowNum: number, csvLine: string): string {
  // CSV を簡易パース (タブ or カンマ区切り、引用符はあれば剥がす)
  const sep = csvLine.includes("\t") ? "\t" : ",";
  const cells = csvLine.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
  const cellXml = cells
    .map((val, i) => {
      const ref = `${colLetter(i)}${rowNum}`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(val)}</t></is></c>`;
    })
    .join("");
  return `<row r="${rowNum}">${cellXml}</row>`;
}

// 全 xml ファイル (sharedStrings, 各 sheet) の <t>...</t> 中の marker を value に置換
function applyFillsTextEverywhere(zip: typeof PizZip.prototype, fills: FillsOp): { applied: number } {
  let totalApplied = 0;
  const targetFiles = Object.keys(zip.files).filter(
    (fn) => /^xl\/worksheets\/sheet\d+\.xml$/.test(fn) || fn === "xl/sharedStrings.xml"
  );
  for (const fn of targetFiles) {
    let xml = zip.file(fn)?.asText();
    if (!xml) continue;
    let changed = false;
    for (const [marker, rawValue] of Object.entries(fills)) {
      if (!marker) continue;
      const escMarker = escapeXml(marker);
      const escValue = escapeXml(rawValue ?? "");
      const newXml = xml.replace(
        /<t\b([^>]*)>([\s\S]*?)<\/t>/g,
        (m: string, attrs: string, content: string) => {
          if (!content.includes(escMarker)) return m;
          const replaced = content.split(escMarker).join(escValue);
          totalApplied += (content.match(new RegExp(escapeRegex(escMarker), "g")) || []).length;
          const hasPreserve = /xml:space="preserve"/.test(attrs);
          const newAttrs = hasPreserve ? attrs : `${attrs} xml:space="preserve"`;
          return `<t${newAttrs}>${replaced}</t>`;
        }
      );
      if (newXml !== xml) {
        xml = newXml;
        changed = true;
      }
    }
    if (changed) zip.file(fn, xml);
  }
  return { applied: totalApplied };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function applyProduceEditsXlsx(
  buf: Buffer,
  edits: ProduceEdits,
  labels: TemplateLabels | null
): Promise<EditResult> {
  const log = {
    applied: [] as { kind: string; detail: string }[],
    skipped: [] as { kind: string; detail: string; reason: string }[],
  };

  // 1. flatten: 既存マーカー (黄色/赤フォント/赤rich text) を ★label★ プレーンテキストに変換
  //    → 後段の deletes/adds/fills が全部テキストベースで動く
  const slotReplacements = new Map<number, string>();
  for (const s of labels?.slots || []) {
    const label = s.label && s.label !== "不明" ? s.label : `要入力_${s.slotId}`;
    slotReplacements.set(s.slotId, `★${label}★`);
  }
  if (slotReplacements.size > 0) {
    buf = replaceXlsxMarkedCellsBySlot(buf, slotReplacements);
    log.applied.push({ kind: "flatten", detail: `${slotReplacements.size} 個のマーカーを ★label★ に展開` });
  }

  // 2. deletes / adds は各シートに対して XML 操作で適用
  const zip = new PizZip(buf);
  const sheetFiles = Object.keys(zip.files)
    .filter((fn) => /^xl\/worksheets\/sheet\d+\.xml$/.test(fn))
    .sort();
  const ssXml = zip.file("xl/sharedStrings.xml")?.asText() || "";
  const sharedStrings = parseSharedStrings(ssXml);

  for (const sheetFile of sheetFiles) {
    let sheetXml = zip.file(sheetFile)?.asText();
    if (!sheetXml) continue;
    let changed = false;

    // 2-1. deletes
    for (const d of edits.deletes || []) {
      const target = findRowWithAnchorXlsx(sheetXml, d.anchor, sharedStrings);
      if (!target) {
        log.skipped.push({ kind: "delete-xlsx", detail: d.anchor, reason: "anchor が見つからない" });
        continue;
      }
      // 行を削除
      sheetXml = sheetXml.slice(0, target.start) + sheetXml.slice(target.end);
      // 後続の行番号を -1 シフト + 数式内のセル参照も同様にシフト
      sheetXml = shiftRowsAfterXlsx(sheetXml, target.rowNum, -1);
      sheetXml = shiftFormulaRefs(sheetXml, target.rowNum, -1);
      log.applied.push({ kind: "delete-xlsx", detail: `row ${target.rowNum} (${d.anchor})` });
      changed = true;
    }

    // 2-2. adds
    for (const a of edits.adds || []) {
      const target = findRowWithAnchorXlsx(sheetXml, a.afterAnchor, sharedStrings);
      if (!target) {
        log.skipped.push({ kind: "add-xlsx", detail: a.afterAnchor, reason: "afterAnchor が見つからない" });
        continue;
      }
      const numAdded = a.contents.length;
      // 後続の行を +numAdded シフト + 数式内のセル参照も同様にシフト
      sheetXml = shiftRowsAfterXlsx(sheetXml, target.rowNum, numAdded);
      sheetXml = shiftFormulaRefs(sheetXml, target.rowNum, numAdded);
      // target.end は不変 (target 以前のバイトは変わってないため)
      const newRows = a.contents
        .map((csv, i) => makeXlsxRow(target.rowNum + 1 + i, csv))
        .join("");
      sheetXml = sheetXml.slice(0, target.end) + newRows + sheetXml.slice(target.end);
      log.applied.push({ kind: "add-xlsx", detail: `${a.afterAnchor} 後に ${numAdded} 行追加` });
      changed = true;
    }

    if (changed) zip.file(sheetFile, sheetXml);
  }

  // 3. fills: 全 xml の <t>...</t> 内テキストで ★label★ → 値 (text 置換)
  if (edits.fills && Object.keys(edits.fills).length > 0) {
    const r = applyFillsTextEverywhere(zip, edits.fills);
    if (r.applied > 0) log.applied.push({ kind: "fill-xlsx", detail: `${r.applied} 件の ★label★ を置換` });
  }

  const outBuf = zip.generate({ type: "nodebuffer" });
  return { buf: outBuf, applied: log.applied, skipped: log.skipped };
}

