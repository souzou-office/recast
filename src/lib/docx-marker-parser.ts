// docx-marker-parser.ts
// Word文書のハイライト（黄色等）とコメントを解析し、可変フィールドの抽出と置換を行う。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

export interface MarkedField {
  id: number;
  originalValue: string;   // ハイライトされた元テキスト（前案件の値）
  comment?: string;        // コメントがあればその文字
  context: string;         // 段落のテキスト全体（AIが何の値か推定するため）
}

// XML テキストノードをデコード
function decodeXml(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// XML エスケープ
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// <w:r> からテキストを抽出
function getRunText(runXml: string): string {
  const texts: string[] = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(runXml)) !== null) texts.push(m[1]);
  return decodeXml(texts.join(""));
}

// <w:r> にハイライト（黄色塗り）または赤い文字色があるか。
// どちらも「ここはこれから埋めるべきスロット」のマーカーとして扱う。
function hasHighlight(runXml: string): boolean {
  return /<w:highlight\s+w:val="[^"]*"\s*\/>/.test(runXml) || hasRedColor(runXml);
}

// 「標準の色：赤」を Word が書き込むときの XML。FF0000 が固定値。
// (Word ribbon で「フォントの色 → 標準の色 → 赤」を選んだとき出力される)
function hasRedColor(runXml: string): boolean {
  return /<w:color\s+w:val="FF0000"\s*\/>/i.test(runXml);
}

// 段落全体のテキストを取得
function getParagraphText(pXml: string): string {
  const texts: string[] = [];
  const re = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  let m;
  while ((m = re.exec(pXml)) !== null) texts.push(getRunText(m[0]));
  return texts.join("");
}

// docx Buffer → ハイライト付きフィールド一覧
export function extractMarkedFields(buffer: Buffer): MarkedField[] {
  const zip = new PizZip(buffer);
  const docXmlRaw = zip.file("word/document.xml")?.asText();
  if (!docXmlRaw) return [];
  const docXml = stripAlternateContent(docXmlRaw);

  // コメント情報
  const commentTexts = new Map<string, string>();
  const commentsXml = zip.file("word/comments.xml")?.asText();
  if (commentsXml) {
    const re = /<w:comment\s+[^>]*w:id="(\d+)"[^>]*>([\s\S]*?)<\/w:comment>/g;
    let m;
    while ((m = re.exec(commentsXml)) !== null) {
      commentTexts.set(m[1], decodeXml(getRunText(m[2])).trim());
    }
  }

  // コメント範囲（ID → 開始/終了オフセット）
  const commentRanges = new Map<string, { start: number; end: number }>();
  {
    const startRe = /<w:commentRangeStart\s+w:id="(\d+)"\s*\/>/g;
    let m;
    while ((m = startRe.exec(docXml)) !== null) {
      commentRanges.set(m[1], { start: m.index, end: -1 });
    }
    const endRe = /<w:commentRangeEnd\s+w:id="(\d+)"\s*\/>/g;
    while ((m = endRe.exec(docXml)) !== null) {
      const r = commentRanges.get(m[1]);
      if (r) r.end = m.index + m[0].length;
    }
  }

  const fields: MarkedField[] = [];
  let fieldId = 0;

  // 段落ごと（ネスト <w:p> 対応の findTopLevelParagraphs を使う。テキストボックスを含む段落で
  // 終端を取り違えないように。同意書テンプレの議決権数等を取りこぼすバグ対策。）
  const paragraphs = findTopLevelParagraphs(docXml);
  for (const p of paragraphs) {
    const pXml = docXml.slice(p.start, p.end);
    const pStart = p.start;
    const context = getParagraphText(pXml);

    // テキストボックス内の <w:p> は別段落として扱いたいので除外
    const inner = docXml.slice(p.openEnd, p.end - "</w:p>".length);
    const cleanInner = inner.replace(/<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g, "");

    // この段落内のランを順に走査、ハイライト付きランを連続グループにまとめる
    const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    let rm;
    let currentGroup: string[] = [];
    let groupStartOffset = -1;
    let groupEndOffset = -1;

    const flushGroup = () => {
      if (currentGroup.length === 0) return;
      const originalValue = currentGroup.join("");
      if (!originalValue.trim()) { currentGroup = []; return; }

      // コメントを探す
      let comment: string | undefined;
      for (const [cId, range] of commentRanges) {
        if (range.start <= groupStartOffset && range.end >= groupEndOffset) {
          comment = commentTexts.get(cId);
          break;
        }
      }

      fields.push({ id: fieldId++, originalValue, comment, context });
      currentGroup = [];
    };

    while ((rm = runRe.exec(cleanInner)) !== null) {
      if (hasHighlight(rm[0])) {
        const text = getRunText(rm[0]);
        if (currentGroup.length === 0) {
          groupStartOffset = pStart + cleanInner.indexOf(rm[0]);
        }
        groupEndOffset = pStart + cleanInner.indexOf(rm[0]) + rm[0].length;
        currentGroup.push(text);
      } else {
        flushGroup();
      }
    }
    flushGroup();
  }

  return fields;
}

// <mc:AlternateContent>...</mc:AlternateContent> を除去する（内部に偽 <w:p> があり段落マッチが途中で切れる）
function stripAlternateContent(xml: string): string {
  return xml.replace(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g, "");
}

// トップレベルの <w:p>...</w:p> を、<mc:AlternateContent> 内の偽 <w:p> を無視して列挙。
// **また、<w:pict> や <w:drawing> 内のテキストボックス (<w:txbxContent>) に含まれる
// 子 <w:p> も「入れ子」として扱い、外側の <w:p> 終端を見つけるために <w:p> 深さを数える**。
// これを怠ると、テキストボックスを含む段落（例: 同意書テンプレ）の終端を取り違えて、
// 後ろのハイライトラン（議決権数など）が処理対象から外れるバグが発生する。
type ParaRange = { start: number; end: number; openEnd: number };
function findTopLevelParagraphs(xml: string): ParaRange[] {
  const results: ParaRange[] = [];
  let pos = 0;
  const altStartRe = /<mc:AlternateContent\b/;
  const altEndRe = /<\/mc:AlternateContent>/;
  const pOpenRe = /<w:p\b[^>]*>/g;
  while (pos < xml.length) {
    pOpenRe.lastIndex = pos;
    const mOpen = pOpenRe.exec(xml);
    if (!mOpen) break;
    // Check if this <w:p> is inside an AlternateContent block — if so skip
    const before = xml.slice(0, mOpen.index);
    let inAlt = false;
    let scanPos = 0;
    while (scanPos < before.length) {
      const s = before.slice(scanPos).search(altStartRe);
      if (s < 0) break;
      const absS = scanPos + s;
      const afterS = xml.slice(absS);
      const e = afterS.search(altEndRe);
      if (e < 0) { inAlt = true; break; } // unclosed — treat as inside
      const absE = absS + e + "</mc:AlternateContent>".length;
      if (absE > mOpen.index) { inAlt = true; break; }
      scanPos = absE;
    }
    if (inAlt) { pos = mOpen.index + mOpen[0].length; continue; }
    // Skip if inside another already-found top-level paragraph (= ネストされた <w:p>)
    if (results.some(r => r.start < mOpen.index && mOpen.index < r.end)) {
      pos = mOpen.index + mOpen[0].length;
      continue;
    }
    // Find matching </w:p> at same nesting level
    const openEnd = mOpen.index + mOpen[0].length;
    // Scan forward, counting nested <w:p> AND <mc:AlternateContent>
    let i = openEnd;
    let altDepth = 0;
    let pDepth = 0; // ネストされた <w:p> の深さ（テキストボックス内など）
    let closeAt = -1;
    while (i < xml.length) {
      if (xml.startsWith("<mc:AlternateContent", i) && /^<mc:AlternateContent\b/.test(xml.slice(i))) {
        altDepth++;
        const tagEnd = xml.indexOf(">", i);
        if (tagEnd < 0) break;
        i = tagEnd + 1;
        continue;
      }
      if (xml.startsWith("</mc:AlternateContent>", i)) {
        altDepth = Math.max(0, altDepth - 1);
        i += "</mc:AlternateContent>".length;
        continue;
      }
      // ネスト <w:p> の開始 (空でない要素として認識)
      if (altDepth === 0 && /^<w:p[\s>]/.test(xml.slice(i, i + 5))) {
        pDepth++;
        const tagEnd = xml.indexOf(">", i);
        if (tagEnd < 0) break;
        i = tagEnd + 1;
        continue;
      }
      if (xml.startsWith("</w:p>", i)) {
        if (altDepth === 0 && pDepth === 0) {
          closeAt = i;
          break;
        }
        if (altDepth === 0 && pDepth > 0) pDepth--;
        i += "</w:p>".length;
        continue;
      }
      i++;
    }
    if (closeAt < 0) { pos = openEnd; continue; }
    results.push({ start: mOpen.index, end: closeAt + "</w:p>".length, openEnd });
    pos = closeAt + "</w:p>".length;
  }
  return results;
}

// 文書全体のテキストを、ハイライト部分を［要入力_N］に置き換えて返す。
// **前案件の値は AI に見せない**（型ヒントとして見せた時期もあったが、AI がそれに引きずられて
// 同じ値を返すケースが頻発したため、826ca83 で完全に隠す方針に戻した）。
// AI には周辺文脈と .labels.json のラベルから型・意味を判断させる。
// 元の値（前案件の値）は slots Map に保持（produce/regenerate で originalValue→newValue の
// 置換マップを作るため必要）。
export function getMarkedDocumentTextWithSlots(buffer: Buffer): { text: string; slots: Map<number, string> } {
  const zip = new PizZip(buffer);
  let docXml = zip.file("word/document.xml")?.asText();
  if (!docXml) return { text: "", slots: new Map() };
  docXml = stripAlternateContent(docXml);

  const slots = new Map<number, string>();
  let slotId = 0;
  const lines: string[] = [];
  // 段落の境界は「ネストされた <w:p> を考慮した」findTopLevelParagraphs で取得する。
  // 単純な非貪欲 regex だと、テキストボックス内の <w:p> で </w:p> を取り違えて
  // 後続のハイライトラン（同意書テンプレの議決権数等）を取りこぼす。
  const paragraphs = findTopLevelParagraphs(docXml);
  for (const p of paragraphs) {
    // <w:p> 内の <w:r> を、ネストされた <w:p>（テキストボックス内）の <w:r> も含めて拾う。
    // ただしテキストボックス内の run は別段落として扱いたいので、まず外側 <w:p> 直下の
    // run だけを取り、テキストボックスは画像扱いでスキップ。
    const inner = docXml.slice(p.openEnd, p.end - "</w:p>".length);
    // テキストボックス content 内の <w:p> はここでは処理しない（後で別に処理）
    // → 簡易的に <w:txbxContent>...</w:txbxContent> を除去してから run を拾う
    const cleanInner = inner.replace(/<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g, "");
    const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    let rm;
    let lineText = "";
    let currentGroupText = "";
    const flushGroup = () => {
      if (currentGroupText) {
        slots.set(slotId, currentGroupText);
        // ★前案件の値は出力テキストに含めない★。番号だけ。AI には文脈から型を判断させる。
        lineText += `［要入力_${slotId}］`;
        slotId++;
        currentGroupText = "";
      }
    };
    while ((rm = runRe.exec(cleanInner)) !== null) {
      const text = getRunText(rm[0]);
      if (!text) continue;
      if (hasHighlight(rm[0])) {
        currentGroupText += text;
      } else {
        flushGroup();
        lineText += text;
      }
    }
    flushGroup();
    if (lineText.trim()) lines.push(lineText);
  }
  return { text: lines.join("\n"), slots };
}

// 文書全体のテキストを、ハイライト部分を★マーク★で囲んで返す（旧方式、後方互換用）
// AIが文書の流れを見ながら各マーク部分が何を指すか判断できるようにする
export function getMarkedDocumentText(buffer: Buffer): string {
  const zip = new PizZip(buffer);
  const docXml = zip.file("word/document.xml")?.asText();
  if (!docXml) return "";

  const lines: string[] = [];
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let pm;
  while ((pm = pRe.exec(docXml)) !== null) {
    const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    let rm;
    let lineText = "";
    while ((rm = runRe.exec(pm[1])) !== null) {
      const text = getRunText(rm[0]);
      if (!text) continue;
      if (hasHighlight(rm[0])) {
        lineText += `★${text}★`;
      } else {
        lineText += text;
      }
    }
    if (lineText.trim()) lines.push(lineText);
  }

  // 連続する★★を結合（分割ランの★マーク★を1つにまとめる）
  let result = lines.join("\n");
  // ★text1★★text2★ → ★text1text2★
  while (result.includes("★★")) {
    result = result.replace(/★★/g, "");
  }
  return result;
}

// ハイライト付きフィールドを置換して、ハイライト/コメントを除去した docx Buffer を返す
export function replaceMarkedFields(
  buffer: Buffer,
  replacements: Record<string, string>,
): Buffer {
  const zip = new PizZip(buffer);
  let docXml = zip.file("word/document.xml")?.asText();
  if (!docXml) return buffer;

  // トップレベル段落のみ処理（<mc:AlternateContent> 内の偽 <w:p> は無視）
  // 後ろから置換していくことで、インデックスのずれを気にせず一回パスで完了させる
  const paragraphs = findTopLevelParagraphs(docXml);
  const processParagraph = (pXml: string): string => {
    {
      // この段落内のハイライト付きランのグループを特定して置換
      // 戦略: ランを順に走査して、ハイライトグループを見つけたらテキストを結合 → replacementsからマッチを探す
      const runs: { xml: string; highlighted: boolean; text: string }[] = [];
      const runRe = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
      let rm;
      let lastEnd = 0;

      // ラン以外の部分（段落プロパティ等）も保持する必要がある
      const parts: { type: "other" | "run"; content: string; highlighted?: boolean }[] = [];

      // 段落を「ラン」と「ラン以外」に分割
      while ((rm = runRe.exec(pXml)) !== null) {
        if (rm.index > lastEnd) {
          parts.push({ type: "other", content: pXml.slice(lastEnd, rm.index) });
        }
        const hl = hasHighlight(rm[0]);
        parts.push({ type: "run", content: rm[0], highlighted: hl });
        runs.push({ xml: rm[0], highlighted: hl, text: getRunText(rm[0]) });
        lastEnd = rm.index + rm[0].length;
      }
      if (lastEnd < pXml.length) {
        parts.push({ type: "other", content: pXml.slice(lastEnd) });
      }

      // ハイライトグループを特定
      // ランの間に <w:bookmarkEnd>, <w:commentRangeStart> 等のメタデータが挟まっていても
      // ハイライトグループは連続とみなす（getMarkedDocumentTextWithSlots 側の動きと揃える）
      type Group = { startIdx: number; endIdx: number; originalValue: string };
      const groups: Group[] = [];
      const isMetadataOnly = (content: string): boolean => {
        // 空白と、テキストを含まないメタ要素のみなら true
        const stripped = content
          .replace(/<w:bookmarkStart\b[^>]*\/>/g, "")
          .replace(/<w:bookmarkEnd\b[^>]*\/>/g, "")
          .replace(/<w:commentRangeStart\b[^>]*\/>/g, "")
          .replace(/<w:commentRangeEnd\b[^>]*\/>/g, "")
          .replace(/<w:commentReference\b[^>]*\/>/g, "")
          .replace(/<w:proofErr\b[^>]*\/>/g, "")
          .trim();
        return stripped === "";
      };
      let i = 0;
      while (i < parts.length) {
        if (parts[i].type === "run" && parts[i].highlighted) {
          const startIdx = i;
          let text = "";
          let lastHlIdx = i;
          // ハイライト run を拾いつつ、間の空メタ "other" は飛ばして継続
          while (i < parts.length) {
            if (parts[i].type === "run" && parts[i].highlighted) {
              text += getRunText(parts[i].content);
              lastHlIdx = i;
              i++;
            } else if (parts[i].type === "other" && isMetadataOnly(parts[i].content)) {
              i++;
              continue;
            } else {
              break;
            }
          }
          groups.push({ startIdx, endIdx: lastHlIdx, originalValue: text });
        } else {
          i++;
        }
      }

      if (groups.length === 0) return pXml;

      // 各グループについて置換を適用
      // 後ろから処理（インデックスがずれないように）
      for (let g = groups.length - 1; g >= 0; g--) {
        const group = groups[g];
        const newValue = replacements[group.originalValue];
        if (newValue === undefined) continue;

        const escapedNew = xmlEscape(newValue);

        // 最初のランにnewValueを入れてハイライト除去、残りのハイライトランは削除
        // （間に挟まる "other" メタ要素は温存する）
        for (let j = group.endIdx; j >= group.startIdx; j--) {
          if (j === group.startIdx) {
            // 最初のラン: テキストを新しい値に、ハイライトと赤い文字色を除去
            let newRun = parts[j].content;
            // ハイライト属性を除去
            newRun = newRun.replace(/<w:highlight\s+w:val="[^"]*"\s*\/>/g, "");
            // 赤い文字色 <w:color w:val="FF0000"/> を除去（テキストを通常色に戻す）
            newRun = newRun.replace(/<w:color\s+w:val="FF0000"\s*\/>/gi, "");
            // テキストを置換
            newRun = newRun.replace(
              /<w:t\b[^>]*>[\s\S]*?<\/w:t>/g,
              `<w:t xml:space="preserve">${escapedNew}</w:t>`
            );
            parts[j] = { ...parts[j], content: newRun };
          } else if (parts[j].type === "run" && parts[j].highlighted) {
            // 残りのハイライト/赤ラン: 削除（メタ要素は温存）
            parts.splice(j, 1);
          }
        }
      }

      return parts.map(p => p.content).join("");
    }
  };
  // 後ろから処理して index ずれ回避
  for (let pi = paragraphs.length - 1; pi >= 0; pi--) {
    const p = paragraphs[pi];
    const before = docXml.substring(0, p.start);
    const orig = docXml.substring(p.start, p.end);
    const after = docXml.substring(p.end);
    const processed = processParagraph(orig);
    if (processed !== orig) docXml = before + processed + after;
  }

  // コメント関連要素を除去
  docXml = docXml
    .replace(/<w:commentRangeStart\s+w:id="\d+"\s*\/>/g, "")
    .replace(/<w:commentRangeEnd\s+w:id="\d+"\s*\/>/g, "")
    .replace(/<w:commentReference\s+w:id="\d+"\s*\/>/g, "");

  zip.file("word/document.xml", docXml);

  // comments.xml を削除
  if (zip.file("word/comments.xml")) {
    zip.remove("word/comments.xml");
    const ctPath = "[Content_Types].xml";
    const ctXml = zip.file(ctPath)?.asText();
    if (ctXml) {
      const cleaned = ctXml.replace(/<Override\b[^>]*\bPartName="\/word\/comments\.xml"[^>]*\/>/g, "");
      if (cleaned !== ctXml) zip.file(ctPath, cleaned);
    }
    const relsPath = "word/_rels/document.xml.rels";
    const relsXml = zip.file(relsPath)?.asText();
    if (relsXml) {
      const cleaned = relsXml.replace(/<Relationship\b[^>]*\bTarget="comments\.xml"[^>]*\/>/g, "");
      if (cleaned !== relsXml) zip.file(relsPath, cleaned);
    }
  }

  // 最終確認: 残っているハイライト + 赤い文字色を全て除去（置換漏れのフォールバック）
  const finalXml = zip.file("word/document.xml")?.asText();
  if (finalXml) {
    const cleaned = finalXml
      .replace(/<w:highlight\s+w:val="[^"]*"\s*\/>/g, "")
      .replace(/<w:color\s+w:val="FF0000"\s*\/>/gi, "");
    if (cleaned !== finalXml) zip.file("word/document.xml", cleaned);
  }

  return zip.generate({ type: "nodebuffer" });
}
