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

    // セルを「行順 × 列順」で1パス走査。
    // 各セルで以下を順に処理（getXlsxMarkedTextWithSlots と同じ順序）:
    //   ① 黄色塗り or 赤フォント → セル全体を slot として cells に追加
    //   ② 赤い rich text run を含むセル → 各赤 run を順に cells に追加
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

        const styleIdx = sMatch ? parseInt(sMatch[1]) : -1;
        const tMatch = attrs.match(/\bt="([^"]*)"/);
        const vMatch = inner.match(/<v>([^<]*)<\/v>/);
        if (!vMatch) continue;

        // 値抽出（共有文字列 or 数値、日付シリアルは ISO 日付に変換）
        let value = "";
        let siIndex = -1;
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
        if (!value.trim()) continue;
        if (/<f\b/.test(inner)) continue; // 数式セルはスキップ

        const isYellow = styleIdx >= 0 && yellowStyles.has(styleIdx);
        const isRedFont = styleIdx >= 0 && redFontStyles.has(styleIdx);

        if (isYellow || isRedFont) {
          // ① セル全体マーカー
          cells.push({ ref, value, sheetName });
        } else if (siIndex >= 0 && redSiMap.has(siIndex)) {
          // ② 赤 run マーカー（赤い部分だけを順に push）
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

// 黄色セルの値を差し替えた xlsx Buffer を返す
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
    // データリスト候補: ブロック行数 >= 2 かつ 行あたり 3 セル以上黄色 なブロックのみ。
    // これで署名欄（1-2セル/行）や単独データ行を除外し、「繰り返し入力フォーム」だけを対象にする。
    const listCandidates = blocks.filter(b => (b.end - b.start + 1) >= 2 && b.maxCellsPerRow >= 3);
    if (listCandidates.length === 0) continue;
    // 行数が多い → セル数が多い の順で優先
    listCandidates.sort((a, b) => {
      const sizeDiff = (b.end - b.start) - (a.end - a.start);
      if (sizeDiff !== 0) return sizeDiff;
      return b.maxCellsPerRow - a.maxCellsPerRow;
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
export function getXlsxMarkedTextWithSlots(buffer: Buffer): { text: string; slots: Map<number, string> } {
  const zip = new PizZip(buffer);
  const stylesXml = zip.file("xl/styles.xml")?.asText() || "";
  const yellowStyles = findYellowStyleIndexes(stylesXml);
  const redFontStyles = findRedFontStyleIndexes(stylesXml);
  const dateStyles = findDateStyleIndexes(stylesXml);
  const ssXml = zip.file("xl/sharedStrings.xml")?.asText();
  const sharedStrings = ssXml ? getSharedStrings(ssXml) : [];
  const redSiMap = ssXml ? findRedSharedStrings(ssXml) : new Map<number, SiRun[]>();

  const slots = new Map<number, string>();
  let slotId = 0;
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
        let siIndex = -1;
        if (tMatch?.[1] === "s") {
          siIndex = parseInt(vMatch[1]);
          val = sharedStrings[siIndex] || "";
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
        const isRedFont = styleIdx >= 0 && redFontStyles.has(styleIdx);
        if (!val.trim()) continue;
        if (/<f\b/.test(inner)) { rowTexts.push(val); continue; } // 数式セルは素通し
        if (isYellow || isRedFont) {
          // セル全体が可変（黄色塗り or セル全体赤フォント）
          slots.set(slotId, val);
          rowTexts.push(`［要入力_${slotId}］`);
          slotId++;
        } else if (siIndex >= 0 && redSiMap.has(siIndex)) {
          // 赤 run 含むセル: 赤部分だけ slot 化、他は固定文字として残す
          const runs = redSiMap.get(siIndex)!;
          let cellText = "";
          for (const run of runs) {
            if (run.isRed) {
              slots.set(slotId, run.text);
              cellText += `［要入力_${slotId}］`;
              slotId++;
            } else {
              cellText += run.text;
            }
          }
          rowTexts.push(cellText);
        } else {
          rowTexts.push(val);
        }
      }
      if (rowTexts.some(t => t.trim())) lines.push(rowTexts.join("\t"));
    }
  }
  return { text: lines.join("\n"), slots };
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
