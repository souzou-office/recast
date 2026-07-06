// 本店移転: 事務所の実物テンプレ（前案件 Polaris.AI の値が入ったまま）から、
// 値の部分だけを 【…】 プレースホルダーに置き換えたコピーを生成する。
//   node scripts/build-honten-templates.mjs
//
// 文言・レイアウト・書式は実物のまま（document.xml の該当文字列だけ置換）。
// Word の編集履歴で文字列が複数 run に分割されていても、段落内の <w:t> を
// 結合したテキスト上で探して位置ベースで書き換える（produce.ts と同じ手法）。
//
// 出力: data/jirei-templates/
//   取締役決定書_本店移転.docx / 提案書兼同意書_本店移転.docx /
//   株主総会議事録_本店移転.docx / 委任状_本店移転.docx

import PizZip from "pizzip";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

const SRC_DIR =
  "H:\\共有ドライブ\\司法書士法人そうぞう共有フォルダ\\テンプレート\\本店移転(管轄内）";
const OUT_DIR = path.join(process.cwd(), "data", "jirei-templates");
mkdirSync(OUT_DIR, { recursive: true });

const unesc = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 段落 XML 内で find を 1 回置換（run 分割対応）。置換できたら新 XML、無ければ null。
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
    out =
      out.slice(0, n.tagStart) +
      `<w:t xml:space="preserve">${esc(newTexts.get(i))}</w:t>` +
      out.slice(n.tagEnd);
  }
  return out;
}

// 段落分割（入れ子対応）。テキストボックス (w:pict > w:txbxContent) の中に別の <w:p> が
// 入っていることがあるので、開き/閉じの深さを数えて外側の段落を丸ごと 1 セグメントにする。
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
    // 自己終了 <w:p/> or <w:p .../>
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

// document.xml 全体に ops を適用。各 op の置換件数を返す。
//   op: { find, replace, all?: boolean, anchor?: string }
//   anchor があれば「combined テキストに anchor を含む段落」の中だけ探す。
function applyOps(xml, ops) {
  const counts = ops.map(() => 0);
  const segments = splitParagraphs(xml);

  const paraText = (pXml) => {
    let t = "";
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = tRe.exec(pXml)) !== null) t += unesc(m[1]);
    return t;
  };

  ops.forEach((op, oi) => {
    for (const seg of segments) {
      if (seg.type !== "p") continue;
      if (op.anchor && !paraText(seg.text).includes(op.anchor)) continue;
      for (;;) {
        const next = replaceOnceInParagraph(seg.text, op.find, op.replace);
        if (next === null) break;
        seg.text = next;
        counts[oi]++;
        if (!op.all) break;
      }
      if (counts[oi] > 0 && !op.all) break; // 1回だけの op は最初の段落で終了
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
    const mark = counts[i] > 0 ? " " : "★0件★";
    console.log(`   ${mark} [${counts[i]}] ${op.find.slice(0, 24)} → ${op.replace || "(削除)"}`);
  });
}

// ============================================================
// 置換定義（実物の値 → 【スロット名】）
// ============================================================

convert("1.取締役決定書（株会提案）.docx", "取締役決定書_本店移転.docx", [
  { find: "令和８年１月１５日", replace: "【決定日】", all: true },
  { anchor: "取締役総数", find: "１名", replace: "【取締役総数】名" },
  { anchor: "取締役総数", find: "１名", replace: "【出席取締役数】名" },
  { find: "東京都港区虎ノ門二丁目２番１号", replace: "【移転先本店】" },
  { find: "住友不動産虎ノ門タワー１３階", replace: "" },
  { find: "令和８年３月２日", replace: "【移転年月日】" },
  { find: "令和８年１月２６日", replace: "【みなし決議日】", all: true },
  { find: "Ｐｏｌａｒｉｓ．ＡＩ株式会社", replace: "【会社名】", all: true },
  { find: "德永優也", replace: "【代表取締役氏名】", all: true },
]);

convert("2-1.臨時株主総会　提案書兼同意書_徳永.docx", "提案書兼同意書_本店移転.docx", [
  { find: "令和８年１月１６日", replace: "【提案日】" },
  { find: "東京都文京区本郷六丁目２５番１４号", replace: "【本店所在地】" },
  { find: "Ｐｏｌａｒｉｓ．ＡＩ株式会社", replace: "【会社名】", all: true },
  { find: "德永優也", replace: "【代表取締役氏名】", all: true },
  { find: "東京都港区虎ノ門二丁目２番１号", replace: "【移転先本店】" },
  { find: "住友不動産虎ノ門タワー１３階", replace: "" },
  { find: "令和８年３月２日", replace: "【移転年月日】" },
  { find: "令和８年１月２６日", replace: "【みなし決議日】", all: true },
  { find: "令和８年１月２３日", replace: "【同意日】" },
  { find: "東京都板橋区徳丸四丁目１９番３―６０３号", replace: "【株主住所】" },
  { find: "プリズムヒル", replace: "" },
  { find: "徳永優也", replace: "【株主氏名】" },
  { find: "２４，７５６個", replace: "【株主議決権数】個" },
]);

convert("3.株主総会議事録（書面決議）.docx", "株主総会議事録_本店移転.docx", [
  { anchor: "株主の数", find: "９名", replace: "【議決権株主数】名" },
  { find: "３１，５７８個", replace: "【総議決権数】個" },
  { find: "東京都港区虎ノ門二丁目２番１号", replace: "【移転先本店】" },
  { find: "住友不動産虎ノ門タワー１３階", replace: "" },
  { find: "令和８年３月２日", replace: "【移転年月日】" },
  { find: "令和８年１月２６日", replace: "【みなし決議日】", all: true },
  { find: "令和８年１月１６日", replace: "【提案日】" },
  { find: "Ｐｏｌａｒｉｓ．ＡＩ株式会社", replace: "【会社名】", all: true },
  { find: "德永優也", replace: "【代表取締役氏名】", all: true },
]);

convert("5.登記委任状.docx", "委任状_本店移転.docx", [
  { find: "令和８年３月２日", replace: "【申請日】" },
  { find: "東京都港区虎ノ門二丁目２番１号", replace: "【移転先本店】" },
  { find: "住友不動産虎ノ門タワー１３階", replace: "" },
  { find: "Ｐｏｌａｒｉｓ．ＡＩ株式会社", replace: "【会社名】" },
  { find: "德永優也", replace: "【代表取締役氏名】" },
]);
