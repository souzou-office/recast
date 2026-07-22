// 本店移転（管轄外）: 印鑑カード交付申請書の実物（前案件 Polaris.AI の値入り）から、
// 値の部分だけを 【…】 に置き換えたテンプレを生成する。
//   node scripts/build-kankatsugai-templates.mjs
//
// 文言・レイアウト・書式（グリッド様式）は実物のまま。
// op の種類:
//   { find, replace, all?, anchor? } … 段落内の部分置換（build-honten と同じ）
//   { exact, replace }               … 段落テキスト全体（trim）が exact と一致する段落だけ置換
//                                      （"8" のような裸の数字セルを電話番号等と誤マッチさせない）
//   { whole, replace }               … whole を含む段落のテキストを丸ごと replace に置換
//                                      （全角ハイフン等、文字種の打ち間違いを避ける）
//
// 委任状（5.登記委任状.docx）は管轄内と同文であることを確認済み → 変換しない（既存を共用）。

import PizZip from "pizzip";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

const SRC_DIR =
  "H:\\共有ドライブ\\司法書士法人そうぞう共有フォルダ\\テンプレート\\本店移転(管轄外）";
const OUT_DIR = path.join(process.cwd(), "data", "jirei-templates");
mkdirSync(OUT_DIR, { recursive: true });

const unesc = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function replaceOnceInParagraph(pXml, find, replace) {
  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  const nodes = [];
  let combined = "";
  let m;
  while ((m = tRe.exec(pXml)) !== null) {
    const dec = unesc(m[1]);
    nodes.push({ tagStart: m.index, tagEnd: m.index + m[0].length, text: dec, offset: combined.length });
    combined += dec;
  }
  const at = combined.indexOf(find);
  if (at === -1) return null;
  const span = { start: at, end: at + find.length };
  const newTexts = new Map();
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
    out = out.slice(0, n.tagStart) + `<w:t xml:space="preserve">${esc(newTexts.get(i))}</w:t>` + out.slice(n.tagEnd);
  }
  return out;
}

function splitParagraphs(xml) {
  const segs = [];
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
    let t;
    while ((t = tokRe.exec(xml)) !== null) {
      if (t[0] === "</w:p>") {
        depth--;
        if (depth === 0) {
          end = t.index + t[0].length;
          break;
        }
      } else depth++;
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

const paraText = (pXml) => {
  let t = "";
  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = tRe.exec(pXml)) !== null) t += unesc(m[1]);
  return t;
};

function applyOps(xml, ops) {
  const counts = ops.map(() => 0);
  const segments = splitParagraphs(xml);
  ops.forEach((op, oi) => {
    for (const seg of segments) {
      if (seg.type !== "p") continue;
      const pt = paraText(seg.text);
      if (op.anchor && !pt.includes(op.anchor)) continue;
      if (op.exact !== undefined && pt.trim() !== op.exact) continue;
      if (op.whole !== undefined && !pt.includes(op.whole)) continue;

      const find = op.exact !== undefined ? op.exact : op.whole !== undefined ? pt : op.find;
      for (;;) {
        const next = replaceOnceInParagraph(seg.text, find, op.replace);
        if (next === null) break;
        seg.text = next;
        counts[oi]++;
        if (!op.all) break;
      }
      if (counts[oi] > 0 && !op.all) break;
    }
  });
  return { xml: segments.map((s) => s.text).join(""), counts };
}

function convert(srcFile, outFile, ops) {
  const buf = readFileSync(path.join(SRC_DIR, srcFile));
  const zip = new PizZip(buf);
  const xml = zip.file("word/document.xml").asText();
  const { xml: newXml, counts } = applyOps(xml, ops);
  zip.file("word/document.xml", newXml);
  writeFileSync(path.join(OUT_DIR, outFile), zip.generate({ type: "nodebuffer" }));
  console.log(`✓ ${outFile}`);
  ops.forEach((op, i) => {
    const label = op.find ?? op.exact ?? op.whole;
    const mark = counts[i] > 0 ? " " : "★0件★";
    console.log(`   ${mark} [${counts[i]}] ${String(label).slice(0, 24)} → ${op.replace || "(削除)"}`);
  });
}

// ============================================================
// 印鑑カード交付申請書（乙号様式・グリッド）
// ============================================================
convert("6.印鑑カード交付申請書.docx", "印鑑カード交付申請書_本店移転.docx", [
  // 新管轄（印鑑カードは移転後の法務局に出す）
  { find: "東京法務局", replace: "【管轄法務局名】" },
  { anchor: "支局・出張所", find: "港", replace: "【管轄支局名】" },
  // 会社
  { find: "Ｐｏｌａｒｉｓ．ＡＩ株式会社", replace: "【会社名】", all: true },
  { whole: "２３５６９３", replace: "【会社法人等番号】" },
  // 本店（移転後）
  { find: "東京都港区虎ノ門二丁目２番１号", replace: "【移転先本店】" },
  { find: "住友不動産虎ノ門タワー１３階", replace: "" },
  // 印鑑提出者（代表取締役）
  { find: "德永優也", replace: "【代表取締役氏名】", all: true },
  { whole: "徳丸四丁目", replace: "【代表取締役住所】" },
  // 生年月日（セルが分かれているので1セル=1穴。値は質問1つから lineField で分配）
  { exact: "平成", replace: "【生年元号】" },
  { exact: "10", replace: "【生年】" },
  { exact: "11", replace: "【生月】" },
  { exact: "13", replace: "【生日】" },
  // 印鑑カード委任状の日付（令和は固定文言のまま）
  { exact: "8", replace: "【印鑑委任年】" },
  { exact: "3", replace: "【印鑑委任月】" },
  { exact: "3", replace: "【印鑑委任日】" },
]);
