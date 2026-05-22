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

// === 段落番号方式 (1-indexed) ===
// AI には marked text に `段落N: paragraph text` の形式で番号付きで見せる。
// 1 つの段落に対して同時に複数 op を指定できない構造にして、
// 重複指示による XML 破壊を **構造的に** 防ぐ。

/**
 * markedText に「段落N: 」または「行N: 」プレフィックスを付ける共通関数。
 *
 * **重要**: この番号付けが produce-v2 の getContentParagraphs (非空段落のみ 1-indexed)
 * と **完全一致** することが changes スキーマ正常動作の前提条件。
 * AI に渡される markedText と produce-v2 が処理する段落番号がズレると、AI の changes が
 * 全部誤爆する (Polaris ケース: 「下記の者を取締役として選任すること」が消える等)。
 *
 * - docx: 空段落 ("(空)" マーカー行) は番号付けない (return line)
 *         中身のある段落のみ連番。produce-v2 の getContentParagraphs と一致。
 * - xlsx: Excel 行番号 (r= 値) を XML から読んで割り当てる。
 *
 * @param markedTextRaw - getMarkedDocumentTextWithSlots / getXlsxMarkedTextWithSlots の text
 *                        (★label★ 置換は呼び出し側で済ませた状態を想定)
 * @param buf - xlsx の場合は Excel ファイルの Buffer (Excel 行番号取得のため)
 * @param isXlsx - xlsx なら true
 */
export function addMarkedTextNumbering(
  markedTextRaw: string,
  buf: Buffer,
  isXlsx: boolean
): string {
  if (isXlsx) {
    // xlsx: Excel 行番号で labelled する
    const zip = new PizZip(buf);
    const sheetFiles = Object.keys(zip.files)
      .filter((fn: string) => /^xl\/worksheets\/sheet\d+\.xml$/.test(fn))
      .sort();
    const xlsxRowNumbers: number[] = [];
    for (const sf of sheetFiles) {
      const sheetXml = zip.file(sf)?.asText() || "";
      const rowRe = /<row\b[^>]*?r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
      let rm2;
      while ((rm2 = rowRe.exec(sheetXml)) !== null) {
        const inner = rm2[2];
        const cellRe = /<c\b[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g;
        let hasContent = false;
        let cm2;
        while ((cm2 = cellRe.exec(inner)) !== null) {
          const cellInner = cm2[1] || "";
          if (/<v>[^<]*<\/v>/.test(cellInner)) {
            hasContent = true;
            break;
          }
        }
        if (hasContent) xlsxRowNumbers.push(parseInt(rm2[1], 10));
      }
    }
    const cleaned = markedTextRaw.replace(/\r\n/g, " / ").replace(/\r/g, " / ");
    const lines = cleaned.split("\n");
    let rowIdx = 0;
    return lines
      .map((line) => {
        if (line.trim().length === 0) return line;
        const rowNum = xlsxRowNumbers[rowIdx++] ?? rowIdx;
        return `行${rowNum}: ${line}`;
      })
      .join("\n");
  } else {
    // docx: 1-indexed 連番 (空段落 "(空)" マーカー行は除外して連番つけない)
    let lineCounter = 0;
    return markedTextRaw
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed === "(空)") return line;
        lineCounter++;
        return `段落${lineCounter}: ${line}`;
      })
      .join("\n");
  }
}

// 段落単位の操作 (この段落をどうするか)。同じ paragraphIndex は配列に 1 度だけ。
export interface ParagraphActionOp {
  paragraphIndex: number;             // 1-indexed
  action: "delete" | "rewrite";
  newText?: string;                   // action="rewrite" のとき必須
}

// 指定段落の直後に新規段落を挿入 (段落単位の操作とは別軸)
export interface InsertOp {
  afterParagraphIndex: number; // 1-indexed
  contents: string[];           // 各要素 = 1 段落分のテキスト
}

export type FillsOp = Record<string, string>; // { "★label★": "value" }

// 任意テキスト置換 (議案番号繰り上げ等)
export interface ReplaceOp {
  anchor: string;
  replacement: string;
}

export interface ProduceEdits {
  paragraphActions?: ParagraphActionOp[]; // 段落ごとに delete or rewrite (重複不可)
  inserts?: InsertOp[];                    // 段落追加 (afterParagraphIndex 指定)
  fills?: FillsOp;                         // ★label★ → 値
  replaces?: ReplaceOp[];                  // 全文一括テキスト置換
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
//
// 重要: slotId は labels.json と完全一致させる必要がある (= forward 順)。
//       labels.json は文書を上から走査して 0, 1, 2... と採番されている。
//       なので flatten も forward に走査して slotId を採取し、
//       実際の置換は位置ずれ防止のため reverse に適用する。

function flattenHighlights(docXml: string, labels: TemplateLabels | null): string {
  const labelById = new Map<number, string>();
  for (const s of labels?.slots || []) {
    if (s.label && s.label !== "不明") labelById.set(s.slotId, s.label);
  }

  // 全 paragraph を forward に走査して slot 範囲と slotId、最初の run の rPr を採取。
  // rPr を継承することで、フォント・サイズ・カラー等を保持して ★label★ プレーン化する
  // (ハイライト属性と赤フォント色だけは除去)。
  type SlotGroup = { paraIdx: number; absStart: number; absEnd: number; slotId: number; label: string; rPr: string };
  const allGroups: SlotGroup[] = [];
  const paragraphs = findTopLevelParagraphs(docXml);

  let slotId = 0;
  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p];
    const inner = docXml.slice(para.openEnd, para.end - "</w:p>".length);
    const txbxRanges: { start: number; end: number }[] = [];
    const txbxRe = /<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g;
    let txm;
    while ((txm = txbxRe.exec(inner)) !== null) {
      txbxRanges.push({ start: txm.index, end: txm.index + txm[0].length });
    }
    const isInTxbx = (pos: number) => txbxRanges.some((r) => pos >= r.start && pos < r.end);

    const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    let groupStart: number | null = null;
    let groupEnd: number | null = null;
    let groupRPr = "";
    const flushGroup = () => {
      if (groupStart !== null && groupEnd !== null) {
        const label = labelById.get(slotId) || `要入力_${slotId}`;
        allGroups.push({
          paraIdx: p,
          absStart: para.openEnd + groupStart,
          absEnd: para.openEnd + groupEnd,
          slotId,
          label,
          rPr: groupRPr,
        });
        slotId++;
        groupStart = null;
        groupEnd = null;
        groupRPr = "";
      }
    };
    let rm;
    while ((rm = runRe.exec(inner)) !== null) {
      if (isInTxbx(rm.index)) continue;
      const text = getRunText(rm[0]);
      if (!text) continue;
      if (hasHighlight(rm[0])) {
        if (groupStart === null) {
          groupStart = rm.index;
          // 最初の highlighted run の <w:rPr> を抜き出して、ハイライト属性・赤フォント色を除去
          const rPrMatch = rm[0].match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
          if (rPrMatch) {
            groupRPr = rPrMatch[0]
              .replace(/<w:highlight\b[^/>]*\/>/gi, "")
              .replace(/<w:color\s+w:val="FF0000"\s*\/>/gi, "");
            // 空の <w:rPr></w:rPr> になるなら空文字に
            if (/<w:rPr>\s*<\/w:rPr>/.test(groupRPr)) groupRPr = "";
          }
        }
        groupEnd = rm.index + rm[0].length;
      } else {
        flushGroup();
      }
    }
    flushGroup();
  }

  if (allGroups.length === 0) return docXml;

  // 置換は reverse 順 (後ろから) に適用して位置ずれを防ぐ
  for (let g = allGroups.length - 1; g >= 0; g--) {
    const grp = allGroups[g];
    const replacement = `<w:r>${grp.rPr}<w:t xml:space="preserve">★${grp.label}★</w:t></w:r>`;
    docXml = docXml.slice(0, grp.absStart) + replacement + docXml.slice(grp.absEnd);
  }

  return docXml;
}

function makePlainRun(text: string): string {
  return `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

// テキストだけの裸段落 (フォールバック)。本番では makeStyledParagraph を使うべき。
function makeParagraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

// 参照段落 (の XML) から <w:pPr> と <w:rPr> を取り出して、それを用いた段落を作る。
// これで挿入段落のフォント・サイズ・インデント等がテンプレ本文と揃う。
//
// 注意: 元段落の <w:rPr> には run 固有の表示効果が含まれることがある:
//   - <w:fitText w:val="1540" .../>: 指定幅にテキストを押し込む (例: "代表取締役" を
//     一定幅で「代　表　取　締　役」と広く見せるために使われる)
//   - <w:spacing w:val="..."/>: 文字間隔 (上記 fitText とセットでよく出る)
// これらを継承すると、挿入する長文が固定幅に押し込まれて極小表示になる事故が起きる。
// 新規挿入段落では run 固有の押し込み効果を **必ず除去** する。
function makeStyledParagraphFromReference(text: string, referenceParaXml: string): string {
  const pPrMatch = referenceParaXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  const pPr = pPrMatch ? pPrMatch[0] : "";

  // rPr 取得: 優先順位
  //   1. <w:pPr> 内の <w:rPr> (段落デフォルトの run 書式。fitText 等の run 固有効果が無いはず)
  //   2. 最初の <w:r> 内の <w:rPr>
  let rPr = "";
  if (pPr) {
    const pPrRPr = pPr.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
    if (pPrRPr) rPr = pPrRPr[0];
  }
  if (!rPr) {
    const rPrMatch = referenceParaXml.match(/<w:r\b[^>]*>[\s\S]*?(<w:rPr>[\s\S]*?<\/w:rPr>)/);
    if (rPrMatch) rPr = rPrMatch[1];
  }

  // run 固有の押し込み効果を除去 (fitText / character-level spacing)。
  // 段落単位の line spacing 等は pPr 側にあるのでこのストリップは安全。
  rPr = rPr
    .replace(/<w:fitText\b[^>]*\/>/g, "")
    .replace(/<w:fitText\b[^>]*>[\s\S]*?<\/w:fitText>/g, "")
    .replace(/<w:spacing\b[^>]*\/>/g, "");

  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

// --- 段落リスト構築 (中身のある段落のみ、1-indexed のため使用時は +1) ---

// AI に提示する番号体系と同じ "非空段落" の配列を返す。
// 全 op (deletes/inserts/rewrites) はこの配列の **index+1 (1-indexed)** を使う。
function getContentParagraphs(docXml: string): ParaRange[] {
  return findTopLevelParagraphs(docXml).filter((p) => {
    const inner = docXml.slice(p.openEnd, p.end - "</w:p>".length);
    return getParagraphText(inner).trim().length > 0;
  });
}

// 段落を書き換え (フォント等を保持しつつテキスト本文だけ差し替え)
function rewriteParagraphXml(paraXml: string, newText: string): string {
  let firstReplaced = false;
  let result = paraXml.replace(
    /(<w:r\b[^>]*>)([\s\S]*?)(<\/w:r>)/g,
    (match: string, openTag: string, inner: string, closeTag: string) => {
      if (!inner.includes("<w:t")) return match; // 非テキスト run はそのまま
      if (!firstReplaced) {
        firstReplaced = true;
        const newInner = inner.replace(
          /<w:t\b[^>]*>[\s\S]*?<\/w:t>/,
          `<w:t xml:space="preserve">${escapeXml(newText)}</w:t>`
        );
        return openTag + newInner + closeTag;
      }
      return "";
    }
  );
  // テキスト run が 1 つも無かった → 新規 <w:r><w:t> を </w:p> 直前に追加
  if (!firstReplaced) {
    result = paraXml.replace(/<\/w:p>\s*$/, `<w:r><w:t xml:space="preserve">${escapeXml(newText)}</w:t></w:r></w:p>`);
  }
  return result;
}

// --- 段落番号で全 op を適用 (paragraphActions + inserts) ---
// 全 op を ORIGINAL の段落番号で受け取り、絶対位置に解決してから後ろから順に適用する。
// 適用順は「位置の後ろ → 前」なので互いに影響しない。
// paragraphActions は段落単位で 1 op 限定 (重複してたら最初の 1 件のみ採用)。
// 同段落の delete と fill (★label★) の競合は fill 優先で delete を skip する (AI ミス対策)。
function applyIndexedOps(
  docXml: string,
  paragraphActions: ParagraphActionOp[],
  inserts: InsertOp[],
  fillMarkers: Set<string>, // fills で埋める ★label★ のラベル名集合 (delete 競合チェック用)
  log: { applied: { kind: string; detail: string }[]; skipped: { kind: string; detail: string; reason: string }[] }
): string {
  const paragraphs = getContentParagraphs(docXml);
  const total = paragraphs.length;
  const validIdx = (i: number) => i >= 1 && i <= total;

  type Op =
    | { kind: "delete"; pos: number; start: number; end: number; sortKey: number }
    | { kind: "rewrite"; pos: number; start: number; end: number; sortKey: number; newText: string; originalXml: string }
    | { kind: "insert"; pos: number; sortKey: number; contents: string[]; referenceXml: string };

  const ops: Op[] = [];

  // 同じ paragraphIndex が複数 action にあるなら最初の 1 件のみ採用 (構造的に重複できない設計だが保険)
  const seenIndices = new Set<number>();
  for (const pa of paragraphActions) {
    if (!validIdx(pa.paragraphIndex)) {
      log.skipped.push({
        kind: pa.action,
        detail: `index ${pa.paragraphIndex}`,
        reason: `範囲外 (1〜${total})`,
      });
      continue;
    }
    if (seenIndices.has(pa.paragraphIndex)) {
      log.skipped.push({
        kind: pa.action,
        detail: `段落 ${pa.paragraphIndex}`,
        reason: "同じ段落に複数 action 指定。最初の 1 件のみ採用",
      });
      continue;
    }
    seenIndices.add(pa.paragraphIndex);
    const p = paragraphs[pa.paragraphIndex - 1];
    if (pa.action === "delete") {
      // delete 対象の段落に fill 対象の ★label★ が含まれていたら、fill を優先して delete を skip。
      // (AI が同じ段落を delete と fill 両方に入れた事故対策。例: slot① を埋めるべきなのに
      //  間違って delete にも入れて、段落が消えて fill が無効化される現象を防ぐ)
      if (fillMarkers.size > 0) {
        const paraText = getParagraphText(docXml.slice(p.openEnd, p.end - "</w:p>".length));
        const conflictingMarker = [...fillMarkers].find((label) => paraText.includes(`★${label}★`));
        if (conflictingMarker) {
          log.skipped.push({
            kind: "delete",
            detail: `段落 ${pa.paragraphIndex}`,
            reason: `この段落に fill 対象の ★${conflictingMarker}★ があるため、fill 優先で delete を skip`,
          });
          continue;
        }
      }
      ops.push({ kind: "delete", pos: pa.paragraphIndex, start: p.start, end: p.end, sortKey: p.start });
    } else if (pa.action === "rewrite") {
      if (typeof pa.newText !== "string") {
        log.skipped.push({
          kind: "rewrite",
          detail: `段落 ${pa.paragraphIndex}`,
          reason: "newText が無い",
        });
        continue;
      }
      ops.push({
        kind: "rewrite",
        pos: pa.paragraphIndex,
        start: p.start,
        end: p.end,
        sortKey: p.start,
        newText: pa.newText,
        originalXml: docXml.slice(p.start, p.end),
      });
    }
  }

  // 挿入位置の調整: 指定段落の直後に空段落 (セクション区切り) があれば、その後ろに挿入する。
  //
  // 背景: AI (Phase 2) が「(甲) 最終行 = 段落 5 の直後に (乙) 新ブロック挿入」を指示するとき、
  // テンプレに「段落 5 / 空段落 / (乙) 旧ブロック」という構造があると、素直に段落 5 末尾に
  // 挿入すると「段落 5 / NEW (乙) / 空段落 / 段落 11 (生き残り)」となり、空段落が (乙) 新
  // ブロック内の真ん中に取り残される。
  //
  // 解決: 挿入直後の空段落を「セクション区切り」と解釈し、空段落をスキップした位置に
  // 挿入する。結果は「段落 5 / 空段落 / NEW (乙) / 段落 11」となり、区切りが (甲)/(乙) 間に
  // 正しく残る。
  //
  // 連続する空段落も全部スキップする (多重区切りも吸収)。
  const allParagraphs = findTopLevelParagraphs(docXml);
  const findInsertPos = (afterContentP: ParaRange): number => {
    const allIdx = allParagraphs.findIndex((ap) => ap.start === afterContentP.start);
    if (allIdx < 0) return afterContentP.end;
    let pos = afterContentP.end;
    for (let i = allIdx + 1; i < allParagraphs.length; i++) {
      const nextP = allParagraphs[i];
      const nextInner = docXml.slice(nextP.openEnd, nextP.end - "</w:p>".length);
      if (getParagraphText(nextInner).trim().length === 0) {
        pos = nextP.end;
      } else {
        break;
      }
    }
    return pos;
  };

  for (const ins of inserts) {
    if (!validIdx(ins.afterParagraphIndex)) {
      log.skipped.push({ kind: "insert", detail: `afterIndex ${ins.afterParagraphIndex}`, reason: `範囲外 (1〜${total})` });
      continue;
    }
    const p = paragraphs[ins.afterParagraphIndex - 1];
    // 同位置の delete/rewrite との干渉を避けるため、insert は p.end (= 段落末尾の直後) を sortKey にする
    // 加えて直後の空段落 (セクション区切り) はスキップする
    const insertSortKey = findInsertPos(p);
    ops.push({
      kind: "insert",
      pos: ins.afterParagraphIndex,
      sortKey: insertSortKey,
      contents: ins.contents,
      referenceXml: docXml.slice(p.start, p.end),
    });
  }

  // 後ろから順に適用 (位置が大きい op を先に処理 → 前の op の絶対位置は変わらない)
  ops.sort((a, b) => b.sortKey - a.sortKey);

  for (const op of ops) {
    if (op.kind === "delete") {
      docXml = docXml.slice(0, op.start) + docXml.slice(op.end);
      log.applied.push({ kind: "delete", detail: `段落 ${op.pos}` });
    } else if (op.kind === "rewrite") {
      const newPara = rewriteParagraphXml(op.originalXml, op.newText);
      docXml = docXml.slice(0, op.start) + newPara + docXml.slice(op.end);
      log.applied.push({ kind: "rewrite", detail: `段落 ${op.pos}` });
    } else if (op.kind === "insert") {
      const insertPos = op.sortKey;
      const newParas = op.contents
        .map((text) => makeStyledParagraphFromReference(text, op.referenceXml))
        .join("");
      docXml = docXml.slice(0, insertPos) + newParas + docXml.slice(insertPos);
      log.applied.push({ kind: "insert", detail: `段落 ${op.pos} 直後 → ${op.contents.length} 段落` });
    }
  }

  return docXml;
}

// --- 追加: 任意テキスト置換 (議案番号繰り上げ等) ---

function applyReplaces(
  docXml: string,
  replaces: ReplaceOp[],
  log: { applied: { kind: string; detail: string }[]; skipped: { kind: string; detail: string; reason: string }[] }
): string {
  for (const r of replaces) {
    if (!r.anchor) continue;
    const escAnchor = escapeXml(r.anchor);
    const escReplacement = escapeXml(r.replacement ?? "");
    let count = 0;
    docXml = docXml.replace(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g, (m, attrs, txt) => {
      if (!txt.includes(escAnchor)) return m;
      const replaced = txt.split(escAnchor).join(escReplacement);
      count += (txt.match(new RegExp(escapeRegexLocal(escAnchor), "g")) || []).length;
      const hasPreserve = /xml:space="preserve"/.test(attrs);
      const newAttrs = hasPreserve ? attrs : `${attrs} xml:space="preserve"`;
      return `<w:t${newAttrs}>${replaced}</w:t>`;
    });
    if (count > 0) log.applied.push({ kind: "replace", detail: `${r.anchor} → ${r.replacement} (${count}件)` });
    else log.skipped.push({ kind: "replace", detail: r.anchor, reason: "テキストが見つからない" });
  }
  return docXml;
}

function escapeRegexLocal(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  // 2. paragraphActions (delete/rewrite) + inserts を段落番号で一括処理
  // fillMarkers は fill 対象の ★label★ のラベル名集合。delete との競合検出に使う。
  const fillMarkers = new Set<string>();
  for (const k of Object.keys(edits.fills || {})) {
    const m = k.match(/^★(.+)★$/);
    if (m) fillMarkers.add(m[1]);
  }
  if (
    (edits.paragraphActions && edits.paragraphActions.length > 0) ||
    (edits.inserts && edits.inserts.length > 0)
  ) {
    docXml = applyIndexedOps(
      docXml,
      edits.paragraphActions || [],
      edits.inserts || [],
      fillMarkers,
      log
    );
  }

  // 3. replaces (議案番号繰り上げ等の任意テキスト置換)
  if (edits.replaces && edits.replaces.length > 0) {
    docXml = applyReplaces(docXml, edits.replaces, log);
  }

  // 4. fills (★label★ → 値)
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

  // 行を Excel の行番号 (r="N") で探す
  const findRowByNumber = (sheetXml: string, rowNum: number): { start: number; end: number } | null => {
    const re = new RegExp(`<row\\b[^>]*?r="${rowNum}"[^>]*>[\\s\\S]*?</row>`, "g");
    const m = re.exec(sheetXml);
    if (!m) return null;
    return { start: m.index, end: m.index + m[0].length };
  };

  // 全シート (xlsx は通常 1 シート用途が多いが、念のため全シート対象)。
  // 全 op を集めて絶対位置で sort して後ろから適用 (docx 同様)。
  for (const sheetFile of sheetFiles) {
    let sheetXml = zip.file(sheetFile)?.asText();
    if (!sheetXml) continue;
    let changed = false;

    type XlsxOp =
      | { kind: "delete"; rowNum: number; start: number; end: number }
      | { kind: "rewrite"; rowNum: number; start: number; end: number; newCsv: string }
      | { kind: "insert"; afterRowNum: number; pos: number; contents: string[] };

    const xlsxOps: XlsxOp[] = [];

    // paragraphActions = 行単位の delete or rewrite (xlsx では paragraphIndex = Excel 行番号)
    const seenRows = new Set<number>();
    for (const pa of edits.paragraphActions || []) {
      if (seenRows.has(pa.paragraphIndex)) {
        log.skipped.push({
          kind: pa.action + "-xlsx",
          detail: `row ${pa.paragraphIndex}`,
          reason: "同じ行に複数 action 指定。最初のみ採用",
        });
        continue;
      }
      seenRows.add(pa.paragraphIndex);
      const target = findRowByNumber(sheetXml, pa.paragraphIndex);
      if (!target) {
        log.skipped.push({ kind: pa.action + "-xlsx", detail: `row ${pa.paragraphIndex}`, reason: "行が見つからない" });
        continue;
      }
      if (pa.action === "delete") {
        xlsxOps.push({ kind: "delete", rowNum: pa.paragraphIndex, start: target.start, end: target.end });
      } else if (pa.action === "rewrite") {
        if (typeof pa.newText !== "string") {
          log.skipped.push({ kind: "rewrite-xlsx", detail: `row ${pa.paragraphIndex}`, reason: "newText が無い" });
          continue;
        }
        xlsxOps.push({
          kind: "rewrite",
          rowNum: pa.paragraphIndex,
          start: target.start,
          end: target.end,
          newCsv: pa.newText,
        });
      }
    }

    for (const ins of edits.inserts || []) {
      const target = findRowByNumber(sheetXml, ins.afterParagraphIndex);
      if (!target) {
        log.skipped.push({ kind: "insert-xlsx", detail: `after row ${ins.afterParagraphIndex}`, reason: "行が見つからない" });
        continue;
      }
      xlsxOps.push({
        kind: "insert",
        afterRowNum: ins.afterParagraphIndex,
        pos: target.end,
        contents: ins.contents,
      });
    }

    // 後ろから順に処理 (sortKey: insert は pos、delete/rewrite は start)
    type Sortable = XlsxOp & { sortKey: number };
    const sortable: Sortable[] = xlsxOps.map((op) => {
      if (op.kind === "insert") return { ...op, sortKey: op.pos };
      return { ...op, sortKey: op.start };
    });
    sortable.sort((a, b) => b.sortKey - a.sortKey);

    // 適用 + 後続行シフトを毎回計算 (位置を再取得)
    // 注意: 後ろから処理しているので「下の行のシフト」は無関係 (削除/追加箇所より下に op がない)
    for (const op of sortable) {
      if (op.kind === "delete") {
        sheetXml = sheetXml.slice(0, op.start) + sheetXml.slice(op.end);
        sheetXml = shiftRowsAfterXlsx(sheetXml, op.rowNum, -1);
        sheetXml = shiftFormulaRefs(sheetXml, op.rowNum, -1);
        log.applied.push({ kind: "delete-xlsx", detail: `row ${op.rowNum}` });
        changed = true;
      } else if (op.kind === "rewrite") {
        // セルを全部 inline string で作り直す (新規 CSV を1行に展開)
        const newRow = makeXlsxRow(op.rowNum, op.newCsv);
        sheetXml = sheetXml.slice(0, op.start) + newRow + sheetXml.slice(op.end);
        log.applied.push({ kind: "rewrite-xlsx", detail: `row ${op.rowNum}` });
        changed = true;
      } else if (op.kind === "insert") {
        const numAdded = op.contents.length;
        sheetXml = shiftRowsAfterXlsx(sheetXml, op.afterRowNum, numAdded);
        sheetXml = shiftFormulaRefs(sheetXml, op.afterRowNum, numAdded);
        const newRows = op.contents
          .map((csv, i) => makeXlsxRow(op.afterRowNum + 1 + i, csv))
          .join("");
        // shift で長さが変わったので pos を再計算
        const reTarget = findRowByNumber(sheetXml, op.afterRowNum);
        if (!reTarget) {
          log.skipped.push({ kind: "insert-xlsx", detail: `after row ${op.afterRowNum}`, reason: "shift 後の再検索に失敗" });
          continue;
        }
        sheetXml = sheetXml.slice(0, reTarget.end) + newRows + sheetXml.slice(reTarget.end);
        log.applied.push({ kind: "insert-xlsx", detail: `row ${op.afterRowNum} 後に ${numAdded} 行` });
        changed = true;
      }
    }

    if (changed) zip.file(sheetFile, sheetXml);
  }

  // 3. replaces: 任意テキスト置換 (議案番号繰り上げ等)
  if (edits.replaces && edits.replaces.length > 0) {
    const replacesAsFills: FillsOp = {};
    for (const r of edits.replaces) {
      if (r.anchor) replacesAsFills[r.anchor] = r.replacement ?? "";
    }
    const r = applyFillsTextEverywhere(zip, replacesAsFills);
    if (r.applied > 0) log.applied.push({ kind: "replace-xlsx", detail: `${r.applied} 件のテキストを置換` });
  }

  // 4. fills: 全 xml の <t>...</t> 内テキストで ★label★ → 値 (text 置換)
  if (edits.fills && Object.keys(edits.fills).length > 0) {
    const r = applyFillsTextEverywhere(zip, edits.fills);
    if (r.applied > 0) log.applied.push({ kind: "fill-xlsx", detail: `${r.applied} 件の ★label★ を置換` });
  }

  // 5. 数値セル化: shared string が純数値になっているセル (t="s") を数値セル (t なし) に変換。
  // これをしないと Excel では文字列扱いで SUM 等の数式が動かないし、セルクリックしないと
  // 数値として表示されない問題が起きる。
  {
    const ssXmlAfter = zip.file("xl/sharedStrings.xml")?.asText() || "";
    const ssTableAfter = parseSharedStrings(ssXmlAfter);
    const isNumeric = (s: string): string | null => {
      const halfWidth = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
      const cleaned = halfWidth.replace(/,/g, "").trim();
      if (!cleaned) return null;
      return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
    };
    let totalConverted = 0;
    const sheetFilesPost = Object.keys(zip.files)
      .filter((fn) => /^xl\/worksheets\/sheet\d+\.xml$/.test(fn))
      .sort();
    for (const sf of sheetFilesPost) {
      let xml = zip.file(sf)?.asText();
      if (!xml) continue;
      let changed = false;
      xml = xml.replace(
        /<c\b([^>]*)\bt="s"([^>]*)>\s*<v>(\d+)<\/v>\s*<\/c>/g,
        (m: string, pre: string, post: string, idxStr: string) => {
          const idx = parseInt(idxStr, 10);
          const text = ssTableAfter[idx];
          if (text === undefined) return m;
          const num = isNumeric(text);
          if (num === null) return m;
          totalConverted++;
          changed = true;
          // t="s" を除いた attrs で数値セルとして書き出す
          return `<c${pre}${post}><v>${num}</v></c>`;
        }
      );
      if (changed) zip.file(sf, xml);
    }
    if (totalConverted > 0) log.applied.push({ kind: "numeric-fix-xlsx", detail: `${totalConverted} セルを数値型に変換` });
  }

  const outBuf = zip.generate({ type: "nodebuffer" });
  return { buf: outBuf, applied: log.applied, skipped: log.skipped };
}

