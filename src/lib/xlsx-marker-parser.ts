// xlsx-marker-parser.ts
// Excelのセル背景色（黄色）をマーカーとして検出し、値を差し替えるユーティリティ。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

export interface XlsxMarkedCell {
  ref: string;       // "B14"
  value: string;     // セルの現在の値（前案件のデータ）
  sheetName: string; // シート名
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
    strings.push(text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  }
  return strings;
}

// xlsx Buffer → 黄色セルの一覧を返す
export function extractXlsxMarkedCells(buffer: Buffer): XlsxMarkedCell[] {
  const zip = new PizZip(buffer);
  const stylesXml = zip.file("xl/styles.xml")?.asText();
  if (!stylesXml) return [];

  const yellowStyles = findYellowStyleIndexes(stylesXml);
  if (yellowStyles.size === 0) return [];

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

    // セルを走査
    const cellRe = /<c\b([^>]*)(?:\/|>([\s\S]*?)<\/c)>/g;
    let cm;
    while ((cm = cellRe.exec(sheetXml)) !== null) {
      const attrs = cm[1];
      const inner = cm[2] || "";

      const sMatch = attrs.match(/\bs="(\d+)"/);
      const rMatch = attrs.match(/\br="([A-Z]+\d+)"/);
      if (!sMatch || !rMatch) continue;

      const styleIdx = parseInt(sMatch[1]);
      if (!yellowStyles.has(styleIdx)) continue;

      const ref = rMatch[1];
      const tMatch = attrs.match(/\bt="([^"]*)"/);
      const vMatch = inner.match(/<v>([^<]*)<\/v>/);

      let value = "";
      if (vMatch) {
        if (tMatch?.[1] === "s") {
          // 共有文字列参照
          const idx = parseInt(vMatch[1]);
          value = sharedStrings[idx] || "";
        } else {
          value = vMatch[1];
        }
      }

      // 空セルや数式セル（合計行等）はスキップ
      if (!value.trim()) continue;
      // 数式があるセルはスキップ（合計・割合等の計算セル）
      if (/<f\b/.test(inner)) continue;

      cells.push({ ref, value, sheetName });
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
  if (yellowStyles.size === 0) return buffer;

  const ssXml = zip.file("xl/sharedStrings.xml")?.asText();
  const sharedStrings = ssXml ? getSharedStrings(ssXml) : [];

  const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // sharedStrings.xml の置換
  if (ssXml) {
    let newSsXml = ssXml;
    let siIndex = 0;
    newSsXml = newSsXml.replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, (whole) => {
      const origValue = sharedStrings[siIndex++];
      const newValue = replacements[origValue];
      if (newValue === undefined) return whole;
      // 新しい値で <si><t>...</t></si> に置換
      return `<si><t>${xmlEscape(newValue)}</t></si>`;
    });
    zip.file("xl/sharedStrings.xml", newSsXml);
  }

  // 数値セル（t="s"でない黄色セル）の直接置換
  for (const fileName of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fileName)) continue;
    let sheetXml = zip.file(fileName)?.asText();
    if (!sheetXml) continue;
    let changed = false;

    sheetXml = sheetXml.replace(
      /<c\b([^>]*)>([\s\S]*?)<\/c>/g,
      (whole, attrs, inner) => {
        const sMatch = attrs.match(/\bs="(\d+)"/);
        if (!sMatch || !yellowStyles.has(parseInt(sMatch[1]))) return whole;
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

  // rPh/phoneticPr を除去
  const finalSs = zip.file("xl/sharedStrings.xml")?.asText();
  if (finalSs) {
    const cleaned = finalSs
      .replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "")
      .replace(/<phoneticPr\b[^>]*\/>/g, "");
    if (cleaned !== finalSs) zip.file("xl/sharedStrings.xml", cleaned);
  }

  // 黄色フィルを透明（none）に変更 → セルの背景色が消える
  const updatedStyles = zip.file("xl/styles.xml")?.asText();
  if (updatedStyles) {
    const cleaned = updatedStyles.replace(
      /<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"[^/]*\/><bgColor[^/]*\/><\/patternFill><\/fill>/gi,
      '<fill><patternFill patternType="none"/></fill>'
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

// Excelの全体テキストを★マーク付きで返す（Word版と同じ発想）
export function getXlsxMarkedText(buffer: Buffer): string {
  const cells = extractXlsxMarkedCells(buffer);
  if (cells.length === 0) return "";

  const zip = new PizZip(buffer);
  const ssXml = zip.file("xl/sharedStrings.xml")?.asText();
  const sharedStrings = ssXml ? getSharedStrings(ssXml) : [];

  // 全テキストを行ごとに構築（黄色セルは★マーク）
  const yellowValues = new Set(cells.map(c => c.value));
  const lines: string[] = [];

  for (const fileName of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fileName)) continue;
    const sheetXml = zip.file(fileName)?.asText();
    if (!sheetXml) continue;

    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(sheetXml)) !== null) {
      const cellRe = /<c\b([^>]*)(?:\/|>([\s\S]*?)<\/c)>/g;
      let cm;
      const rowTexts: string[] = [];
      while ((cm = cellRe.exec(rm[1])) !== null) {
        const attrs = cm[1];
        const inner = cm[2] || "";
        const vMatch = inner.match(/<v>([^<]*)<\/v>/);
        if (!vMatch) continue;

        const tMatch = attrs.match(/\bt="([^"]*)"/);
        let val = "";
        if (tMatch?.[1] === "s") {
          val = sharedStrings[parseInt(vMatch[1])] || "";
        } else {
          val = vMatch[1];
        }

        const sMatch = attrs.match(/\bs="(\d+)"/);
        const stylesXml = zip.file("xl/styles.xml")?.asText() || "";
        const yellowStylesLocal = findYellowStyleIndexes(stylesXml);
        const isYellow = sMatch && yellowStylesLocal.has(parseInt(sMatch[1]));

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
