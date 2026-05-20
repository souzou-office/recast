// docx-structure-parser.ts
// docx を「段落・見出し・表セル・リスト項目」の位置順アンカー列に分解する。
// 既存の docx-marker-parser.ts はフラットテキスト化しかしないので、
// 「どの議案ブロックに属するか」「表の何行目何列目か」みたいな構造情報が見えない。
// 仕様書生成（spec-generator.ts）で AI に位置順×セクション付きで渡すために使う。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

export type AnchorKind = "paragraph" | "heading" | "table_cell" | "list_item";

export interface MarkerInfo {
  markerId: number;        // docx-marker-parser の MarkedField.id と一致
  value: string;           // ハイライトされていた元の値
  before: string;          // マーカー直前のテキスト（最大30文字）
  after: string;           // マーカー直後のテキスト（最大30文字）
}

export interface StructuredAnchor {
  anchorId: string;          // 例: "p3", "h1", "t1-r2-c1", "li5"
  position: number;          // 文書全体の位置順（0始まり）
  kind: AnchorKind;

  // 構造的位置
  paragraphIndex?: number;
  tableIndex?: number;
  rowIndex?: number;
  colIndex?: number;
  headingLevel?: number;
  listLevel?: number;

  // 直近の見出し（議案名等）。位置から逆引きされる
  section?: string;

  text: string;              // この位置のテキスト全体
  markers: MarkerInfo[];     // この位置に含まれるハイライト一覧
}

export interface StructuredDocx {
  anchors: StructuredAnchor[];
  // 検出されたセクション一覧（議案ブロック等）
  sections: string[];
}

// XMLデコード/エスケープ
function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

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

// 見出しスタイル判定。Word の標準見出しスタイルは pStyle val が
// "Heading1" "Heading2" 等、または "見出し1" "見出し2"。
function getHeadingLevel(pXml: string): number | null {
  const m = pXml.match(
    /<w:pStyle\s+w:val="(Heading|見出し|heading)(\d+)"\s*\/>/i,
  );
  if (m) return parseInt(m[2], 10);
  return null;
}

// リスト項目判定。numPr が存在すれば list item。
function getListLevel(pXml: string): number | null {
  const m = pXml.match(/<w:numPr>[\s\S]*?<w:ilvl\s+w:val="(\d+)"/);
  if (m) return parseInt(m[1], 10);
  if (/<w:numPr>/.test(pXml)) return 0;
  return null;
}

// テキストから「議案見出し」っぽいパターンを抽出する。
// 「第1号議案」「第二号議案」「第3号 議案」みたいなのを拾う。
// 見出しスタイルが付いていない場合のフォールバック。
function detectAgendaHeading(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const m = trimmed.match(
    /^(第\s*[一二三四五六七八九十0-9０-９]+\s*号\s*議案[^\n]{0,80})/,
  );
  if (m) return m[1].trim();
  return null;
}

// 段落XMLから (run XML, isHighlight) を順に返す
function* iterateRuns(
  pXml: string,
): Generator<{ runXml: string; text: string; highlighted: boolean }> {
  const cleanInner = pXml.replace(
    /<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g,
    "",
  );
  const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  let m;
  while ((m = runRe.exec(cleanInner)) !== null) {
    yield {
      runXml: m[0],
      text: getRunText(m[0]),
      highlighted: hasHighlight(m[0]),
    };
  }
}

// 段落のテキスト全体 + マーカー情報を返す。
// マーカーは markerIdSeed から連番で振る（呼び出し側で管理）。
function parseParagraphContent(
  pXml: string,
  markerIdSeed: number,
): { text: string; markers: MarkerInfo[]; nextMarkerId: number } {
  const markers: MarkerInfo[] = [];
  let fullText = "";
  let currentGroup = "";
  let groupStartPos = -1;
  let nextId = markerIdSeed;

  const flush = () => {
    if (!currentGroup) return;
    const beforeText = fullText.slice(Math.max(0, fullText.length - 30));
    markers.push({
      markerId: nextId++,
      value: currentGroup,
      before: beforeText,
      after: "", // 後段で埋める
    });
    fullText += currentGroup;
    currentGroup = "";
    groupStartPos = -1;
  };

  for (const r of iterateRuns(pXml)) {
    if (!r.text) continue;
    if (r.highlighted) {
      if (currentGroup === "") groupStartPos = fullText.length;
      currentGroup += r.text;
    } else {
      flush();
      fullText += r.text;
    }
  }
  flush();

  // after を後段で埋める（全文ができてから）
  let cursor = 0;
  for (const mk of markers) {
    const idx = fullText.indexOf(mk.value, cursor);
    if (idx >= 0) {
      mk.after = fullText.slice(
        idx + mk.value.length,
        idx + mk.value.length + 30,
      );
      cursor = idx + mk.value.length;
    }
  }
  // groupStartPos は将来用（今は未使用）
  void groupStartPos;

  return { text: fullText, markers, nextMarkerId: nextId };
}

// AlternateContent を除外したトップレベル段落の範囲を返す（既存パーサーと同じ方針）
type ParaRange = { start: number; end: number; openEnd: number };
function findTopLevelParagraphs(xml: string): ParaRange[] {
  const results: ParaRange[] = [];
  let pos = 0;
  const pOpenRe = /<w:p\b[^>]*>/g;
  while (pos < xml.length) {
    pOpenRe.lastIndex = pos;
    const mOpen = pOpenRe.exec(xml);
    if (!mOpen) break;
    const before = xml.slice(0, mOpen.index);
    // AlternateContent 内なら skip
    let inAlt = false;
    let scanPos = 0;
    while (scanPos < before.length) {
      const s = before.slice(scanPos).search(/<mc:AlternateContent\b/);
      if (s < 0) break;
      const absS = scanPos + s;
      const e = xml.slice(absS).search(/<\/mc:AlternateContent>/);
      if (e < 0) {
        inAlt = true;
        break;
      }
      const absE = absS + e + "</mc:AlternateContent>".length;
      if (absE > mOpen.index) {
        inAlt = true;
        break;
      }
      scanPos = absE;
    }
    if (inAlt) {
      pos = mOpen.index + mOpen[0].length;
      continue;
    }
    if (results.some((r) => r.start < mOpen.index && mOpen.index < r.end)) {
      pos = mOpen.index + mOpen[0].length;
      continue;
    }
    const openEnd = mOpen.index + mOpen[0].length;
    let i = openEnd;
    let altDepth = 0;
    let pDepth = 0;
    let closeAt = -1;
    while (i < xml.length) {
      if (
        xml.startsWith("<mc:AlternateContent", i) &&
        /^<mc:AlternateContent\b/.test(xml.slice(i))
      ) {
        altDepth++;
        const tagEnd = xml.indexOf(">", i);
        if (tagEnd < 0) break;
        i = tagEnd + 1;
        continue;
      }
      if (xml.startsWith("</mc:AlternateContent>", i)) {
        altDepth = Math.max(0, altDepth - 1);
        i += "</mc:AlternateContent>".length;
        continue;
      }
      if (altDepth === 0 && /^<w:p[\s>]/.test(xml.slice(i, i + 5))) {
        pDepth++;
        const tagEnd = xml.indexOf(">", i);
        if (tagEnd < 0) break;
        i = tagEnd + 1;
        continue;
      }
      if (xml.startsWith("</w:p>", i)) {
        if (altDepth === 0 && pDepth === 0) {
          closeAt = i;
          break;
        }
        if (altDepth === 0 && pDepth > 0) pDepth--;
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

// テーブルの行・セルを抽出。表セルは内部に <w:p> を持つので再帰的にパースが必要。
interface TableCell {
  rowIndex: number;
  colIndex: number;
  paragraphs: string[]; // 各段落のXML
}

function extractTableCells(tableXml: string): TableCell[] {
  const cells: TableCell[] = [];
  const rowRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
  let rowMatch;
  let rowIndex = 0;
  while ((rowMatch = rowRe.exec(tableXml)) !== null) {
    const rowXml = rowMatch[1];
    const cellRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
    let cellMatch;
    let colIndex = 0;
    while ((cellMatch = cellRe.exec(rowXml)) !== null) {
      const cellXml = cellMatch[1];
      const pXmls: string[] = [];
      const pRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
      let pMatch;
      while ((pMatch = pRe.exec(cellXml)) !== null) {
        pXmls.push(pMatch[0]);
      }
      cells.push({ rowIndex, colIndex, paragraphs: pXmls });
      colIndex++;
    }
    rowIndex++;
  }
  return cells;
}

// docx Buffer → 構造化アンカー列
export function parseDocxStructure(buffer: Buffer): StructuredDocx {
  const zip = new PizZip(buffer);
  const rawXml = zip.file("word/document.xml")?.asText();
  if (!rawXml) return { anchors: [], sections: [] };

  const docXml = rawXml.replace(
    /<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g,
    "",
  );

  // body 内の要素を「段落」「表」の順に位置順で収集。
  // <w:body> 直下の <w:p> と <w:tbl> を順番に拾う必要がある。
  const body = docXml.match(/<w:body>([\s\S]*?)<\/w:body>/)?.[1] ?? docXml;

  // 段落と表のオフセット位置を全部集めてソートし、登場順に処理
  type BodyElement = { kind: "p" | "tbl"; start: number; end: number };
  const elements: BodyElement[] = [];

  // 段落
  const paragraphs = findTopLevelParagraphs(body);
  for (const p of paragraphs) {
    elements.push({ kind: "p", start: p.start, end: p.end });
  }

  // テーブル
  const tblRe = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g;
  let tblMatch;
  while ((tblMatch = tblRe.exec(body)) !== null) {
    elements.push({
      kind: "tbl",
      start: tblMatch.index,
      end: tblMatch.index + tblMatch[0].length,
    });
  }

  elements.sort((a, b) => a.start - b.start);

  const anchors: StructuredAnchor[] = [];
  const sections: string[] = [];
  let currentSection: string | undefined;
  let position = 0;
  let paragraphIndex = 0;
  let tableIndex = 0;
  let markerIdSeed = 0;

  for (const el of elements) {
    const xml = body.slice(el.start, el.end);

    if (el.kind === "p") {
      const headingLevel = getHeadingLevel(xml);
      const listLevel = getListLevel(xml);
      const { text, markers, nextMarkerId } = parseParagraphContent(
        xml,
        markerIdSeed,
      );
      markerIdSeed = nextMarkerId;

      // セクション境界の検出
      // 1) 明示的な見出しスタイル
      // 2) 「第○号議案」パターン
      let sectionUpdated = false;
      if (headingLevel !== null && text.trim()) {
        currentSection = text.trim();
        sections.push(currentSection);
        sectionUpdated = true;
      } else {
        const agenda = detectAgendaHeading(text);
        if (agenda) {
          currentSection = agenda;
          sections.push(currentSection);
          sectionUpdated = true;
        }
      }

      if (!text.trim() && markers.length === 0) {
        paragraphIndex++;
        continue;
      }

      const kind: AnchorKind = sectionUpdated
        ? "heading"
        : listLevel !== null
          ? "list_item"
          : "paragraph";

      anchors.push({
        anchorId: kind === "heading" ? `h${position}` : `p${paragraphIndex}`,
        position: position++,
        kind,
        paragraphIndex,
        headingLevel: headingLevel ?? undefined,
        listLevel: listLevel ?? undefined,
        section: currentSection,
        text,
        markers,
      });

      paragraphIndex++;
    } else {
      // 表
      const cells = extractTableCells(xml);
      for (const cell of cells) {
        let cellText = "";
        let cellMarkers: MarkerInfo[] = [];
        for (const pXml of cell.paragraphs) {
          const { text, markers, nextMarkerId } = parseParagraphContent(
            pXml,
            markerIdSeed,
          );
          markerIdSeed = nextMarkerId;
          if (cellText && text) cellText += "\n";
          cellText += text;
          cellMarkers = cellMarkers.concat(markers);
        }
        if (!cellText.trim() && cellMarkers.length === 0) continue;
        anchors.push({
          anchorId: `t${tableIndex}-r${cell.rowIndex}-c${cell.colIndex}`,
          position: position++,
          kind: "table_cell",
          tableIndex,
          rowIndex: cell.rowIndex,
          colIndex: cell.colIndex,
          section: currentSection,
          text: cellText,
          markers: cellMarkers,
        });
      }
      tableIndex++;
    }
  }

  return { anchors, sections };
}

// AI に渡すための簡潔なテキスト表現を作る。
// 各アンカーを「[position] (kind, section) text { markers: [...] }」みたいな形に。
export function formatStructureForAI(structure: StructuredDocx): string {
  const lines: string[] = [];
  let lastSection: string | undefined;

  for (const a of structure.anchors) {
    if (a.section !== lastSection) {
      lines.push("");
      lines.push(`=== セクション: ${a.section ?? "(冒頭)"} ===`);
      lastSection = a.section;
    }

    const loc =
      a.kind === "table_cell"
        ? `表${a.tableIndex! + 1} 行${a.rowIndex! + 1}列${a.colIndex! + 1}`
        : a.kind === "heading"
          ? `見出し(レベル${a.headingLevel ?? "-"})`
          : a.kind === "list_item"
            ? `箇条書き(レベル${a.listLevel ?? 0})`
            : `段落${a.paragraphIndex! + 1}`;

    const markerStr =
      a.markers.length > 0
        ? ` { ハイライト: ${a.markers.map((m) => `「${m.value}」`).join(" / ")} }`
        : "";

    lines.push(`[${a.anchorId}] (${loc}) ${a.text}${markerStr}`);
  }
  return lines.join("\n");
}
