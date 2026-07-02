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
import type { Jirei, JireiDocument } from "@/types/jirei";
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

function produceDocx(templateBuf: Buffer, filled: Record<string, string>): Buffer {
  let buf = replaceMarkedFields(templateBuf, filled);
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

// 事由の全書類を生成する。
export function produceJireiDocuments(args: {
  jirei: Jirei;
  templates: Map<string, Buffer>;          // templateFile → テンプレの Buffer
  filled: Record<string, string>;          // buildFillMap の結果（ラベル → 値）
  getList: (key: string) => Record<string, string>[]; // factList の供給
}): ProducedDoc[] {
  const { jirei, templates, filled, getList } = args;
  const out: ProducedDoc[] = [];
  for (const doc of jirei.documents) {
    const templateBuf = templates.get(doc.templateFile);
    if (!templateBuf) continue;
    const list = doc.repeatOverFactList ? getList(doc.repeatOverFactList) : [];
    const buf =
      doc.kind === "docx"
        ? produceDocx(templateBuf, filled)
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
