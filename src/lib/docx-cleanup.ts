// docx-cleanup.ts
// 清書クリーンアップ: 生成書類に残ってはいけない要素を XML 直接編集で確実に除去する。
//
// ★なぜ officecli を使わず PizZip で直接 XML をいじるか★
//   officecli の後処理呼び出し (set/query 等) は、サーバー高負荷時 (Word プロセス枯渇,
//   exit code 0xC0000142) に無言で失敗することがあり、「修正したのに直らない」事故の
//   元凶になっていた。PizZip で document.xml を直接書き換えれば Word / officecli に
//   一切依存しないので、負荷状況に関係なく決定論的に効く。
//
// ★除去対象 (いずれも「テンプレ用の印」であって清書に残ってはいけない)★
//   1. fitText (文字幅固定)
//        <w:fitText w:val="1260"/> 等。run のテキストを固定幅 (twips) に押し込む書式。
//        テンプレは列揃えのため短い前案件値に fitText をかけているが、そこへ長い値
//        (「Deep30投資事業有限責任組合」等) を流すと同じ幅に圧縮され極小・潰れ表示になる
//        (組合の提案書兼同意書「無限責任組合員」「代表取締役」行で発生)。
//        清書では外して自然な幅で流す。列位置は段落の字下げ (indent) が保つので崩れない。
//   2. highlight (黄色マーカー等)
//        <w:highlight w:val="yellow"/> 等。「ここを埋める」というテンプレ上の目印。
//   3. 赤文字マーカー (FF0000)
//        <w:color w:val="FF0000"/>。highlight と同じくテンプレ上の目印。既定色に戻す。
//
// 適用先: word/document.xml + header*.xml + footer*.xml (本文に出る部分すべて)。
// styles.xml/numbering.xml は触らない (テンプレ定義そのものは保持)。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

export interface DocxCleanupCounts {
  fitText: number;
  highlight: number;
  redColor: number;
}

// XML 文字列 1 つ分のクリーンアップ。除去件数も数える (ログ・検証用)。
function cleanupXmlString(xml: string): { xml: string; counts: DocxCleanupCounts } {
  const counts: DocxCleanupCounts = { fitText: 0, highlight: 0, redColor: 0 };
  let out = xml;

  // 1. fitText: 自己終了タグ <w:fitText .../> と ペアタグ <w:fitText ...>...</w:fitText> の両方
  out = out.replace(/<w:fitText\b[^>]*\/>/g, () => { counts.fitText++; return ""; });
  out = out.replace(/<w:fitText\b[^>]*?>[\s\S]*?<\/w:fitText>/g, () => { counts.fitText++; return ""; });

  // 2. highlight: 値は問わず全除去 (テンプレのマーカーは清書に残さない)
  out = out.replace(/<w:highlight\b[^>]*\/>/g, () => { counts.highlight++; return ""; });

  // 3. 赤文字マーカー (Word の「標準の色: 赤」= FF0000) を除去 → 既定色に戻る
  out = out.replace(/<w:color\s+w:val="FF0000"\s*\/>/gi, () => { counts.redColor++; return ""; });

  return { xml: out, counts };
}

/**
 * 生成済み docx (Buffer) から fitText・マーカー (黄色ハイライト・赤文字) を除去した Buffer を返す。
 * 変更が無ければ元の Buffer をそのまま返す。
 */
export function cleanupGeneratedDocx(buf: Buffer): { buf: Buffer; counts: DocxCleanupCounts } {
  const total: DocxCleanupCounts = { fitText: 0, highlight: 0, redColor: 0 };
  let zip;
  try {
    zip = new PizZip(buf);
  } catch {
    return { buf, counts: total };
  }
  const targets = Object.keys(zip.files).filter((n) =>
    /^word\/(document\.xml|header\d*\.xml|footer\d*\.xml)$/.test(n)
  );
  let changed = false;
  for (const name of targets) {
    const xml = zip.file(name)?.asText();
    if (!xml) continue;
    const { xml: cleaned, counts } = cleanupXmlString(xml);
    total.fitText += counts.fitText;
    total.highlight += counts.highlight;
    total.redColor += counts.redColor;
    if (cleaned !== xml) {
      zip.file(name, cleaned);
      changed = true;
    }
  }
  if (!changed) return { buf, counts: total };
  const outBuf = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  return { buf: outBuf, counts: total };
}
