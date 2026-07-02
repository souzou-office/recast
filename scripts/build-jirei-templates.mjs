// 事由テンプレの初期生成スクリプト。
//   node scripts/build-jirei-templates.mjs
//
// data/jirei-templates/ に「目的変更」の部品テンプレ 2 枚を生成する:
//   - 株主総会議事録_目的変更.docx : 固定文 + 黄色ハイライトの穴（既存 docx-marker-parser がそのまま読める）
//   - 株主リスト.xlsx              : 黄色データ行(株主ごとに展開) + 《ラベル》プレースホルダー
//
// ★これは「初期ドラフト」。実運用では司法書士が Word/Excel でこのファイルを直接開いて
//   文言・レイアウトを直せる（黄色マーカー = 穴、という規約さえ守れば穴埋めエンジンはそのまま動く）。

import PizZip from "pizzip";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";

const OUT_DIR = path.join(process.cwd(), "data", "jirei-templates");
mkdirSync(OUT_DIR, { recursive: true });

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ============================================================
// docx: 株主総会議事録（目的変更）
// ============================================================

// run: 黄色ハイライト(=穴) か通常か。sz は half-point (21 = 10.5pt)
function run(text, { hl = false, sz = 21, bold = false } = {}) {
  const props = [
    `<w:rFonts w:ascii="ＭＳ 明朝" w:eastAsia="ＭＳ 明朝" w:hAnsi="ＭＳ 明朝"/>`,
    bold ? `<w:b/>` : "",
    `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`,
    hl ? `<w:highlight w:val="yellow"/>` : "",
  ].join("");
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

// para: runs の配列（文字列は通常 run に変換）。align: "center" | "left" | "right"
function para(parts, { align = "left", sz = 21, bold = false } = {}) {
  const runs = parts
    .map((p) => (typeof p === "string" ? run(p, { sz, bold }) : run(p.t, { hl: !!p.hl, sz, bold })))
    .join("");
  const jc = align !== "left" ? `<w:jc w:val="${align}"/>` : "";
  return `<w:p><w:pPr>${jc}</w:pPr>${runs}</w:p>`;
}

const HL = (t) => ({ t, hl: true }); // 黄色マーカー(穴)

const docParas = [
  para(["臨時株主総会議事録"], { align: "center", sz: 28, bold: true }),
  para([""]),
  para(["一、開催日時　", HL("開催日"), "　午前１０時００分"]),
  para(["一、開催場所　当会社本店（", HL("本店所在地"), "）"]),
  para(["一、出席状況"]),
  para(["　　　株主の総数　　　　　　　　　　　　　　　　　　", HL("株主総数"), "名"]),
  para(["　　　発行済株式の総数　　　　　　　　　　　　　　　", HL("発行済株式総数")]),
  para(["　　　議決権を行使することができる株主の数　　　　　", HL("議決権株主数"), "名"]),
  para(["　　　議決権を行使することができる株主の議決権の数　", HL("総議決権数"), "個"]),
  para(["　　　出席株主の数（委任状による者を含む）　　　　　", HL("出席株主数"), "名"]),
  para(["　　　出席株主の議決権の数　　　　　　　　　　　　　", HL("出席議決権数"), "個"]),
  para([""]),
  para(["　定刻、代表取締役", HL("議長氏名"), "は議長席に着き、開会を宣した。議長は、本総会は上記のとおり定足数に足る株主の出席があり適法に成立した旨を述べ、直ちに議事に入った。"]),
  para([""]),
  para(["第１号議案　定款一部変更（事業目的の変更）の件"], { bold: true }),
  para(["　議長は、当会社の定款に定める事業目的を下記のとおり変更したい旨およびその理由を詳細に説明し、その賛否を議場に諮ったところ、出席株主の議決権の３分の２以上の賛成をもって、原案どおり可決確定した。"]),
  para([""]),
  para(["（変更前）"]),
  para([HL("変更前の目的")]),
  para([""]),
  para(["（変更後）"]),
  para([HL("変更後の目的")]),
  para([""]),
  para(["　以上をもって本日の議事を終了したので、議長は閉会を宣した。"]),
  para(["　上記の決議を明確にするため、この議事録を作成し、議長がこれに記名押印する。"]),
  para([""]),
  para([HL("作成日")]),
  para([""]),
  para([HL("会社名"), "　臨時株主総会"], { align: "right" }),
  para(["議長・議事録作成者　代表取締役　", HL("議長氏名"), "　　　　㊞"], { align: "right" }),
];

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${docParas.join("\n")}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="ＭＳ 明朝" w:eastAsia="ＭＳ 明朝" w:hAnsi="ＭＳ 明朝"/>
<w:sz w:val="21"/><w:szCs w:val="21"/>
</w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>
</w:styles>`;

function buildDocx() {
  const zip = new PizZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
  );
  zip.file("word/document.xml", documentXml);
  zip.file("word/styles.xml", stylesXml);
  return zip.generate({ type: "nodebuffer" });
}

// ============================================================
// xlsx: 株主リスト
// ============================================================
// 規約:
//   - 黄色セル(データ行) = 株主ごとに複製される行。セルの文言は jirei.json の rowSlots のキー
//   - 《ラベル》 = 単発の穴（スタイル不問・文言全文一致で置換）。セルは《…》だけを含むこと
//     (固定文と混ぜると全文一致で外れる。固定文は隣のセルに分ける)

const sharedList = []; // sharedStrings (重複排除)
const ssIndex = new Map();
function ss(text) {
  if (ssIndex.has(text)) return ssIndex.get(text);
  const idx = sharedList.length;
  sharedList.push(text);
  ssIndex.set(text, idx);
  return idx;
}
// cell: s=style index
function cell(ref, text, s = 0) {
  if (text === null) return "";
  return `<c r="${ref}" s="${s}" t="s"><v>${ss(text)}</v></c>`;
}
function rowXml(r, cells) {
  return `<row r="${r}">${cells.join("")}</row>`;
}

// styles: 0=default 1=罫線 2=黄色+罫線 3=太字(タイトル)
const xlsxStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><name val="ＭＳ Ｐゴシック"/></font>
<font><b/><sz val="14"/><name val="ＭＳ Ｐゴシック"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

function buildXlsx() {
  const rows = [
    rowXml(1, [cell("A1", "株主リスト", 3)]),
    rowXml(3, [cell("A3", "商号", 1), cell("B3", "《会社名》", 1)]),
    rowXml(5, [
      cell("A5", "氏名又は名称", 1),
      cell("B5", "住所", 1),
      cell("C5", "株式数（株）", 1),
      cell("D5", "議決権数（個）", 1),
      cell("E5", "議決権数の割合", 1),
    ]),
    // ↓ 黄色データ行（株主ごとに複製される）。文言 = rowSlots のキー
    rowXml(6, [
      cell("A6", "株主氏名", 2),
      cell("B6", "株主住所", 2),
      cell("C6", "株主株式数", 2),
      cell("D6", "株主議決権数", 2),
      cell("E6", "株主議決権割合", 2),
    ]),
    rowXml(7, [
      cell("A7", "合計", 1),
      cell("B7", "", 1),
      cell("C7", "《合計株式数》", 1),
      cell("D7", "《合計議決権数》", 1),
      cell("E7", "《合計議決権割合》", 1),
    ]),
    rowXml(9, [cell("A9", "上記のとおり相違ないことを証明する。")]),
    rowXml(10, [cell("A10", "《証明日付》")]),
    rowXml(11, [cell("A11", "《会社名》")]),
    rowXml(12, [cell("A12", "代表取締役"), cell("B12", "《代表取締役氏名》")]),
  ];

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="40" customWidth="1"/><col min="3" max="5" width="16" customWidth="1"/></cols>
<sheetData>
${rows.join("\n")}
</sheetData>
</worksheet>`;

  const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedList.length}" uniqueCount="${sharedList.length}">
${sharedList.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join("\n")}
</sst>`;

  const zip = new PizZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="株主リスト" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`
  );
  zip.file("xl/worksheets/sheet1.xml", sheetXml);
  zip.file("xl/styles.xml", xlsxStyles);
  zip.file("xl/sharedStrings.xml", ssXml);
  return zip.generate({ type: "nodebuffer" });
}

const docxBuf = buildDocx();
const xlsxBuf = buildXlsx();
writeFileSync(path.join(OUT_DIR, "株主総会議事録_目的変更.docx"), docxBuf);
writeFileSync(path.join(OUT_DIR, "株主リスト.xlsx"), xlsxBuf);
console.log(`✓ ${OUT_DIR}/株主総会議事録_目的変更.docx (${docxBuf.length} bytes)`);
console.log(`✓ ${OUT_DIR}/株主リスト.xlsx (${xlsxBuf.length} bytes)`);
