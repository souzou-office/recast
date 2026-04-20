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
    // 自己閉じ <c .../> と内容あり <c ...>...</c> の両方を正しく分離
    // （貪欲な [^>]* が自己閉じの / を吸収し、後続セルを巻き込むバグを防ぐ）
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
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
    newSsXml = newSsXml.replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, (whole: string) => {
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

    // 自己閉じの <c .../> は <v> を持たないので処理対象外（内容あり形式だけ変換）
    // 属性内に / が混入しないよう [^>\/] で制限し、後続セルを巻き込まないようにする
    sheetXml = sheetXml.replace(
      /<c\b([^>\/]*)>([\s\S]*?)<\/c>/g,
      (whole: string, attrs: string, inner: string) => {
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

// 黄色データ行（連続した黄色値入り行）が不足している場合、最終行を複製して必要件数まで増やす。
// 各新規行のセル値は "__ROW_N_COL__" 形式の一意プレースホルダーにしてAIが行ごとに識別できるようにする。
// 後続行の row 番号とセル参照（r="A12" 等）もシフトする。
// mergeCells, formulas 等の参照更新は簡易（SUM(A9:A18) 等は元の範囲のままで、追加行が含まれる想定）。
export function expandYellowRowBlock(buffer: Buffer, desiredRows: number): Buffer {
  if (desiredRows <= 0) return buffer;
  const zip = new PizZip(buffer);
  const stylesXml = zip.file("xl/styles.xml")?.asText();
  if (!stylesXml) return buffer;
  const yellowStyles = findYellowStyleIndexes(stylesXml);
  if (yellowStyles.size === 0) return buffer;

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
        if (!s || !yellowStyles.has(parseInt(s[1]))) continue;
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

// Excelの全体テキストを ［要入力_N］ 付きで返す（黄色セルの値は隠す）。
// AIは前案件の値に引きずられず文脈だけで判断できる。
// slots: N → セルの元値（originalValue）。extractXlsxMarkedCells と同じ順序。
export function getXlsxMarkedTextWithSlots(buffer: Buffer): { text: string; slots: Map<number, string> } {
  const zip = new PizZip(buffer);
  const stylesXml = zip.file("xl/styles.xml")?.asText() || "";
  const yellowStyles = findYellowStyleIndexes(stylesXml);
  const ssXml = zip.file("xl/sharedStrings.xml")?.asText();
  const sharedStrings = ssXml ? getSharedStrings(ssXml) : [];

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
        let val = "";
        if (tMatch?.[1] === "s") val = sharedStrings[parseInt(vMatch[1])] || "";
        else val = vMatch[1];
        const sMatch = attrs.match(/\bs="(\d+)"/);
        const isYellow = sMatch && yellowStyles.has(parseInt(sMatch[1]));
        if (!val.trim()) continue;
        if (/<f\b/.test(inner)) { rowTexts.push(val); continue; } // 数式セルは素通し
        if (isYellow) {
          slots.set(slotId, val);
          // 《前案件:...》 で前案件の値を明示（型判定用ヒント）
          rowTexts.push(`［要入力_${slotId}《前案件:${val}》］`);
          slotId++;
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
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
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
