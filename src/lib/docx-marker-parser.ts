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

// <w:r> にハイライトがあるか
function hasHighlight(runXml: string): boolean {
  return /<w:highlight\s+w:val="[^"]*"\s*\/>/.test(runXml);
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
  const docXml = zip.file("word/document.xml")?.asText();
  if (!docXml) return [];

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

  // 段落ごと
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let pm;
  while ((pm = pRe.exec(docXml)) !== null) {
    const pXml = pm[0];
    const pStart = pm.index;
    const context = getParagraphText(pXml);

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

    while ((rm = runRe.exec(pm[1])) !== null) {
      if (hasHighlight(rm[0])) {
        const text = getRunText(rm[0]);
        if (currentGroup.length === 0) {
          groupStartOffset = pStart + pm[0].indexOf(rm[0]);
        }
        groupEndOffset = pStart + pm[0].indexOf(rm[0]) + rm[0].length;
        currentGroup.push(text);
      } else {
        flushGroup();
      }
    }
    flushGroup();
  }

  return fields;
}

// 文書全体のテキストを、ハイライト部分を［要入力_N］に置き換えて返す。
// ★値★ の中身（前案件の値）はAIに見せず、文脈だけで判断させるため。
// 併せて N → 元テキスト（originalValue）のマッピングも返す。
export function getMarkedDocumentTextWithSlots(buffer: Buffer): { text: string; slots: Map<number, string> } {
  const zip = new PizZip(buffer);
  const docXml = zip.file("word/document.xml")?.asText();
  if (!docXml) return { text: "", slots: new Map() };

  const slots = new Map<number, string>();
  let slotId = 0;
  const lines: string[] = [];
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let pm;
  while ((pm = pRe.exec(docXml)) !== null) {
    const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    let rm;
    let lineText = "";
    let currentGroupText = "";
    const flushGroup = () => {
      if (currentGroupText) {
        slots.set(slotId, currentGroupText);
        lineText += `［要入力_${slotId}］`;
        slotId++;
        currentGroupText = "";
      }
    };
    while ((rm = runRe.exec(pm[1])) !== null) {
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

  // 段落ごとにハイライト付きランを見つけて置換
  docXml = docXml.replace(
    /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g,
    (pXml: string) => {
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
      type Group = { startIdx: number; endIdx: number; originalValue: string };
      const groups: Group[] = [];
      let i = 0;
      while (i < parts.length) {
        if (parts[i].type === "run" && parts[i].highlighted) {
          const startIdx = i;
          let text = "";
          while (i < parts.length && parts[i].type === "run" && parts[i].highlighted) {
            text += getRunText(parts[i].content);
            i++;
          }
          groups.push({ startIdx, endIdx: i - 1, originalValue: text });
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

        // 最初のランにnewValueを入れてハイライト除去、残りのランは削除
        for (let j = group.endIdx; j >= group.startIdx; j--) {
          if (j === group.startIdx) {
            // 最初のラン: テキストを新しい値に、ハイライトを除去
            let newRun = parts[j].content;
            // ハイライト属性を除去
            newRun = newRun.replace(/<w:highlight\s+w:val="[^"]*"\s*\/>/g, "");
            // テキストを置換
            newRun = newRun.replace(
              /<w:t\b[^>]*>[\s\S]*?<\/w:t>/g,
              `<w:t xml:space="preserve">${escapedNew}</w:t>`
            );
            parts[j] = { ...parts[j], content: newRun };
          } else {
            // 残りのラン: 削除
            parts.splice(j, 1);
          }
        }
      }

      return parts.map(p => p.content).join("");
    }
  );

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

  // 最終確認: 残っているハイライトを全て除去（置換漏れのフォールバック）
  let finalXml = zip.file("word/document.xml")?.asText();
  if (finalXml) {
    const cleaned = finalXml.replace(/<w:highlight\s+w:val="[^"]*"\s*\/>/g, "");
    if (cleaned !== finalXml) zip.file("word/document.xml", cleaned);
  }

  return zip.generate({ type: "nodebuffer" });
}
