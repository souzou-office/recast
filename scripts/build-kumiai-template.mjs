// 組合用の提案書兼同意書テンプレを、法人用から機械生成する。
//   node scripts/build-kumiai-template.mjs
//
// 統一ルール④: 組合（投資事業有限責任組合）が株主の場合、同意欄は
//   主たる事務所 / 名称 / 無限責任組合員 / 組合員 / 代表取締役
// の構成になる。法人用テンプレの同意欄の行ラベルを置き換え、値の穴を
// 【組合…】系に差し替えたコピーを作る（本文・書式は法人用のまま）。
// 値は data/jirei/special-parties.json（ルール④のデータ化）から流し込まれる。
//
// 行の追加は「\n 入り置換」で表現する（produce の fixDocxLineBreaks が
// 生成時に <w:br/> へ変換するので、Word 上では別行に見える）。

import PizZip from "pizzip";
import { readFileSync, writeFileSync } from "fs";

const SRC = "data/jirei-templates/提案書兼同意書_法人_取締役就任.docx";
const OUT = "data/jirei-templates/提案書兼同意書_組合_取締役就任.docx";

const OPS = [
  { find: "本　　　　店　【株主本店】", replace: "主たる事務所　【組合主たる事務所】" },
  {
    find: "商　　　　号　【株主商号】",
    replace: "名　　　　称　【組合名称】\n無限責任組合員　【無限責任組合員】\n組　合　員　【組合員】",
  },
  { find: "【法人株主代表取締役】", replace: "【組合代表取締役】" },
];

const unesc = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function splitParagraphs(xml) {
  const segs = [];
  let i = 0;
  const openRe = /<w:p[ >/]/g;
  for (;;) {
    openRe.lastIndex = i;
    const m = openRe.exec(xml);
    if (!m) { if (i < xml.length) segs.push({ type: "other", text: xml.slice(i) }); break; }
    if (m.index > i) segs.push({ type: "other", text: xml.slice(i, m.index) });
    const tagEnd = xml.indexOf(">", m.index);
    if (xml[tagEnd - 1] === "/") { segs.push({ type: "p", text: xml.slice(m.index, tagEnd + 1) }); i = tagEnd + 1; continue; }
    let depth = 1;
    const tokRe = /<w:p[ >]|<\/w:p>/g;
    tokRe.lastIndex = tagEnd + 1;
    let end = -1, t;
    while ((t = tokRe.exec(xml)) !== null) {
      if (t[0] === "</w:p>") { depth--; if (depth === 0) { end = t.index + t[0].length; break; } }
      else depth++;
    }
    if (end === -1) { segs.push({ type: "other", text: xml.slice(m.index) }); break; }
    segs.push({ type: "p", text: xml.slice(m.index, end) });
    i = end;
  }
  return segs;
}

function replaceOnce(pXml, find, replace) {
  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  const nodes = [];
  let combined = "", m;
  while ((m = tRe.exec(pXml)) !== null) {
    const dec = unesc(m[1]);
    nodes.push({ tagStart: m.index, tagEnd: m.index + m[0].length, text: dec, offset: combined.length });
    combined += dec;
  }
  const findNorm = find.replace(/[\t\r]/g, "");
  const at = combined.indexOf(findNorm);
  if (at === -1) return null;
  const span = { start: at, end: at + findNorm.length };
  const newTexts = new Map();
  let inserted = false;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const nStart = n.offset, nEnd = n.offset + n.text.length;
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
    out = out.slice(0, n.tagStart) + `<w:t xml:space="preserve">${esc(newTexts.get(i))}</w:t>` + out.slice(n.tagEnd);
  }
  return out;
}

const zip = new PizZip(readFileSync(SRC));
const xml = zip.file("word/document.xml").asText();
const segs = splitParagraphs(xml);
for (const op of OPS) {
  let done = false;
  for (const seg of segs) {
    if (seg.type !== "p") continue;
    const next = replaceOnce(seg.text, op.find, op.replace);
    if (next !== null) {
      seg.text = next;
      done = true;
      break;
    }
  }
  console.log(`${done ? "✓" : "★0件★"} ${op.find.slice(0, 20)}`);
}
zip.file("word/document.xml", segs.map((s) => s.text).join(""));
writeFileSync(OUT, zip.generate({ type: "nodebuffer" }));
console.log("→ " + OUT);
