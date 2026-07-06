// 事由駆動の「書類生成」glue。
//
// 既存の穴埋めエンジン（docx/xlsx marker parser + cleanup）を import して呼ぶだけの薄い層。
// AI なし・officecli なし・決定論。PizZip の XML 直接編集のみ。
//
// テンプレの規約:
//   docx : 黄色ハイライトの文言 = スロットのラベル（例: 黄色で「会社名」）→ filled["会社名"] で置換
//   xlsx : ・単発の穴 = 《ラベル》 と書いたセル（スタイル不問・全文一致で置換）
//          ・株主ごと等の繰り返し行 = 黄色データ行（セル文言 = rowSlots のキー）。
//            行数は factList の件数に expandYellowRowBlock で自動展開される。

import { replaceMarkedFields } from "@/lib/docx-marker-parser";
import {
  replaceXlsxMarkedCells,
  expandYellowRowBlock,
  extractXlsxMarkedCells,
} from "@/lib/xlsx-marker-parser";
import { cleanupGeneratedDocx } from "@/lib/docx-cleanup";
import { ensureXlsxRecalc } from "@/lib/xlsx-cleanup";
import type { JireiDocument } from "@/types/jirei";
import PizZip from "pizzip";

export interface ProducedDoc {
  name: string;       // 表示名（拡張子なし）
  fileName: string;   // 出力ファイル名（拡張子つき）
  kind: "docx" | "xlsx";
  base64: string;
}

// 置換値の中の改行を docx の改行 (<w:br/>) に変換する。
// replaceMarkedFields は値を XML エスケープして <w:t> に入れるだけなので、
// 複数行の値（事業目的の列挙等）は生の改行文字のまま入り、Word 上で改行にならない。
// → 生成後に <w:t> 内の改行を <w:br/> 区切りに分割する（決定論の後処理）。
function fixDocxLineBreaks(buf: Buffer): Buffer {
  const zip = new PizZip(buf);
  const xml = zip.file("word/document.xml")?.asText();
  if (!xml || !/<w:t[^>]*>[^<]*\n/.test(xml)) return buf;
  const fixed = xml.replace(/<w:t([^>]*)>([^<]*)<\/w:t>/g, (whole, attrs: string, text: string) => {
    if (!text.includes("\n")) return whole;
    const parts = text.split(/\r?\n/);
    return parts
      .map((p) => `<w:t xml:space="preserve">${p}</w:t>`)
      .join(`<w:br/>`);
  });
  zip.file("word/document.xml", fixed);
  return zip.generate({ type: "nodebuffer" });
}

// ============================================================
// 【プレースホルダー】方式の置換（事務所の既存テンプレ規約・決定論）
// ============================================================
// 実物テンプレは 【令和　　年　　月　　日】 のような 【…】 を穴として使い、
// Word の編集履歴で run が細かく分割されている（【/令和/　　/年/… が別 run）。
// → 段落内の <w:t> を結合したテキスト上で 【…】 を探し、位置ベースで書き換える。
//   中の文言は空白（半角/全角）を無視して placeholders のキーと照合する。

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const normPh = (s: string) => s.replace(/[\s　]/g, "");

// 段落 XML 内の「値が決まっている最初の 【…】」を 1 つ置換する。無ければ null。
function replaceOneBracket(pXml: string, lookup: Map<string, string>): string | null {
  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  const nodes: { tagStart: number; tagEnd: number; text: string; offset: number }[] = [];
  let combined = "";
  let m: RegExpExecArray | null;
  while ((m = tRe.exec(pXml)) !== null) {
    const dec = xmlUnescape(m[1]);
    nodes.push({ tagStart: m.index, tagEnd: m.index + m[0].length, text: dec, offset: combined.length });
    combined += dec;
  }
  if (nodes.length === 0) return null;

  const phRe = /【([^【】]*)】/g;
  let span: { start: number; end: number; value: string } | null = null;
  let pm: RegExpExecArray | null;
  while ((pm = phRe.exec(combined)) !== null) {
    const v = lookup.get(normPh(pm[1]));
    if (v !== undefined) {
      span = { start: pm.index, end: pm.index + pm[0].length, value: v };
      break;
    }
  }
  if (!span) return null;

  // span と重なる各 <w:t> のテキストを書き換える（値は最初の重なりノードに入れる）
  const newTexts = new Map<number, string>();
  let inserted = false;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const nStart = n.offset;
    const nEnd = n.offset + n.text.length;
    if (nEnd <= span.start || nStart >= span.end) continue;
    const before = n.text.slice(0, Math.max(0, span.start - nStart));
    const after = n.text.slice(Math.min(n.text.length, span.end - nStart));
    newTexts.set(i, before + (inserted ? "" : span.value) + after);
    inserted = true;
  }

  // 後ろのノードから書き換えてインデックスのずれを回避
  let out = pXml;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (!newTexts.has(i)) continue;
    const n = nodes[i];
    out =
      out.slice(0, n.tagStart) +
      `<w:t xml:space="preserve">${xmlEscape(newTexts.get(i)!)}</w:t>` +
      out.slice(n.tagEnd);
  }
  return out;
}

function replaceBracketPlaceholders(
  buf: Buffer,
  placeholders: Record<string, string>, // 【内文言】(空白無視) → スロットラベル
  filled: Record<string, string>
): Buffer {
  const lookup = new Map<string, string>();
  for (const [ph, label] of Object.entries(placeholders)) {
    const v = filled[label];
    if (v !== undefined) lookup.set(normPh(ph), v);
  }
  if (lookup.size === 0) return buf;

  const zip = new PizZip(buf);
  const xml = zip.file("word/document.xml")?.asText();
  if (!xml) return buf;

  const out = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (pXml) => {
    if (!pXml.includes("【")) return pXml;
    let cur = pXml;
    // 1 つずつ置換して再走査（1 段落に複数の【…】があっても位置ずれしない）
    for (let guard = 0; guard < 50; guard++) {
      const next = replaceOneBracket(cur, lookup);
      if (next === null) break;
      cur = next;
    }
    return cur;
  });
  zip.file("word/document.xml", out);
  return zip.generate({ type: "nodebuffer" });
}

function produceDocx(
  templateBuf: Buffer,
  filled: Record<string, string>,
  doc: JireiDocument
): Buffer {
  let buf = templateBuf;
  if (doc.placeholders) buf = replaceBracketPlaceholders(buf, doc.placeholders, filled);
  buf = replaceMarkedFields(buf, filled);
  buf = fixDocxLineBreaks(buf);
  const { buf: cleaned } = cleanupGeneratedDocx(buf);
  return cleaned;
}

function produceXlsx(
  templateBuf: Buffer,
  filled: Record<string, string>,
  doc: JireiDocument,
  list: Record<string, string>[]
): Buffer {
  // 単発の穴: 《ラベル》 → 値（セル全文一致）
  const replacements: Record<string, string> = {};
  for (const [label, value] of Object.entries(filled)) {
    replacements[`《${label}》`] = value;
  }

  let buf = templateBuf;
  if (doc.rowSlots && doc.repeatOverFactList) {
    // 黄色データ行を人数分に展開（追加行のセルは __ROW_N_COL__ プレースホルダーになる）
    buf = expandYellowRowBlock(buf, list.length);

    // 展開後のマーカーセルから「列 → フィールド」対応を作る
    //   1行目(テンプレ行)のセル文言 = rowSlots のキー → その列に入るフィールドが判る
    const marked = extractXlsxMarkedCells(buf);
    const colToField = new Map<string, string>();
    for (const cell of marked) {
      const field = doc.rowSlots[cell.value];
      if (field) {
        const col = cell.ref.replace(/\d+$/, "");
        colToField.set(col, field);
        // 1行目: セル文言そのものをキーに、1人目の値で置換
        replacements[cell.value] = list[0]?.[field] ?? "";
      }
    }
    // 追加行: __ROW_N_COL__ → (N の昇順で 2人目, 3人目, …)
    const placeholderRows = new Set<number>();
    for (const cell of marked) {
      const m = cell.value.match(/^__ROW_(\d+)_[A-Z]+__$/);
      if (m) placeholderRows.add(parseInt(m[1], 10));
    }
    const rowOrder = [...placeholderRows].sort((a, b) => a - b);
    const rowToListIndex = new Map<number, number>();
    rowOrder.forEach((rowNum, i) => rowToListIndex.set(rowNum, i + 1)); // 1行目=list[0] 済み
    for (const cell of marked) {
      const m = cell.value.match(/^__ROW_(\d+)_([A-Z]+)__$/);
      if (!m) continue;
      const idx = rowToListIndex.get(parseInt(m[1], 10));
      const field = colToField.get(m[2]);
      replacements[cell.value] =
        idx !== undefined && field ? (list[idx]?.[field] ?? "") : "";
    }
  }

  let out = replaceXlsxMarkedCells(buf, replacements);
  const { buf: recalced } = ensureXlsxRecalc(out);
  out = recalced;
  return out;
}

// 事由の必要書類を生成する。documents は呼び出し側で when 評価済み（requiredDocuments の結果）を渡す。
export function produceJireiDocuments(args: {
  documents: JireiDocument[];              // 生成する書類（requiredDocuments の結果）
  templates: Map<string, Buffer>;          // templateFile → テンプレの Buffer
  filled: Record<string, string>;          // buildFillMap の結果（ラベル → 値）
  getList: (key: string) => Record<string, string>[]; // factList の供給
}): ProducedDoc[] {
  const { documents, templates, filled, getList } = args;
  const out: ProducedDoc[] = [];
  for (const doc of documents) {
    const templateBuf = templates.get(doc.templateFile);
    if (!templateBuf) continue;
    const list = doc.repeatOverFactList ? getList(doc.repeatOverFactList) : [];
    const buf =
      doc.kind === "docx"
        ? produceDocx(templateBuf, filled, doc)
        : produceXlsx(templateBuf, filled, doc, list);
    out.push({
      name: doc.templateFile.replace(/\.(docx|xlsx)$/i, ""),
      fileName: doc.templateFile,
      kind: doc.kind,
      base64: buf.toString("base64"),
    });
  }
  return out;
}
