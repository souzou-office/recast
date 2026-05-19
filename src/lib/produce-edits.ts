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
