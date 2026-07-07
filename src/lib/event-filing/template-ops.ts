// 実物テンプレの「値 → 【スロット】」置き換え ops（事由コンパイラの実行部）。
//
// 実物テンプレには前案件の実値がそのまま入っている。AI（事由コンパイラ）が
// 「どの文字列がその案件固有の値か」を判断して ops（find → replace）を出し、
// この関数がそれを機械的に適用する。Word の編集履歴で文字列が複数 run に
// 分割されていても、段落内の <w:t> を結合したテキスト上で探して置き換える。
//
// scripts/build-honten-templates.mjs と同じロジックの TS 版（API から使う）。

import PizZip from "pizzip";

export interface TemplateOp {
  find: string;        // テンプレ内の実値（段落内の連続文字列）
  replace: string;     // 置き換え先（通常は 【スロット名】。空文字 = 削除）
  all?: boolean;       // 同じ文字列を全部置換するか（省略 = 最初の1つだけ）
  // 同じ値が別の意味で複数あるときの目印。この文言を含む段落に「近い」段落から優先して
  // find を探す（同じ段落に限定しない — AI は前後の段落の文言を目印に出すことがあるため）。
  anchor?: string;
}

const unesc = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 段落分割（入れ子対応）。produce.ts の splitParagraphs と同じ。
export function splitParagraphs(xml: string): { type: "p" | "other"; text: string }[] {
  const segs: { type: "p" | "other"; text: string }[] = [];
  let i = 0;
  const openRe = /<w:p[ >/]/g;
  for (;;) {
    openRe.lastIndex = i;
    const m = openRe.exec(xml);
    if (!m) {
      if (i < xml.length) segs.push({ type: "other", text: xml.slice(i) });
      break;
    }
    if (m.index > i) segs.push({ type: "other", text: xml.slice(i, m.index) });
    const tagEnd = xml.indexOf(">", m.index);
    if (xml[tagEnd - 1] === "/") {
      segs.push({ type: "p", text: xml.slice(m.index, tagEnd + 1) });
      i = tagEnd + 1;
      continue;
    }
    let depth = 1;
    const tokRe = /<w:p[ >]|<\/w:p>/g;
    tokRe.lastIndex = tagEnd + 1;
    let end = -1;
    let t: RegExpExecArray | null;
    while ((t = tokRe.exec(xml)) !== null) {
      if (t[0] === "</w:p>") {
        depth--;
        if (depth === 0) {
          end = t.index + t[0].length;
          break;
        }
      } else {
        depth++;
      }
    }
    if (end === -1) {
      segs.push({ type: "other", text: xml.slice(m.index) });
      break;
    }
    segs.push({ type: "p", text: xml.slice(m.index, end) });
    i = end;
  }
  return segs;
}

function replaceOnceInParagraph(pXml: string, find: string, replace: string): string | null {
  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  const nodes: { tagStart: number; tagEnd: number; text: string; offset: number }[] = [];
  let combined = "";
  let m: RegExpExecArray | null;
  while ((m = tRe.exec(pXml)) !== null) {
    const dec = unesc(m[1]);
    nodes.push({ tagStart: m.index, tagEnd: m.index + m[0].length, text: dec, offset: combined.length });
    combined += dec;
  }
  const at = combined.indexOf(find);
  if (at === -1) return null;
  const span = { start: at, end: at + find.length };

  const newTexts = new Map<number, string>();
  let inserted = false;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const nStart = n.offset;
    const nEnd = n.offset + n.text.length;
    if (nEnd <= span.start || nStart >= span.end) continue;
    const before = n.text.slice(0, Math.max(0, span.start - nStart));
    const after = n.text.slice(Math.min(n.text.length, span.end - nStart));
    newTexts.set(i, before + (inserted ? "" : replace) + after);
    inserted = true;
  }
  let out = pXml;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (!newTexts.has(i)) continue;
    const n = nodes[i];
    out =
      out.slice(0, n.tagStart) +
      `<w:t xml:space="preserve">${esc(newTexts.get(i)!)}</w:t>` +
      out.slice(n.tagEnd);
  }
  return out;
}

function paraText(pXml: string): string {
  let t = "";
  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = tRe.exec(pXml)) !== null) t += unesc(m[1]);
  return t;
}

// テンプレ docx の「穴」を列挙する（木構造の可視化用）。
//   brackets: 【…】プレースホルダーの中の文言（重複除去・出現順）
//   yellow  : 黄色マーカーの文言グループ（連続する黄色 run を結合。重複除去）
export function scanTemplateHoles(buf: Buffer): { brackets: string[]; yellow: string[] } {
  const zip = new PizZip(buf);
  const xml = zip.file("word/document.xml")?.asText();
  if (!xml) return { brackets: [], yellow: [] };

  const brackets: string[] = [];
  const yellow: string[] = [];
  const seenB = new Set<string>();
  const seenY = new Set<string>();

  for (const seg of splitParagraphs(xml)) {
    if (seg.type !== "p") continue;
    // 段落内の run を順に見て、テキスト結合と黄色グループを同時に作る
    let combined = "";
    let curYellow = "";
    const runRe = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
    let rm: RegExpExecArray | null;
    const flushYellow = () => {
      const t = curYellow.trim();
      if (t && !seenY.has(t)) {
        seenY.add(t);
        yellow.push(t);
      }
      curYellow = "";
    };
    while ((rm = runRe.exec(seg.text)) !== null) {
      const run = rm[0];
      let text = "";
      const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
      let tm: RegExpExecArray | null;
      while ((tm = tRe.exec(run)) !== null) text += unesc(tm[1]);
      combined += text;
      if (/<w:highlight\s+w:val="yellow"/.test(run)) {
        curYellow += text;
      } else if (text !== "") {
        // テキストを持つ非黄色 run が来たら黄色グループはそこで途切れる
        // （テキストなしの run = 書式だけ・ブックマーク等はグループを切らない）
        flushYellow();
      }
    }
    flushYellow();

    const phRe = /【([^【】]{1,40})】/g;
    let pm: RegExpExecArray | null;
    while ((pm = phRe.exec(combined)) !== null) {
      const inner = pm[1].trim();
      if (inner && !seenB.has(inner)) {
        seenB.add(inner);
        brackets.push(inner);
      }
    }
  }
  return { brackets, yellow };
}

// docx Buffer に ops を適用。各 op の置換件数も返す（0 件 = find が見つからなかった要警告）。
export function applyTemplateOps(
  buf: Buffer,
  ops: TemplateOp[]
): { buf: Buffer; counts: number[] } {
  const zip = new PizZip(buf);
  const xml = zip.file("word/document.xml")?.asText();
  if (!xml) return { buf, counts: ops.map(() => 0) };

  const counts = ops.map(() => 0);
  const segments = splitParagraphs(xml);

  const pIdxs = segments
    .map((s, i) => (s.type === "p" ? i : -1))
    .filter((i) => i >= 0);

  ops.forEach((op, oi) => {
    if (!op?.find) return;
    // anchor があれば「anchor を含む段落に近い順」に探す（同じ段落 → 前後の段落 → …）。
    // anchor が見つからなければ通常の先頭からの順で探す。
    let order = pIdxs;
    if (op.anchor) {
      const aIdx = pIdxs.find((i) => paraText(segments[i].text).includes(op.anchor!));
      if (aIdx !== undefined) {
        order = [...pIdxs].sort((a, b) => Math.abs(a - aIdx) - Math.abs(b - aIdx));
      }
    }
    for (const i of order) {
      const seg = segments[i];
      for (;;) {
        const next = replaceOnceInParagraph(seg.text, op.find, op.replace ?? "");
        if (next === null) break;
        seg.text = next;
        counts[oi]++;
        if (!op.all) break;
      }
      if (counts[oi] > 0 && !op.all) break;
    }
  });

  zip.file("word/document.xml", segments.map((s) => s.text).join(""));
  return { buf: zip.generate({ type: "nodebuffer" }), counts };
}
