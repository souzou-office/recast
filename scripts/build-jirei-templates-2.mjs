// 事由テンプレの追加生成スクリプト（第2弾）。
//   node scripts/build-jirei-templates-2.mjs
//
// data/jirei-templates/ に以下を生成する:
//   【目的変更の一式化】
//   - 変更登記申請書_目的変更.docx
//   - 委任状.docx（登記の事由スロット入り。目的変更/役員変更で共用）
//   【役員変更（就任・辞任・重任）】
//   - 株主総会議事録_役員選任.docx
//   - 株主総会議事録_役員重任.docx
//   - 就任承諾書.docx
//   - 辞任届.docx
//   - 変更登記申請書_役員就任.docx
//   - 変更登記申請書_役員辞任.docx
//   - 変更登記申請書_役員重任.docx
//
// ★これは「初期ドラフト」。実運用では司法書士が Word でこのファイルを直接開いて
//   文言・レイアウト・代理人欄・登録免許税額を直せる（黄色マーカー = 穴、の規約だけ守る）。

import PizZip from "pizzip";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";

const OUT_DIR = path.join(process.cwd(), "data", "jirei-templates");
mkdirSync(OUT_DIR, { recursive: true });

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function run(text, { hl = false, sz = 21, bold = false } = {}) {
  const props = [
    `<w:rFonts w:ascii="ＭＳ 明朝" w:eastAsia="ＭＳ 明朝" w:hAnsi="ＭＳ 明朝"/>`,
    bold ? `<w:b/>` : "",
    `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`,
    hl ? `<w:highlight w:val="yellow"/>` : "",
  ].join("");
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(parts, { align = "left", sz = 21, bold = false } = {}) {
  const runs = parts
    .map((p) => (typeof p === "string" ? run(p, { sz, bold }) : run(p.t, { hl: !!p.hl, sz, bold })))
    .join("");
  const jc = align !== "left" ? `<w:jc w:val="${align}"/>` : "";
  return `<w:p><w:pPr>${jc}</w:pPr>${runs}</w:p>`;
}

const HL = (t) => ({ t, hl: true });
const BLANK = para([""]);

function buildDocx(paras) {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${paras.join("\n")}
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
// 変更登記申請書（共通ヘッダ + 事由別の中身）
// ============================================================

function shinseishoParas({ jiyuu, tokiJikou, zeigaku, tempu }) {
  return [
    para(["株式会社変更登記申請書"], { align: "center", sz: 28, bold: true }),
    BLANK,
    para(["１．会社法人等番号　", HL("会社法人等番号")]),
    para(["１．商　　号　　　　", HL("会社名")]),
    para(["１．本　　店　　　　", HL("本店所在地")]),
    para(["１．登記の事由　　　", jiyuu]),
    ...tokiJikou,
    para(["１．登録免許税　　　", zeigaku]),
    para(["１．添付書類"]),
    ...tempu.map(([name, count]) =>
      para([`　　　　　　　　　　${name}`, `　${count}`])
    ),
    BLANK,
    para(["　上記のとおり、登記の申請をします。"]),
    BLANK,
    para([HL("申請日")]),
    BLANK,
    para(["　　　　　　　　申請人　本　店　", HL("本店所在地")]),
    para(["　　　　　　　　　　　　商　号　", HL("会社名")]),
    para(["　　　　　　　　　　　　代表取締役　", HL("代表取締役氏名")]),
    para(["　　　　　　　　代理人　（住所・氏名は事務所の様式に合わせて記入してください）"]),
    BLANK,
    para([HL("管轄法務局"), "　御中"]),
  ];
}

const shinseishoMokuteki = shinseishoParas({
  jiyuu: "目的変更",
  tokiJikou: [
    para(["１．登記すべき事項　「目的」"]),
    para([HL("変更後の目的")]),
  ],
  zeigaku: "金３万円",
  tempu: [
    ["株主総会議事録", "１通"],
    ["株主リスト", "１通"],
    ["委任状", "１通"],
  ],
});

const shinseishoShunin = shinseishoParas({
  jiyuu: "取締役の変更",
  tokiJikou: [
    para(["１．登記すべき事項"]),
    para(["　　", HL("開催日"), "　取締役　", HL("対象取締役氏名"), "　就任"]),
  ],
  zeigaku: "金１万円（資本金の額が１億円を超える会社は金３万円）",
  tempu: [
    ["株主総会議事録", "１通"],
    ["株主リスト", "１通"],
    ["就任承諾書", "１通"],
    ["本人確認証明書", "１通"],
    ["委任状", "１通"],
  ],
});

const shinseishoJinin = shinseishoParas({
  jiyuu: "取締役の変更",
  tokiJikou: [
    para(["１．登記すべき事項"]),
    para(["　　", HL("辞任日"), "　取締役　", HL("対象取締役氏名"), "　辞任"]),
  ],
  zeigaku: "金１万円（資本金の額が１億円を超える会社は金３万円）",
  tempu: [
    ["辞任届", "１通"],
    ["委任状", "１通"],
  ],
});

const shinseishoJuunin = shinseishoParas({
  jiyuu: "取締役の変更",
  tokiJikou: [
    para(["１．登記すべき事項"]),
    para(["　　", HL("開催日"), "　取締役　", HL("対象取締役氏名"), "　重任"]),
  ],
  zeigaku: "金１万円（資本金の額が１億円を超える会社は金３万円）",
  tempu: [
    ["株主総会議事録", "１通"],
    ["株主リスト", "１通"],
    ["就任承諾書", "１通"],
    ["委任状", "１通"],
  ],
});

// ============================================================
// 委任状（登記の事由スロット入り。全事由で共用）
// ============================================================

const ininjoParas = [
  para(["委　任　状"], { align: "center", sz: 28, bold: true }),
  BLANK,
  para(["（代理人）"]),
  para(["　住所・氏名は事務所の情報をこのテンプレートに直接記入してください"]),
  BLANK,
  para(["　私は、上記の者を代理人と定め、次の権限を委任します。"]),
  BLANK,
  para(["１．当会社の", HL("登記の事由"), "の登記の申請に関する一切の件"]),
  para(["１．原本還付の請求及び受領に関する件"]),
  para(["１．登記申請の取下げ又は補正に関する件"]),
  BLANK,
  para([HL("申請日")]),
  BLANK,
  para(["本　店　", HL("本店所在地")], { align: "right" }),
  para(["商　号　", HL("会社名")], { align: "right" }),
  para(["代表取締役　", HL("代表取締役氏名"), "　　　　㊞"], { align: "right" }),
];

// ============================================================
// 株主総会議事録（役員選任 / 役員重任）— 出席状況ブロック共通
// ============================================================

function gijirokuParas(gianParas) {
  return [
    para(["臨時株主総会議事録"], { align: "center", sz: 28, bold: true }),
    BLANK,
    para(["一、開催日時　", HL("開催日"), "　午前１０時００分"]),
    para(["一、開催場所　当会社本店（", HL("本店所在地"), "）"]),
    para(["一、出席状況"]),
    para(["　　　株主の総数　　　　　　　　　　　　　　　　　　", HL("株主総数"), "名"]),
    para(["　　　発行済株式の総数　　　　　　　　　　　　　　　", HL("発行済株式総数")]),
    para(["　　　議決権を行使することができる株主の数　　　　　", HL("議決権株主数"), "名"]),
    para(["　　　議決権を行使することができる株主の議決権の数　", HL("総議決権数"), "個"]),
    para(["　　　出席株主の数（委任状による者を含む）　　　　　", HL("出席株主数"), "名"]),
    para(["　　　出席株主の議決権の数　　　　　　　　　　　　　", HL("出席議決権数"), "個"]),
    BLANK,
    para(["　定刻、代表取締役", HL("議長氏名"), "は議長席に着き、開会を宣した。議長は、本総会は上記のとおり定足数に足る株主の出席があり適法に成立した旨を述べ、直ちに議事に入った。"]),
    BLANK,
    ...gianParas,
    BLANK,
    para(["　以上をもって本日の議事を終了したので、議長は閉会を宣した。"]),
    para(["　上記の決議を明確にするため、この議事録を作成し、議長がこれに記名押印する。"]),
    BLANK,
    para([HL("作成日")]),
    BLANK,
    para([HL("会社名"), "　臨時株主総会"], { align: "right" }),
    para(["議長・議事録作成者　代表取締役　", HL("議長氏名"), "　　　　㊞"], { align: "right" }),
  ];
}

const gijirokuSennin = gijirokuParas([
  para(["第１号議案　取締役選任の件"], { bold: true }),
  para(["　議長は、取締役として下記の者を選任したい旨およびその理由を説明し、その賛否を議場に諮ったところ、出席株主の議決権の過半数の賛成をもって、原案どおり可決確定した。なお、被選任者は席上でその就任を承諾した。"]),
  BLANK,
  para(["記"], { align: "center" }),
  BLANK,
  para(["　　　取締役　", HL("対象取締役氏名")]),
]);

const gijirokuJuunin = gijirokuParas([
  para(["第１号議案　取締役重任の件"], { bold: true }),
  para(["　議長は、取締役", HL("対象取締役氏名"), "が本総会終結の時をもって任期満了により退任することとなるため、同人を再び取締役に選任したい旨を述べ、その賛否を議場に諮ったところ、出席株主の議決権の過半数の賛成をもって、原案どおり可決確定した。なお、被選任者は席上でその就任を承諾した。"]),
]);

// ============================================================
// 就任承諾書 / 辞任届
// ============================================================

const shuninShodakuParas = [
  para(["就任承諾書"], { align: "center", sz: 28, bold: true }),
  BLANK,
  para(["　私は、", HL("開催日"), "開催の貴社臨時株主総会において取締役に選任されましたので、その就任を承諾します。"]),
  BLANK,
  para([HL("開催日")]),
  BLANK,
  para(["住　所　", HL("就任者住所")], { align: "right" }),
  para(["氏　名　", HL("対象取締役氏名"), "　　　　㊞"], { align: "right" }),
  BLANK,
  para([HL("会社名"), "　御中"]),
];

const jininTodokeParas = [
  para(["辞　任　届"], { align: "center", sz: 28, bold: true }),
  BLANK,
  para(["　私は、このたび一身上の都合により、", HL("辞任日"), "をもって貴社の取締役を辞任いたしたく、お届けします。"]),
  BLANK,
  para([HL("辞任日")]),
  BLANK,
  para(["氏　名　", HL("対象取締役氏名"), "　　　　㊞"], { align: "right" }),
  BLANK,
  para([HL("会社名"), "　御中"]),
];

// ============================================================
// 出力
// ============================================================

const files = [
  ["変更登記申請書_目的変更.docx", shinseishoMokuteki],
  ["委任状.docx", ininjoParas],
  ["株主総会議事録_役員選任.docx", gijirokuSennin],
  ["株主総会議事録_役員重任.docx", gijirokuJuunin],
  ["就任承諾書.docx", shuninShodakuParas],
  ["辞任届.docx", jininTodokeParas],
  ["変更登記申請書_役員就任.docx", shinseishoShunin],
  ["変更登記申請書_役員辞任.docx", shinseishoJinin],
  ["変更登記申請書_役員重任.docx", shinseishoJuunin],
];

for (const [name, paras] of files) {
  const buf = buildDocx(paras);
  writeFileSync(path.join(OUT_DIR, name), buf);
  console.log(`✓ ${name} (${buf.length} bytes)`);
}
