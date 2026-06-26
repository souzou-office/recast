// docx-verify.ts
// 生成 docx を読み返して「機械的に分かる崩れ」を検出する (検証＋修復ループの"目"の部分)。
//
// ★第1弾: 穴埋め未完 (サイレントスキップ) の検出★
//   recast で一番怖い事故＝「officecli が成功と言いつつ変換が効いてない書類がそのまま出る」。
//   穴埋め(fill)が成功すると set が highlight を消す (docx: highlight=none / xlsx: fill=FFFFFF →
//   fill-command-generator.ts 参照)。なので **cleanup で全 highlight を消す"前"** に、まだ
//   highlight が残っている run = 「埋まってない/触られてないマーカー」= 事故、と機械的に判定できる。
//   ★必ず docx-cleanup より前に呼ぶこと★ (cleanup 後は全 highlight が消えて検出不能)。
//
//   officecli が highlight=none をどう書くか (要素削除 or w:val="none") に依存しないよう、
//   w:val が "none" 以外の highlight だけを「未処理」とみなす (none=穴埋め済みなので除外)。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

export interface UnfilledMarker {
  file: string;       // word/document.xml / header*.xml / footer*.xml
  text: string;       // 残っているマーカーの文字 (ラベル等。穴埋めされていれば消えているはずの文字)
  highlight: string;  // 残っている highlight の色 (yellow 等)
}

// XML 内の <w:t> を全部つないで素のテキストにする (基本的な実体参照だけ戻す)。
function runText(run: string): string {
  const parts = [...run.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
  return parts
    .join("")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

/**
 * 生成済み docx (Buffer, ★cleanup 前★) から「穴埋めが効いていないマーカー」を検出する。
 * highlight が残っている (w:val != none) run = 未処理マーカー。空文字 run はノイズなので除外。
 */
export function detectUnfilledMarkers(buf: Buffer): UnfilledMarker[] {
  let zip;
  try {
    zip = new PizZip(buf);
  } catch {
    return [];
  }
  const targets = Object.keys(zip.files).filter((n) =>
    /^word\/(document\.xml|header\d*\.xml|footer\d*\.xml)$/.test(n)
  );
  const found: UnfilledMarker[] = [];
  for (const name of targets) {
    const xml = zip.file(name)?.asText();
    if (!xml) continue;
    const runs = xml.match(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g) || [];
    for (const run of runs) {
      const hl = run.match(/<w:highlight\b[^>]*\bw:val="([^"]*)"/);
      if (!hl) continue;
      const color = hl[1];
      if (color === "none") continue; // 穴埋め済み (set が highlight=none を書いた) → 問題なし
      const text = runText(run);
      if (!text) continue; // 空の highlight run はテンプレ由来のノイズとして無視
      found.push({ file: name, text, highlight: color });
    }
  }
  return found;
}
