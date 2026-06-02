// xlsx-marker-parser.ts
// Excelの2種類のマーカーを検出し、値を差し替えるユーティリティ:
//   A) セル背景色「黄色」(FFFF00) → セル全体が可変
//   B) フォント色「赤」(FF0000)   → セル内の赤い文字 run だけが可変
// A はセル全体を AI が書き換える。B は赤い文字だけを書き換え、他は固定で残す。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

// 「標準の色：赤」が指定されたときの XML 値。Excel が固定で書き込む値。
const RED_FONT_COLOR = /\bcolor\s+rgb="FFFF0000"/i;

export interface XlsxMarkedCell {
  ref: string;       // "B14"
  value: string;     // セルの現在の値（前案件のデータ）
  sheetName: string; // シート名
}

// Excel 組み込みの日付 numFmtId（仕様で固定）
// https://learn.microsoft.com/en-us/office/troubleshoot/excel/cells-predefined-format
const BUILTIN_DATE_NUM_FMT_IDS = new Set<number>([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47,
  50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

// formatCode が日付系かどうか判定。"年", "月", "日" 等の日本語日付も拾う。
// 引用符内の文字と [...] 修飾は除外（例: "m/d/yyyy" が date なのと同じく "h:mm" は時刻）
function isDateFormatCode(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  // y/m/d/h のいずれかを含めば日付または時刻。通貨は y/m/d を含まないので安全
  if (/[ymdh]/i.test(stripped)) return true;
  // 日本語で年月日を含む（稀に formatCode に直接書かれるケース）
  if (/[年月日時分秒]/.test(code)) return true;
  return false;
}

// styles.xml から「日付フォーマット適用済み」のセルスタイルインデックスを特定
function findDateStyleIndexes(stylesXml: string): Set<number> {
  // まず numFmts（カスタムフォーマット）から日付フォーマット ID を収集
  const dateNumFmtIds = new Set<number>(BUILTIN_DATE_NUM_FMT_IDS);
  const numFmtsMatch = stylesXml.match(/<numFmts[^>]*>([\s\S]*?)<\/numFmts>/);
  if (numFmtsMatch) {
    const re = /<numFmt\b([^/>]*)\/>/g;
    let m;
    while ((m = re.exec(numFmtsMatch[1])) !== null) {
      const idMatch = m[1].match(/numFmtId="(\d+)"/);
      const codeMatch = m[1].match(/formatCode="([^"]*)"/);
      if (!idMatch || !codeMatch) continue;
      if (isDateFormatCode(codeMatch[1])) {
        dateNumFmtIds.add(parseInt(idMatch[1]));
      }
    }
  }

  // cellXfs の各セルスタイルのうち、numFmtId が日付系のものを特定
  const xfsMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!xfsMatch) return new Set();

  const dateStyles = new Set<number>();
  const xfRe = /<xf\b([^>]*)(?:\/>|>[\s\S]*?<\/xf>)/g;
  let xm;
  let xi = 0;
  while ((xm = xfRe.exec(xfsMatch[1])) !== null) {
    const numFmtMatch = xm[1].match(/numFmtId="(\d+)"/);
    if (numFmtMatch && dateNumFmtIds.has(parseInt(numFmtMatch[1]))) {
      dateStyles.add(xi);
    }
    xi++;
  }
  return dateStyles;
}

// パーセント書式 (formatCode に % を含む) のセルスタイル index を集める。
// %書式セルは「0.784」を入れると 78.4% と表示される (×100)。値に % を付けて入れる必要がある。
// 組み込み: 9 ("0%"), 10 ("0.00%")。
function findPercentStyleIndexes(stylesXml: string): Set<number> {
  const pctNumFmtIds = new Set<number>([9, 10]);
  const numFmtsMatch = stylesXml.match(/<numFmts[^>]*>([\s\S]*?)<\/numFmts>/);
  if (numFmtsMatch) {
    const re = /<numFmt\b([^/>]*)\/>/g;
    let m;
    while ((m = re.exec(numFmtsMatch[1])) !== null) {
      const idMatch = m[1].match(/numFmtId="(\d+)"/);
      const codeMatch = m[1].match(/formatCode="([^"]*)"/);
      if (!idMatch || !codeMatch) continue;
      if (codeMatch[1].includes("%")) pctNumFmtIds.add(parseInt(idMatch[1]));
    }
  }
  const xfsMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!xfsMatch) return new Set();
  const pctStyles = new Set<number>();
  const xfRe = /<xf\b([^>]*)(?:\/>|>[\s\S]*?<\/xf>)/g;
  let xm; let xi = 0;
  while ((xm = xfRe.exec(xfsMatch[1])) !== null) {
    const numFmtMatch = xm[1].match(/numFmtId="(\d+)"/);
    if (numFmtMatch && pctNumFmtIds.has(parseInt(numFmtMatch[1]))) pctStyles.add(xi);
    xi++;
  }
  return pctStyles;
}

// Excel シリアル日付 (1 = 1900-01-01 as per Lotus-compat) → "YYYY-MM-DD"
// 基準: 1899-12-30 UTC。Excel は 1900 年の閏年バグのため 60 を跨ぐと 1 日ずれるが、
// 46062 等の現代の日付では影響しないため簡易実装で OK。
function excelSerialToDateString(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// styles.xml から「セル全体が赤い文字」のスタイルインデックスを特定。
// ① <fonts> 内の <font> で <color rgb="FFFF0000"/> を持つ font の index を集める
// ② <cellXfs> の各 xf で fontId が該当 index を指すなら、その xf index を返す
function findRedFontStyleIndexes(stylesXml: string): Set<number> {
  const fontsMatch = stylesXml.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/);
  if (!fontsMatch) return new Set();
  const redFontIds: number[] = [];
  const fontRe = /<font>([\s\S]*?)<\/font>/g;
  let fm;
  let fi = 0;
  while ((fm = fontRe.exec(fontsMatch[1])) !== null) {
    if (/<color\s+[^/>]*\brgb="FFFF0000"[^/>]*\/>/i.test(fm[1])) {
      redFontIds.push(fi);
    }
    fi++;
  }
  if (redFontIds.length === 0) return new Set();

  const xfsMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!xfsMatch) return new Set();

  const redStyles = new Set<number>();
  const xfRe = /<xf\b([^>]*)(?:\/>|>[\s\S]*?<\/xf>)/g;
  let xm;
  let xi = 0;
  while ((xm = xfRe.exec(xfsMatch[1])) !== null) {
    const fontMatch = xm[1].match(/fontId="(\d+)"/);
    if (fontMatch && redFontIds.includes(parseInt(fontMatch[1]))) {
      redStyles.add(xi);
    }
    xi++;
  }
  return redStyles;
}

// styles.xml から黄色背景のスタイルインデックスを特定
function findYellowStyleIndexes(stylesXml: string): Set<number> {
  // fills から黄色の fillId を特定
  const fillsMatch = stylesXml.match(/<fills[^>]*>([\s\S]*?)<\/fills>/);
  if (!fillsMatch) return new Set();

  const yellowFillIds: number[] = [];
  const fillRe = /<fill>([\s\S]*?)<\/fill>/g;
  let fm;
  let fi = 0;
  while ((fm = fillRe.exec(fillsMatch[1])) !== null) {
    // FFFFFF00 = 黄色、theme="0" (一部のテーマカラー) も考慮
    if (/FFFFFF00|ffff00/i.test(fm[1])) {
      yellowFillIds.push(fi);
    }
    fi++;
  }
  if (yellowFillIds.length === 0) return new Set();

  // cellXfs から fillId が黄色のスタイルインデックスを特定
  const xfsMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!xfsMatch) return new Set();

  const yellowStyles = new Set<number>();
  const xfRe = /<xf\b([^>]*)(?:\/>|>[\s\S]*?<\/xf>)/g;
  let xm;
  let xi = 0;
  while ((xm = xfRe.exec(xfsMatch[1])) !== null) {
    const fillMatch = xm[1].match(/fillId="(\d+)"/);
    if (fillMatch && yellowFillIds.includes(parseInt(fillMatch[1]))) {
      yellowStyles.add(xi);
    }
    xi++;
  }
  return yellowStyles;
}

// sharedStrings.xml の文字列を取得
function getSharedStrings(ssXml: string): string[] {
  const strings: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(ssXml)) !== null) {
    // <t> テキストを結合（<rPh> は除外）
    const stripped = m[1]
      .replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")
      .replace(/<phoneticPr\b[^>]*\/>/g, "");
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    let text = "";
    while ((tm = tRe.exec(stripped)) !== null) text += tm[1];
    strings.push(decodeXmlEntities(text));
  }
  return strings;
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// 1 つの <si> 内の run 構造を分解して [{ text, isRed }] を返す。
// 例: 「代表取締役　」(黒) + 「岩井康洋」(赤) → [{text:"代表取締役　", isRed:false}, {text:"岩井康洋", isRed:true}]
// 単一テキストの <si><t>...</t></si> 形式は [{ text, isRed:false }] を返す。
type SiRun = { text: string; isRed: boolean };
function parseSiRuns(siInner: string): SiRun[] {
  // <rPh> ふりがなと <phoneticPr> を除去
  const stripped = siInner
    .replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")
    .replace(/<phoneticPr\b[^>]*\/>/g, "");

  const runs: SiRun[] = [];
  // 通常 run 形式: <r><rPr>...</rPr><t>text</t></r>
  const rRe = /<r\b[^>]*>([\s\S]*?)<\/r>/g;
  let rm;
  let foundAnyRun = false;
  while ((rm = rRe.exec(stripped)) !== null) {
    foundAnyRun = true;
    const inner = rm[1];
    const rPrMatch = inner.match(/<rPr>([\s\S]*?)<\/rPr>/);
    const isRed = rPrMatch ? RED_FONT_COLOR.test(rPrMatch[1]) : false;
    const tMatch = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
    if (tMatch) {
      runs.push({ text: decodeXmlEntities(tMatch[1]), isRed });
    }
  }
  if (foundAnyRun) return runs;

  // <r> なし → 単純な <si><t>...</t></si>。1 つの非赤 run として返す。
  const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let tm;
  let text = "";
  while ((tm = tRe.exec(stripped)) !== null) text += tm[1];
  if (text) runs.push({ text: decodeXmlEntities(text), isRed: false });
  return runs;
}

// sharedStrings の各 <si> ごとに、赤い run があるかを返す。
// 戻り値: Map<siIndex, SiRun[]>。赤い run を1つでも含む si のみ含まれる。
function findRedSharedStrings(ssXml: string): Map<number, SiRun[]> {
  const result = new Map<number, SiRun[]>();
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  let i = 0;
  while ((m = siRe.exec(ssXml)) !== null) {
    const runs = parseSiRuns(m[1]);
    if (runs.some(r => r.isRed)) {
      result.set(i, runs);
    }
    i++;
  }
  return result;
}

// xlsx Buffer → 黄色セル + 赤フォントセル + 赤い文字 run の一覧を返す。
// 3 種類のマーカー:
//   A) セル背景色「黄色」 → セル全体が可変
//   B) セル全体「赤い文字」(<fonts> 経由) → セル全体が可変
//   C) セル内の「赤い <r>」(rich text run) → 赤部分だけが可変
// produce 側で「マーカーあるか？」のチェックに使うため、どれか 1 つでもあれば 1 件以上返す。
export function extractXlsxMarkedCells(buffer: Buffer): XlsxMarkedCell[] {
  const zip = new PizZip(buffer);
  const stylesXml = zip.file("xl/styles.xml")?.asText();
  if (!stylesXml) return [];

  const yellowStyles = findYellowStyleIndexes(stylesXml);
  const redFontStyles = findRedFontStyleIndexes(stylesXml);
  const ssXmlEarly = zip.file("xl/sharedStrings.xml")?.asText();
  const redSiMap = ssXmlEarly ? findRedSharedStrings(ssXmlEarly) : new Map();
  if (yellowStyles.size === 0 && redFontStyles.size === 0 && redSiMap.size === 0) return [];
  // 日付フォーマットのセルを特定。数値を「46062」のような生のシリアルで AI に
  // 渡すと誤解（管理番号等と解釈）される。ISO 日付に変換してから渡す。
  const dateStyles = findDateStyleIndexes(stylesXml);

  // sharedStrings
  const ssXml = zip.file("xl/sharedStrings.xml")?.asText();
  const sharedStrings = ssXml ? getSharedStrings(ssXml) : [];

  const cells: XlsxMarkedCell[] = [];

  // 各シートを走査
  for (const fileName of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fileName)) continue;
    const sheetXml = zip.file(fileName)?.asText();
    if (!sheetXml) continue;

    // シート名を取得（workbook.xmlから）
    const sheetNum = fileName.match(/sheet(\d+)/)?.[1] || "1";
    let sheetName = `Sheet${sheetNum}`;
    const wbXml = zip.file("xl/workbook.xml")?.asText();
    if (wbXml) {
      const sheetRe = /<sheet\s+name="([^"]*)"[^>]*r:id="rId(\d+)"/g;
      let sm;
      while ((sm = sheetRe.exec(wbXml)) !== null) {
        if (sm[2] === sheetNum) { sheetName = sm[1]; break; }
      }
    }

    // マージセルの「top-left 以外」を集める。マージ内の装飾セル (例: A4:F8 で B4-F8) は
    // 塗りつぶし継承で「空の黄色セル」になりがちで、誤検出すると大量の不要 slot が出る。
    // top-left は通常通り扱い、それ以外は skip する。
    const mergeSuppressed = findMergeSuppressedRefs(sheetXml);

    // セルを「行順 × 列順」で1パス走査。
    // 各セルで以下を順に処理（getXlsxMarkedTextWithSlots と同じ順序）:
    //   ① 黄色塗り or 赤フォント → セル全体を slot として cells に追加 (値が空でも OK)
    //   ② 赤い rich text run を含むセル → 各赤 run を順に cells に追加 (値必須)
    // この順序を 2 関数で揃えないと slot id がズレる。
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(sheetXml)) !== null) {
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        const attrs = cm[1];
        const inner = cm[2] || "";
        const sMatch = attrs.match(/\bs="(\d+)"/);
        const rMatch = attrs.match(/\br="([A-Z]+\d+)"/);
        if (!rMatch) continue;
        const ref = rMatch[1];

        // 数式セルはスキップ (元々の挙動)
        if (/<f\b/.test(inner)) continue;

        const styleIdx = sMatch ? parseInt(sMatch[1]) : -1;
        const tMatch = attrs.match(/\bt="([^"]*)"/);
        const vMatch = inner.match(/<v>([^<]*)<\/v>/);

        const isYellow = styleIdx >= 0 && yellowStyles.has(styleIdx);
        const isRedFont = styleIdx >= 0 && redFontStyles.has(styleIdx);

        // 値抽出 (vMatch が無ければ空文字)
        let value = "";
        let siIndex = -1;
        if (vMatch) {
          if (tMatch?.[1] === "s") {
            siIndex = parseInt(vMatch[1]);
            value = sharedStrings[siIndex] || "";
          } else {
            const raw = vMatch[1];
            if (styleIdx >= 0 && dateStyles.has(styleIdx) && /^-?\d+(\.\d+)?$/.test(raw)) {
              const serial = parseFloat(raw);
              value = (serial > 0 && serial < 2958466) ? excelSerialToDateString(serial) : raw;
            } else {
              value = raw;
            }
          }
        }

        if (isYellow || isRedFont) {
          // マージ内の非 top-left セルは装飾扱いで skip
          if (mergeSuppressed.has(ref)) continue;
          // ① セル全体マーカー (空でも slot として登録 → 株主リスト 2-10 位等の空欄行が拾える)
          cells.push({ ref, value, sheetName });
        } else if (value.trim() && siIndex >= 0 && redSiMap.has(siIndex)) {
          // ② 赤 run マーカー (値必須、赤い部分だけを順に push)
          const runs = redSiMap.get(siIndex)!;
          for (const run of runs) {
            if (run.isRed && run.text.trim()) {
              cells.push({ ref, value: run.text, sheetName });
            }
          }
        }
      }
    }
  }

  return cells;
}

// シートの mergeCells から「top-left 以外」のセル参照を全部集める。
// 例: mergeCell ref="A4:F8" → B4-F8 の 29 セルが「装飾扱いで slot 化しない」対象
function findMergeSuppressedRefs(sheetXml: string): Set<string> {
  const suppressed = new Set<string>();
  const mergeRe = /<mergeCell\s+ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g;
  let m;
  while ((m = mergeRe.exec(sheetXml)) !== null) {
    const [, c1, r1Str, c2, r2Str] = m;
    const r1 = parseInt(r1Str), r2 = parseInt(r2Str);
    const col1 = colLetterToIndex(c1), col2 = colLetterToIndex(c2);
    for (let r = r1; r <= r2; r++) {
      for (let c = col1; c <= col2; c++) {
        if (r === r1 && c === col1) continue; // top-left は除外せず slot に出す
        suppressed.add(`${indexToColLetter(c)}${r}`);
      }
    }
  }
  return suppressed;
}

function colLetterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function indexToColLetter(idx: number): string {
  let s = "";
  while (idx > 0) {
    const r = (idx - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}

/**
 * マーカーセルを slotId 別に置換する版。
 *
 * 旧 `replaceXlsxMarkedCells` は `Record<origValue, newValue>` で受け取っていたため、
 * 異なる slot が同じ origValue を持つケース（例: 株主リストで「第1位の株式数」と「合計株式数」
 * が両方 99500 の単独株主テンプレ）で**最後に書き込んだ slot の値で全て上書きされる**バグがあった。
 *
 * 本関数は `Map<slotId, newValue>` を受け取り、`extractXlsxMarkedCells`/
 * `getXlsxMarkedTextWithSlots` と**同じ走査順**でセルを回り、slot 位置で置換するので
 * 値が重複しても干渉しない。
 *
 * 置換の挙動:
 *   - 新値が純数値（カンマ・全角混じり含む）の場合: 数値セル `<c><v>N</v></c>` として書き出す
 *   - それ以外の場合: 共有文字列に新 si を追加し、セルを `t="s"` でそこへ向ける
 *     （既存 si を直接書き換えると、他セルから参照されてる場合に巻き添えで変わるため避ける）
 */
export function replaceXlsxMarkedCellsBySlot(
  buffer: Buffer,
  slotReplacements: Map<number, string>,
): Buffer {
  const zip = new PizZip(buffer);
  const stylesXml = zip.file("xl/styles.xml")?.asText();
  if (!stylesXml) return buffer;

  const yellowStyles = findYellowStyleIndexes(stylesXml);
  const redFontStyles = findRedFontStyleIndexes(stylesXml);
  const ssXmlForCheck = zip.file("xl/sharedStrings.xml")?.asText();
  const hasRedRuns = ssXmlForCheck ? findRedSharedStrings(ssXmlForCheck).size > 0 : false;
  if (yellowStyles.size === 0 && redFontStyles.size === 0 && !hasRedRuns) return buffer;

  const ssXml = zip.file("xl/sharedStrings.xml")?.asText();
  const sharedStrings = ssXml ? getSharedStrings(ssXml) : [];
  const redSiMap = ssXml ? findRedSharedStrings(ssXml) : new Map<number, SiRun[]>();
  const dateStyles = findDateStyleIndexes(stylesXml);

  const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const isNumericValue = (s: string): string | null => {
    // 全角数字 → 半角、カンマ除去で純数値判定
    const halfWidth = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    const cleaned = halfWidth.replace(/,/g, "").trim();
    if (cleaned === "") return null;
    return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
  };

  // sharedStrings に追加する新 si エントリ（既存を破壊せずに追加）
  const newSiAppends: string[] = [];
  let slotCounter = 0;

  // ワークシートを順に走査（extract と同じ順）
  const sheetFiles = Object.keys(zip.files)
    .filter(fn => /^xl\/worksheets\/sheet\d+\.xml$/.test(fn))
    .sort();

  for (const fileName of sheetFiles) {
    let sheetXml = zip.file(fileName)?.asText();
    if (!sheetXml) continue;
    let sheetChanged = false;

    // マージ内の非 top-left は装飾扱いで skip (extract と同じ)
    const mergeSuppressed = findMergeSuppressedRefs(sheetXml);

    // 行ごとに、その中のセルを順に処理
    sheetXml = sheetXml.replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (rowWhole: string, rowInner: string) => {
      const newRowInner = rowInner.replace(
        /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
        (cellWhole: string, attrs: string, inner: string | undefined) => {
          const sMatch = attrs.match(/\bs="(\d+)"/);
          const tMatch = attrs.match(/\bt="([^"]*)"/);
          const rMatch = attrs.match(/\br="([A-Z]+\d+)"/);
          const ref = rMatch?.[1] || "";
          const styleIdx = sMatch ? parseInt(sMatch[1]) : -1;
          const vMatch = inner ? inner.match(/<v>([^<]*)<\/v>/) : null;

          if (inner && /<f\b/.test(inner)) return cellWhole; // 数式セルは extract と同じくスキップ

          const isYellow = styleIdx >= 0 && yellowStyles.has(styleIdx);
          const isRedFont = styleIdx >= 0 && redFontStyles.has(styleIdx);
          const siIndex = (vMatch && tMatch?.[1] === "s") ? parseInt(vMatch[1]) : -1;
          const isRedSi = siIndex >= 0 && redSiMap.has(siIndex);

          if (!isYellow && !isRedFont && !isRedSi) return cellWhole;

          // マージ内の非 top-left は装飾扱いで slot に出さない
          if ((isYellow || isRedFont) && mergeSuppressed.has(ref)) return cellWhole;

          if (isYellow || isRedFont) {
            // セル全体マーカー = 1 slot (空セルでも OK = 株主リストの 2-10 位 空欄)
            const currentSlot = slotCounter++;
            const newValue = slotReplacements.get(currentSlot);
            if (newValue === undefined || newValue === "") return cellWhole;
            sheetChanged = true;
            const numeric = isNumericValue(newValue);
            const cleanedAttrs = attrs.replace(/\s*\bt="[^"]*"/, "");
            if (numeric !== null) {
              // 数値セルとして書き出す（t 属性なし or t="n"）
              return `<c${cleanedAttrs}><v>${numeric}</v></c>`;
            }
            // 文字列セル: 新 si を追加して参照
            const newSiIdx = sharedStrings.length + newSiAppends.length;
            newSiAppends.push(`<si><t xml:space="preserve">${xmlEscape(newValue)}</t></si>`);
            return `<c${cleanedAttrs} t="s"><v>${newSiIdx}</v></c>`;
          }

          // 赤 run マーカー: 1 セルに複数 slot（赤い run の数だけ）
          const runs = redSiMap.get(siIndex)!;
          let newSiInner = "";
          let anyReplaced = false;
          for (const run of runs) {
            if (run.isRed && run.text.trim()) {
              const currentSlot = slotCounter++;
              const newValue = slotReplacements.get(currentSlot);
              if (newValue !== undefined) {
                anyReplaced = true;
                newSiInner += `<r><t xml:space="preserve">${xmlEscape(newValue)}</t></r>`;
              } else {
                newSiInner += `<r><t xml:space="preserve">${xmlEscape(run.text)}</t></r>`;
              }
            } else {
              newSiInner += `<r><t xml:space="preserve">${xmlEscape(run.text)}</t></r>`;
            }
          }
          if (!anyReplaced) return cellWhole;
          sheetChanged = true;
          const newSiIdx = sharedStrings.length + newSiAppends.length;
          newSiAppends.push(`<si>${newSiInner}</si>`);
          const cleanedAttrs = attrs.replace(/\s*\bt="[^"]*"/, "");
          return `<c${cleanedAttrs} t="s"><v>${newSiIdx}</v></c>`;
        }
      );
      return rowWhole.replace(rowInner, newRowInner);
    });

    if (sheetChanged) zip.file(fileName, sheetXml);
  }

  // sharedStrings.xml に追加 si を差し込み
  if (newSiAppends.length > 0) {
    let currentSsXml = zip.file("xl/sharedStrings.xml")?.asText()
      || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"></sst>`;
    const insertIdx = currentSsXml.lastIndexOf("</sst>");
    if (insertIdx !== -1) {
      currentSsXml = currentSsXml.substring(0, insertIdx) + newSiAppends.join("") + currentSsXml.substring(insertIdx);
    } else {
      currentSsXml += newSiAppends.join("");
    }
    const siCount = (currentSsXml.match(/<si\b/g) || []).length;
    currentSsXml = currentSsXml
      .replace(/\bcount="\d+"/, `count="${siCount}"`)
      .replace(/\buniqueCount="\d+"/, `uniqueCount="${siCount}"`);
    zip.file("xl/sharedStrings.xml", currentSsXml);

    // Content_Types に sharedStrings エントリが無ければ追加
    const ctXml = zip.file("[Content_Types].xml")?.asText();
    if (ctXml && !ctXml.includes('PartName="/xl/sharedStrings.xml"')) {
      const updated = ctXml.replace(
        /<\/Types>/,
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'
      );
      zip.file("[Content_Types].xml", updated);
    }
  }

  // 後片付け: ふりがな・赤色マーカー除去
  const finalSs = zip.file("xl/sharedStrings.xml")?.asText();
  if (finalSs) {
    const cleaned = finalSs
      .replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "")
      .replace(/<phoneticPr\b[^>]*\/>/g, "")
      .replace(/<color\s+[^/>]*\brgb="FFFF0000"[^/>]*\/>/gi, "");
    if (cleaned !== finalSs) zip.file("xl/sharedStrings.xml", cleaned);
  }

  // styles.xml: 黄色塗り解除、フォント赤除去
  const updatedStyles = zip.file("xl/styles.xml")?.asText();
  if (updatedStyles) {
    let cleaned = updatedStyles.replace(
      /<fill>([\s\S]*?)<\/fill>/g,
      (whole: string, inner: string) => {
        if (/patternType="none"/i.test(inner)) return whole;
        const isYellowFill = /<fgColor\s+[^>]*\brgb="(?:FF)?FFFF00"/i.test(inner);
        if (!isYellowFill) return whole;
        return `<fill><patternFill patternType="none"/></fill>`;
      }
    );
    cleaned = cleaned.replace(
      /<font>([\s\S]*?)<\/font>/g,
      (whole: string, inner: string) => {
        const stripped = inner.replace(/<color\s+[^/>]*\brgb="FFFF0000"[^/>]*\/>/gi, "");
        return stripped === inner ? whole : `<font>${stripped}</font>`;
      }
    );
    if (cleaned !== updatedStyles) zip.file("xl/styles.xml", cleaned);
  }

  // calcChain は範囲が変わってる可能性があるので削除（Excel が再生成）
  if (zip.file("xl/calcChain.xml")) {
    zip.remove("xl/calcChain.xml");
    const relsPath = "xl/_rels/workbook.xml.rels";
    const relsXml = zip.file(relsPath)?.asText();
    if (relsXml) {
      const cleaned = relsXml.replace(/<Relationship\b[^>]*\bTarget="calcChain\.xml"[^>]*\/>/g, "");
      if (cleaned !== relsXml) zip.file(relsPath, cleaned);
    }
    const ctPath = "[Content_Types].xml";
    const ctXml = zip.file(ctPath)?.asText();
    if (ctXml) {
      const cleaned = ctXml.replace(/<Override\b[^>]*\bPartName="\/xl\/calcChain\.xml"[^>]*\/>/g, "");
      if (cleaned !== ctXml) zip.file(ctPath, cleaned);
    }
  }

  // 数式セル (`<f>` を持つセル) の **キャッシュ `<v>` を削除** して、開くソフトに再計算を強制する。
  //
  // 背景:
  //   xlsx は数式セルに「数式そのもの (<f>)」と「前回計算した結果のキャッシュ (<v>)」を両方持つ。
  //   我々のコードはマーカーセル (株式数など) の値を XML 直書き換えで差し替えるが、
  //   依存先の合計セル・割合セルの数式は触ってない。結果、数式は最新だがキャッシュは古いまま。
  //   Excel は通常開いた瞬間にキャッシュを表示してから再計算する設計なので、
  //   一瞬古い値 (前案件の合計とか) が見えたり、設定によっては再計算をサボることがある。
  //   LibreOffice (recast のプレビュー変換) もキャッシュをそのまま表示することが多い。
  //
  // 対策:
  //   `<v>` を消す → キャッシュなし → 開くソフトは数式を計算するしかない → 必ず最新値が出る。
  //   ついでに `<calcPr fullCalcOnLoad="1"/>` も立てておくと Excel がより確実に再計算する。
  for (const fileName of sheetFiles) {
    let sheetXml = zip.file(fileName)?.asText();
    if (!sheetXml) continue;
    let cleared = false;
    sheetXml = sheetXml.replace(
      /<c\b([^>]*?)>([\s\S]*?)<\/c>/g,
      (whole: string, attrs: string, inner: string) => {
        if (!/<f\b/.test(inner)) return whole;
        // <v>...</v> を削除（<f> は残す）
        const stripped = inner.replace(/<v\b[^>]*>[\s\S]*?<\/v>/g, "").replace(/<v\b[^>]*\/>/g, "");
        if (stripped === inner) return whole;
        cleared = true;
        return `<c${attrs}>${stripped}</c>`;
      }
    );
    if (cleared) zip.file(fileName, sheetXml);
  }

  // workbook.xml の <calcPr> に fullCalcOnLoad="1" を付与（Excel に強制再計算を指示）
  const wbXml = zip.file("xl/workbook.xml")?.asText();
  if (wbXml) {
    let updated = wbXml;
    if (/<calcPr\b/.test(wbXml)) {
      // 既存の <calcPr ...> に属性を追加
      updated = updated.replace(/<calcPr\b([^/>]*)\/?>/, (m: string, a: string) => {
        if (/\bfullCalcOnLoad=/.test(a)) {
          return m.replace(/\bfullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"');
        }
        return `<calcPr${a} fullCalcOnLoad="1"/>`;
      });
    } else {
      // <calcPr> が無ければ </workbook> 直前に挿入
      updated = updated.replace(/<\/workbook>/, '<calcPr fullCalcOnLoad="1"/></workbook>');
    }
    if (updated !== wbXml) zip.file("xl/workbook.xml", updated);
  }

  return zip.generate({ type: "nodebuffer" });
}

// 黄色セルの値を差し替えた xlsx Buffer を返す
// @deprecated 値キーだと同値スロットが衝突するため `replaceXlsxMarkedCellsBySlot` を使うこと
export function replaceXlsxMarkedCells(
  buffer: Buffer,
  replacements: Record<string, string>,
): Buffer {
  const zip = new PizZip(buffer);
  const stylesXml = zip.file("xl/styles.xml")?.asText();
  if (!stylesXml) return buffer;

  const yellowStyles = findYellowStyleIndexes(stylesXml);
  const redFontStyles = findRedFontStyleIndexes(stylesXml);
  // どれか 1 つでもマーカーがあれば処理続行
  const ssXmlForCheck = zip.file("xl/sharedStrings.xml")?.asText();
  const hasRedRuns = ssXmlForCheck ? findRedSharedStrings(ssXmlForCheck).size > 0 : false;
  if (yellowStyles.size === 0 && redFontStyles.size === 0 && !hasRedRuns) return buffer;

  const ssXml = zip.file("xl/sharedStrings.xml")?.asText();
  const sharedStrings = ssXml ? getSharedStrings(ssXml) : [];

  const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // sharedStrings.xml の置換
  // 優先順位:
  //   1) <si> の全文 (origValue) が replacements にあれば → 全体を <si><t>NEW</t></si> で置換
  //      （黄色セル方式。書式情報を全部破棄して通常色に戻す）
  //   2) それ以外で <r> 構造があり、赤 run のテキストが replacements にあれば → 赤 run だけ部分置換
  //      （他の run は維持）
  if (ssXml) {
    let newSsXml = ssXml;
    let siIndex = 0;
    newSsXml = newSsXml.replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, (whole: string, siInner: string) => {
      const origValue = sharedStrings[siIndex++];
      // 1) 全文置換（黄色セル方式）。複数 run でも、全文一致なら全部捨てて新値に
      // xml:space="preserve" を付けて改行・先頭/末尾空白を維持する
      // （セル内 alt+Enter 改行や、書式整え用のインデントが崩れないように）
      const newFullValue = replacements[origValue];
      if (newFullValue !== undefined) {
        return `<si><t xml:space="preserve">${xmlEscape(newFullValue)}</t></si>`;
      }
      // 2) 赤 run の部分置換（混在セル）
      if (/<r\b/.test(siInner)) {
        let modified = siInner;
        let anyChanged = false;
        modified = modified.replace(/<r\b[^>]*>([\s\S]*?)<\/r>/g, (rWhole: string, rInner: string) => {
          const rPrMatch = rInner.match(/<rPr>([\s\S]*?)<\/rPr>/);
          const isRed = rPrMatch ? RED_FONT_COLOR.test(rPrMatch[1]) : false;
          if (!isRed) return rWhole;
          const tMatch = rInner.match(/(<t\b[^>]*>)([\s\S]*?)(<\/t>)/);
          if (!tMatch) return rWhole;
          const origRunText = decodeXmlEntities(tMatch[2]);
          const newRunText = replacements[origRunText];
          if (newRunText === undefined) return rWhole;
          anyChanged = true;
          // <rPr> 内の赤い文字色 <color rgb="FFFF0000"/> を除去（生成書類は黒文字に戻す）
          // <t> の中身も新しい値に差し替え
          const newInner = rInner
            .replace(/<color\s+rgb="FFFF0000"\s*\/>/gi, "")
            .replace(/(<t\b[^>]*>)[\s\S]*?(<\/t>)/, `$1${xmlEscape(newRunText)}$2`);
          return rWhole.replace(rInner, newInner);
        });
        if (anyChanged) {
          // <rPh> ふりがなはオフセットがズレるので除去（既存処理と同じ）
          modified = modified
            .replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "")
            .replace(/<phoneticPr\b[^>]*\/>/g, "");
          return `<si>${modified}</si>`;
        }
      }
      return whole;
    });
    zip.file("xl/sharedStrings.xml", newSsXml);
  }

  // 数値セル（t="s"でない、黄色 or 赤フォントセル）の直接置換
  for (const fileName of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fileName)) continue;
    let sheetXml = zip.file(fileName)?.asText();
    if (!sheetXml) continue;
    let changed = false;

    sheetXml = sheetXml.replace(
      /<c\b([^>\/]*)>([\s\S]*?)<\/c>/g,
      (whole: string, attrs: string, inner: string) => {
        const sMatch = attrs.match(/\bs="(\d+)"/);
        if (!sMatch) return whole;
        const styleIdx = parseInt(sMatch[1]);
        if (!yellowStyles.has(styleIdx) && !redFontStyles.has(styleIdx)) return whole;
        const tMatch = attrs.match(/\bt="([^"]*)"/);
        if (tMatch?.[1] === "s") return whole; // 共有文字列は上で処理済み
        const vMatch = inner.match(/<v>([^<]*)<\/v>/);
        if (!vMatch) return whole;

        const origValue = vMatch[1];
        const newValue = replacements[origValue];
        if (newValue === undefined) return whole;
        changed = true;
        return `<c${attrs}><v>${xmlEscape(newValue)}</v></c>`;
      }
    );

    if (changed) zip.file(fileName, sheetXml);
  }

  // rPh/phoneticPr を除去 + 残った赤色マーカーを全て除去
  // → 生成書類では赤マーカーが消えて通常色（黒）になる
  // 属性順や追加属性 (theme, indexed 等) があっても対応
  const finalSs = zip.file("xl/sharedStrings.xml")?.asText();
  if (finalSs) {
    const cleaned = finalSs
      .replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "")
      .replace(/<phoneticPr\b[^>]*\/>/g, "")
      .replace(/<color\s+[^/>]*\brgb="FFFF0000"[^/>]*\/>/gi, "");
    if (cleaned !== finalSs) zip.file("xl/sharedStrings.xml", cleaned);
  }

  // styles.xml クリーンアップ:
  //   1) 黄色フィルを透明 (none) に変更
  //   2) <fonts> 内の <font> から赤い文字色 <color rgb="FFFF0000"/> を除去
  //      → セルが「セル全体が赤」スタイルでも、フォント自体が黒（デフォルト）になる
  //   3) <color rgb="FFFF0000"/> 単独形（属性なし）は念のためグローバル除去
  const updatedStyles = zip.file("xl/styles.xml")?.asText();
  if (updatedStyles) {
    let cleaned = updatedStyles.replace(
      /<fill>([\s\S]*?)<\/fill>/g,
      (whole: string, inner: string) => {
        if (/patternType="none"/i.test(inner)) return whole;
        const isYellow = /<fgColor\s+[^>]*\brgb="(?:FF)?FFFF00"/i.test(inner);
        if (!isYellow) return whole;
        return `<fill><patternFill patternType="none"/></fill>`;
      }
    );
    // <font> 内の赤色を除去（"セル全体が赤"パターンの解除）
    cleaned = cleaned.replace(
      /<font>([\s\S]*?)<\/font>/g,
      (whole: string, inner: string) => {
        const stripped = inner.replace(/<color\s+[^/>]*\brgb="FFFF0000"[^/>]*\/>/gi, "");
        return stripped === inner ? whole : `<font>${stripped}</font>`;
      }
    );
    if (cleaned !== updatedStyles) zip.file("xl/styles.xml", cleaned);
  }

  // calcChain.xml 削除
  if (zip.file("xl/calcChain.xml")) {
    zip.remove("xl/calcChain.xml");
    const relsPath = "xl/_rels/workbook.xml.rels";
    const relsXml = zip.file(relsPath)?.asText();
    if (relsXml) {
      const cleaned = relsXml.replace(/<Relationship\b[^>]*\bTarget="calcChain\.xml"[^>]*\/>/g, "");
      if (cleaned !== relsXml) zip.file(relsPath, cleaned);
    }
    const ctPath = "[Content_Types].xml";
    const ctXml = zip.file(ctPath)?.asText();
    if (ctXml) {
      const cleaned = ctXml.replace(/<Override\b[^>]*\bPartName="\/xl\/calcChain\.xml"[^>]*\/>/g, "");
      if (cleaned !== ctXml) zip.file(ctPath, cleaned);
    }
  }

  return zip.generate({ type: "nodebuffer" });
}

// マーカー付きデータ行（連続したマーカー値入り行）が不足している場合、最終行を複製して必要件数まで増やす。
// 各新規行のセル値は "__ROW_N_COL__" 形式の一意プレースホルダーにしてAIが行ごとに識別できるようにする。
// 後続行の row 番号とセル参照（r="A12" 等）もシフトする。
// mergeCells, formulas 等の参照更新は簡易（SUM(A9:A18) 等は元の範囲のままで、追加行が含まれる想定）。
// マーカー対象: 黄色塗り or 赤フォント (どちらも「セル全体可変」を意味する)
export function expandYellowRowBlock(buffer: Buffer, desiredRows: number): Buffer {
  if (desiredRows <= 0) return buffer;
  const zip = new PizZip(buffer);
  const stylesXml = zip.file("xl/styles.xml")?.asText();
  if (!stylesXml) return buffer;
  const yellowStyles = findYellowStyleIndexes(stylesXml);
  const redFontStyles = findRedFontStyleIndexes(stylesXml);
  if (yellowStyles.size === 0 && redFontStyles.size === 0) return buffer;
  // マーカースタイルかどうかの統一判定
  const isMarkerStyle = (idx: number) => yellowStyles.has(idx) || redFontStyles.has(idx);

  const ssXml = zip.file("xl/sharedStrings.xml")?.asText();
  let sharedStrings = ssXml ? getSharedStrings(ssXml) : [];

  let changed = false;
  let ssAppendCount = 0;
  const ssAppends: string[] = [];

  const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  for (const fileName of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fileName)) continue;
    let sheetXml = zip.file(fileName)?.asText();
    if (!sheetXml) continue;

    // 各行の黄色値入りセル数を集計
    const rowYellowCellCount = new Map<number, number>();
    const rowInfoRe = /<row\b([^>]*\br="(\d+)"[^>]*)>([\s\S]*?)<\/row>/g;
    let rim;
    while ((rim = rowInfoRe.exec(sheetXml)) !== null) {
      const rn = parseInt(rim[2]);
      const body = rim[3];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      let count = 0;
      while ((cm = cellRe.exec(body)) !== null) {
        const attrs = cm[1];
        const inner = cm[2] || "";
        const s = attrs.match(/\bs="(\d+)"/);
        if (!s || !isMarkerStyle(parseInt(s[1]))) continue;
        const vm = inner.match(/<v>([^<]*)<\/v>/);
        if (!vm) continue;
        if (/<f\b/.test(inner)) continue; // 数式セルは除外
        const t = attrs.match(/\bt="([^"]*)"/);
        const val = t?.[1] === "s" ? (sharedStrings[parseInt(vm[1])] || "") : vm[1];
        if (val.trim()) count++;
      }
      if (count > 0) rowYellowCellCount.set(rn, count);
    }

    const sortedRows = [...rowYellowCellCount.keys()].sort((a, b) => a - b);
    if (sortedRows.length === 0) continue;

    // 連続した黄色行ブロックを全て抽出し、「データリスト」らしいブロックを選ぶ
    // ヒント: データリストは行あたり複数セルが黄色（署名欄は1セル/行のみなので除外）
    const blocks: { start: number; end: number; maxCellsPerRow: number }[] = [];
    let curStart = sortedRows[0];
    let curEnd = sortedRows[0];
    for (let i = 1; i <= sortedRows.length; i++) {
      if (i < sortedRows.length && sortedRows[i] === curEnd + 1) {
        curEnd = sortedRows[i];
      } else {
        let maxCells = 0;
        for (let r = curStart; r <= curEnd; r++) maxCells = Math.max(maxCells, rowYellowCellCount.get(r) || 0);
        blocks.push({ start: curStart, end: curEnd, maxCellsPerRow: maxCells });
        if (i < sortedRows.length) { curStart = sortedRows[i]; curEnd = sortedRows[i]; }
      }
    }
    // データリスト候補: 行あたり 3 セル以上マーカー (=データ行) なブロックのみ。
    // 旧: 「ブロック行数 >= 2」も必須にしていたが、それだとテンプレが 1 行しかマーカー
    //     してない場合 (株主1人分だけマークされた株主リスト等) に拡張が効かず、
    //     2人目以降が抜け落ちるバグがあった (取締役就任/4.株主リスト.xlsx で発生)
    // 新: 1 行ブロックでも対象にする。代わりに「行あたりセル数」を最優先で並べ替え、
    //     データ行（株主行=5セル等）を集計行（合計=3セル等）より優先するようにする。
    const listCandidates = blocks.filter(b => b.maxCellsPerRow >= 3);
    if (listCandidates.length === 0) continue;
    // 優先: ① 行あたりセル数が多い → ② 行数が多い → ③ 上に出てくるもの
    listCandidates.sort((a, b) => {
      if (b.maxCellsPerRow !== a.maxCellsPerRow) return b.maxCellsPerRow - a.maxCellsPerRow;
      const sizeDiff = (b.end - b.start) - (a.end - a.start);
      if (sizeDiff !== 0) return sizeDiff;
      return a.start - b.start;
    });
    const block = listCandidates[0];
    const blockStart = block.start;
    const blockEnd = block.end;
    const blockSize = blockEnd - blockStart + 1;
    if (desiredRows <= blockSize) continue;
    const rowsToAdd = desiredRows - blockSize;
    void blockStart;

    // blockEnd 行の XML を取得（自己閉じ <row .../> と内容あり <row ...>...</row> の両方に対応）
    const lastRowRe = new RegExp(`<row\\b[^>]*\\br="${blockEnd}"[^>]*(?:\\/>|>[\\s\\S]*?<\\/row>)`);
    const lastRowMatch = sheetXml.match(lastRowRe);
    if (!lastRowMatch) continue;
    const lastRowXml = lastRowMatch[0];
    const lastRowIdx = sheetXml.indexOf(lastRowXml);

    // 複製行を生成（各セルを一意プレースホルダーに置き換え）
    const newRowXmls: string[] = [];
    for (let k = 1; k <= rowsToAdd; k++) {
      const newRowNum = blockEnd + k;
      let dup = lastRowXml;
      // row r="N" を更新
      dup = dup.replace(/(<row\b[^>]*\br=")\d+(")/, `$1${newRowNum}$2`);
      // セル r="A11" 等を A{newRowNum} にシフト
      dup = dup.replace(/(\br=")([A-Z]+)\d+(")/g, (_m: string, p1: string, col: string, p3: string) => `${p1}${col}${newRowNum}${p3}`);

      // 各セルの値を一意プレースホルダーに置換（数式は除去してプレースホルダー化）
      // 複製先の shared formula（si="0" 等）は参照元がずれて壊れるので、ここで完全に切り離す
      dup = dup.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (whole: string, attrs: string, inner: string | undefined) => {
        const s = attrs.match(/\bs="(\d+)"/);
        if (!s || !yellowStyles.has(parseInt(s[1]))) return whole; // 非黄色は素通し
        const refMatch = attrs.match(/\br="([A-Z]+\d+)"/);
        if (!refMatch) return whole;

        const ref = refMatch[1];
        const col = ref.replace(/\d+/, "");
        const placeholder = `__ROW_${newRowNum}_${col}__`;
        const newIdx = sharedStrings.length + ssAppendCount;
        ssAppends.push(`<si><t xml:space="preserve">${xmlEscape(placeholder)}</t></si>`);
        ssAppendCount++;
        const cleanAttrs = attrs.replace(/\s*\bt="[^"]*"/, "");
        void inner; // 内容は破棄（数式参照が壊れるため）
        return `<c${cleanAttrs} t="s"><v>${newIdx}</v></c>`;
      });

      newRowXmls.push(dup);
    }

    // blockEnd 以降の既存行を rowsToAdd シフト
    // NOTE: 開始タグ (<row, <c) を含めて捕獲して返す。含めないと置換で消える。
    const after = sheetXml.substring(lastRowIdx + lastRowXml.length);
    const shiftedAfter = after.replace(/(<row\b[^>]*\br=")(\d+)(")/g, (_m: string, p1: string, num: string, p3: string) => {
      return `${p1}${parseInt(num) + rowsToAdd}${p3}`;
    }).replace(/(<c\b[^>]*\br=")([A-Z]+)(\d+)(")/g, (_m: string, p1: string, col: string, num: string, p3: string) => {
      return `${p1}${col}${parseInt(num) + rowsToAdd}${p3}`;
    });

    // 再構成
    const before = sheetXml.substring(0, lastRowIdx + lastRowXml.length);
    sheetXml = before + newRowXmls.join("") + shiftedAfter;

    // dimension を更新（<dimension ref="A1:E26"/> 等）
    sheetXml = sheetXml.replace(/<dimension\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/, (m: string, c1: string, n1: string, c2: string, n2: string) => {
      void c1; void n1; void c2;
      return m.replace(/\bref="[A-Z]+\d+:[A-Z]+\d+"/, (ref: string) => {
        return ref.replace(/:(\w+?)(\d+)"$/, `:$1${parseInt(n2) + rowsToAdd}"`);
      });
    });

    // mergeCells のシフト
    sheetXml = sheetXml.replace(/<mergeCell\s+ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g, (_m: string, c1: string, n1: string, c2: string, n2: string) => {
      const r1 = parseInt(n1);
      const r2 = parseInt(n2);
      const nr1 = r1 > blockEnd ? r1 + rowsToAdd : r1;
      const nr2 = r2 > blockEnd ? r2 + rowsToAdd : r2;
      return `<mergeCell ref="${c1}${nr1}:${c2}${nr2}"`;
    });

    zip.file(fileName, sheetXml);
    changed = true;
  }

  if (!changed) return buffer;

  // sharedStrings.xml に追加分を差し込む
  if (ssAppendCount > 0) {
    let currentSsXml = zip.file("xl/sharedStrings.xml")?.asText() || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"></sst>`;
    // </sst> の直前に挿入
    const insertIdx = currentSsXml.lastIndexOf("</sst>");
    if (insertIdx !== -1) {
      currentSsXml = currentSsXml.substring(0, insertIdx) + ssAppends.join("") + currentSsXml.substring(insertIdx);
    } else {
      currentSsXml += ssAppends.join("");
    }
    // count/uniqueCount は再集計
    const siCount = (currentSsXml.match(/<si\b/g) || []).length;
    currentSsXml = currentSsXml
      .replace(/\bcount="\d+"/, `count="${siCount}"`)
      .replace(/\buniqueCount="\d+"/, `uniqueCount="${siCount}"`);

    // sharedStrings.xml が元々存在しなかった場合は追加（稀）
    zip.file("xl/sharedStrings.xml", currentSsXml);

    // Content_Types に sharedStrings エントリがあるか確認
    const ctXml = zip.file("[Content_Types].xml")?.asText();
    if (ctXml && !ctXml.includes('PartName="/xl/sharedStrings.xml"')) {
      const updated = ctXml.replace(
        /<\/Types>/,
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'
      );
      zip.file("[Content_Types].xml", updated);
    }
  }

  // calcChain.xml は範囲ずれを起こすので削除（Excel が再生成）
  if (zip.file("xl/calcChain.xml")) zip.remove("xl/calcChain.xml");

  return zip.generate({ type: "nodebuffer" });
}

// Excelの全体テキストを ［要入力_N］ 付きで返す。
// 3 種類のマーカーを処理する:
//   A) 黄色セル全体        → セル全体が ［要入力_N］
//   B) 赤フォントセル全体   → セル全体が ［要入力_N］（黄色と同じ扱い）
//   C) 赤いテキスト run    → セル内の赤い部分だけ ［要入力_N］、他は固定で残す
// AIは前案件の値に引きずられず文脈だけで判断できる。
// slots: N → セルの元値（originalValue）。produce 側で {origValue → newValue} の置換マップを作る用。
// slot ごとのセル位置。ルールベース fill コマンド生成で officecli path=/SheetName/CellAddr を作るのに使う。
export interface XlsxSlotPosition {
  ref: string;        // "B14"
  sheetName: string;  // "株主リスト（承認決議）（包括）"
}

export function getXlsxMarkedTextWithSlots(buffer: Buffer): {
  text: string;
  slots: Map<number, string>;
  slotPositions: Map<number, XlsxSlotPosition>;
  // ref (例: "A26") → そのセルの完全テンプレ。固定文 + ［要入力_N］ プレースホルダ入り。
  // 1 セルに複数 slot (赤 run 等) がある場合、value= の上書き事故を防ぐため
  // このテンプレに全 slot の値を埋め込んで 1 回で書き込む。
  cellTexts: Map<string, string>;
  // % 書式のセル ref 集合。値に % を付けて入れないと 78.4 → 7840% になる。
  percentRefs: Set<string>;
} {
  const zip = new PizZip(buffer);
  const stylesXml = zip.file("xl/styles.xml")?.asText() || "";
  const yellowStyles = findYellowStyleIndexes(stylesXml);
  const redFontStyles = findRedFontStyleIndexes(stylesXml);
  const dateStyles = findDateStyleIndexes(stylesXml);
  const percentStyles = findPercentStyleIndexes(stylesXml);
  const ssXml = zip.file("xl/sharedStrings.xml")?.asText();
  const sharedStrings = ssXml ? getSharedStrings(ssXml) : [];
  const redSiMap = ssXml ? findRedSharedStrings(ssXml) : new Map<number, SiRun[]>();
  const wbXml = zip.file("xl/workbook.xml")?.asText() || "";

  const slots = new Map<number, string>();
  const slotPositions = new Map<number, XlsxSlotPosition>();
  const cellTexts = new Map<string, string>();
  const percentRefs = new Set<string>();
  let slotId = 0;
  const lines: string[] = [];

  for (const fileName of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fileName)) continue;
    const sheetXml = zip.file(fileName)?.asText();
    if (!sheetXml) continue;

    // シート名を解決 (extractXlsxMarkedCells と同じロジック)
    const sheetNum = fileName.match(/sheet(\d+)/)?.[1] || "1";
    let sheetName = `Sheet${sheetNum}`;
    if (wbXml) {
      const sheetRe = /<sheet\s+name="([^"]*)"[^>]*r:id="rId(\d+)"/g;
      let sm;
      while ((sm = sheetRe.exec(wbXml)) !== null) {
        if (sm[2] === sheetNum) { sheetName = sm[1]; break; }
      }
    }

    // マージ内の非 top-left は装飾扱いで skip (extractXlsxMarkedCells と同じ)
    const mergeSuppressed = findMergeSuppressedRefs(sheetXml);

    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(sheetXml)) !== null) {
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      const rowTexts: string[] = [];
      while ((cm = cellRe.exec(rm[1])) !== null) {
        const attrs = cm[1];
        const inner = cm[2] || "";
        const rMatch = attrs.match(/\br="([A-Z]+\d+)"/);
        const ref = rMatch?.[1] || "";

        // 数式セルは値だけ出して slot 化しない
        if (/<f\b/.test(inner)) {
          const vM = inner.match(/<v>([^<]*)<\/v>/);
          if (vM) rowTexts.push(vM[1]);
          continue;
        }

        const tMatch = attrs.match(/\bt="([^"]*)"/);
        const sMatch = attrs.match(/\bs="(\d+)"/);
        const vMatch = inner.match(/<v>([^<]*)<\/v>/);
        const styleIdx = sMatch ? parseInt(sMatch[1]) : -1;
        if (ref && styleIdx >= 0 && percentStyles.has(styleIdx)) percentRefs.add(ref);

        // 値を抽出 (なければ空)
        let val = "";
        let siIndex = -1;
        if (vMatch) {
          if (tMatch?.[1] === "s") {
            siIndex = parseInt(vMatch[1]);
            val = sharedStrings[siIndex] || "";
          } else {
            const raw = vMatch[1];
            if (dateStyles.has(styleIdx) && /^-?\d+(\.\d+)?$/.test(raw)) {
              const serial = parseFloat(raw);
              val = serial > 0 && serial < 2958466 ? excelSerialToDateString(serial) : raw;
            } else {
              val = raw;
            }
          }
        }

        const isYellow = styleIdx >= 0 && yellowStyles.has(styleIdx);
        const isRedFont = styleIdx >= 0 && redFontStyles.has(styleIdx);

        if (isYellow || isRedFont) {
          // マージ内の非 top-left は装飾セル扱いで skip
          if (mergeSuppressed.has(ref)) {
            if (val.trim()) rowTexts.push(val);
            continue;
          }
          // セル全体が可変 (空でも slot として登録 → 株主リスト等の空欄行で重要)
          slots.set(slotId, val);
          slotPositions.set(slotId, { ref, sheetName });
          const placeholder = `［要入力_${slotId}］`;
          rowTexts.push(placeholder);
          cellTexts.set(ref, placeholder);  // セル全体 = この 1 placeholder
          slotId++;
        } else if (val.trim() && siIndex >= 0 && redSiMap.has(siIndex)) {
          // 赤 run 含むセル: 赤部分だけ slot 化、他は固定文字として残す
          const runs = redSiMap.get(siIndex)!;
          let cellText = "";
          for (const run of runs) {
            if (run.isRed) {
              slots.set(slotId, run.text);
              slotPositions.set(slotId, { ref, sheetName });
              cellText += `［要入力_${slotId}］`;
              slotId++;
            } else {
              cellText += run.text;
            }
          }
          rowTexts.push(cellText);
          cellTexts.set(ref, cellText);  // 固定文 + 複数 placeholder のテンプレ
        } else if (val.trim()) {
          rowTexts.push(val);
        }
      }
      if (rowTexts.some(t => t.trim())) lines.push(rowTexts.join("\t"));
    }
  }
  return { text: lines.join("\n"), slots, slotPositions, cellTexts, percentRefs };
}

// Excelの全体テキストを★マーク付きで返す（旧方式、後方互換用）
export function getXlsxMarkedText(buffer: Buffer): string {
  const cells = extractXlsxMarkedCells(buffer);
  if (cells.length === 0) return "";

  const zip = new PizZip(buffer);
  const ssXml = zip.file("xl/sharedStrings.xml")?.asText();
  const sharedStrings = ssXml ? getSharedStrings(ssXml) : [];
  // 日付セル判定は1回だけ準備してループ内で参照（以前はセルごとに再パースしていて非効率）
  const stylesXml = zip.file("xl/styles.xml")?.asText() || "";
  const yellowStyles = findYellowStyleIndexes(stylesXml);
  const dateStyles = findDateStyleIndexes(stylesXml);

  // 全テキストを行ごとに構築（黄色セルは★マーク）
  const lines: string[] = [];

  for (const fileName of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fileName)) continue;
    const sheetXml = zip.file(fileName)?.asText();
    if (!sheetXml) continue;

    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(sheetXml)) !== null) {
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      const rowTexts: string[] = [];
      while ((cm = cellRe.exec(rm[1])) !== null) {
        const attrs = cm[1];
        const inner = cm[2] || "";
        const vMatch = inner.match(/<v>([^<]*)<\/v>/);
        if (!vMatch) continue;

        const tMatch = attrs.match(/\bt="([^"]*)"/);
        const sMatch = attrs.match(/\bs="(\d+)"/);
        const styleIdx = sMatch ? parseInt(sMatch[1]) : -1;
        let val = "";
        if (tMatch?.[1] === "s") {
          val = sharedStrings[parseInt(vMatch[1])] || "";
        } else {
          const raw = vMatch[1];
          // 日付セルの数値は ISO 日付に変換
          if (dateStyles.has(styleIdx) && /^-?\d+(\.\d+)?$/.test(raw)) {
            const serial = parseFloat(raw);
            val = serial > 0 && serial < 2958466 ? excelSerialToDateString(serial) : raw;
          } else {
            val = raw;
          }
        }

        const isYellow = styleIdx >= 0 && yellowStyles.has(styleIdx);

        rowTexts.push(isYellow ? `★${val}★` : val);
      }
      if (rowTexts.some(t => t.trim())) {
        lines.push(rowTexts.join("\t"));
      }
    }
  }

  // ★★ を結合
  let result = lines.join("\n");
  while (result.includes("★★")) result = result.replace(/★★/g, "");
  return result;
}
