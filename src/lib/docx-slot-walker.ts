// docx-slot-walker.ts
//
// **docx の段落とハイライト slot を 1 つの共通関数で列挙する**。
//
// 旧設計では template-normalize.ts (slot を振る側) と edit-engine.ts (値を流し込む側) で
// 走査ロジックが別実装になっていた。AlternateContent / txbxContent の除去有無や、
// メタタグの扱いに微妙な違いがあり、テキストボックスやモバイル対応マークアップを含む
// テンプレで slotId が大幅にズレて「全く違うところに全く違う値が入る」事故が起きた。
//
// この共通 walker を両方が使うことで、slotId の対応関係を原理的に保証する。
//
// 出力:
//   - paragraphs[]: 段落の物理位置 (start/end) + 抽出済みテキスト
//   - slots[]: ハイライト slot の物理位置と段落への紐付け + 元の値 + ★ラベル★用の文字列

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

const decodeXml = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// ハイライト判定 (黄色塗り or 赤フォント)
export function isHighlightRun(runXml: string): boolean {
  return /<w:highlight\s+w:val="[^"]*"\s*\/>/.test(runXml) ||
         /<w:color\s+w:val="FF0000"\s*\/>/i.test(runXml);
}

export interface ParagraphInfo {
  /** docXml 内の <w:p> の開始位置 */
  start: number;
  /** docXml 内の <w:p> の終了位置 (</w:p> の後) */
  end: number;
  /** 段落のテキスト (テキストボックス内除く、★は付かない原文) */
  text: string;
  /** 段落内のラン分割 (順序保存、edit-engine で書き換える際に使う) */
  parts: RunPart[];
}

export type RunPart =
  | { type: "other"; content: string }
  | { type: "run"; content: string; highlighted: boolean; text: string };

export interface SlotInfo {
  slotId: number;
  /** 元の値 (前案件の値) */
  originalValue: string;
  /** 所属する段落の index (paragraphs[paragraphIdx]) */
  paragraphIdx: number;
  /** その段落の parts 内での開始 part index */
  groupStartIdx: number;
  /** その段落の parts 内での終了 part index (inclusive) */
  groupEndIdx: number;
}

export interface WalkResult {
  /** AlternateContent 除去済みの docXml (操作後の段落 start/end はこの docXml ベース) */
  docXml: string;
  paragraphs: ParagraphInfo[];
  slots: SlotInfo[];
}

const isMetaOnly = (s: string): boolean =>
  s.replace(/<w:bookmark(?:Start|End)\b[^>]*\/>/g, "")
   .replace(/<w:commentRange(?:Start|End)\b[^>]*\/>/g, "")
   .replace(/<w:commentReference\b[^>]*\/>/g, "")
   .replace(/<w:proofErr\b[^>]*\/>/g, "")
   .trim() === "";

const getRunText = (runXml: string): string => {
  const texts: string[] = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(runXml)) !== null) texts.push(m[1]);
  return decodeXml(texts.join(""));
};

/**
 * docx Buffer または docXml 文字列を受け取って、共通形式で段落と slot を返す。
 *
 * 走査仕様 (template-normalize と edit-engine 両方で同じ):
 *   1. AlternateContent は除去 (内部の偽 <w:p> を無視)
 *   2. 段落単位で走査
 *   3. 段落内の txbxContent (テキストボックス) は除去してから run を走査
 *   4. 連続するハイライト run 群を 1 slot として slotId を 0 から振る
 *   5. ハイライト run 群の間に挟まる「メタタグだけのその他」要素は無視 (group 継続)
 */
export function walkDocxSlots(input: Buffer | string): WalkResult {
  let docXmlRaw: string;
  if (typeof input === "string") {
    docXmlRaw = input;
  } else {
    const zip = new PizZip(input);
    docXmlRaw = zip.file("word/document.xml")?.asText() || "";
  }
  // AlternateContent 除去
  const docXml = docXmlRaw.replace(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g, "");

  const paragraphs: ParagraphInfo[] = [];
  const slots: SlotInfo[] = [];
  let slotId = 0;

  const paragraphRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let pm: RegExpExecArray | null;
  while ((pm = paragraphRe.exec(docXml)) !== null) {
    const pXml = pm[0];
    // テキストボックス内は別段落として扱うので、本段落のテキスト/run には含めない
    const innerCleaned = pXml.replace(/<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g, "");

    // 段落内の parts (run と非 run) を順序付きで分割
    const parts: RunPart[] = [];
    const runRe = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
    let rm: RegExpExecArray | null;
    let plast = 0;
    while ((rm = runRe.exec(innerCleaned)) !== null) {
      if (rm.index > plast) parts.push({ type: "other", content: innerCleaned.slice(plast, rm.index) });
      const text = getRunText(rm[0]);
      const highlighted = isHighlightRun(rm[0]);
      parts.push({ type: "run", content: rm[0], highlighted, text });
      plast = rm.index + rm[0].length;
    }
    if (plast < innerCleaned.length) parts.push({ type: "other", content: innerCleaned.slice(plast) });

    // 段落の plain text (text 用)
    const text = parts.filter(p => p.type === "run").map(p => p.type === "run" ? p.text : "").join("");

    const paragraphIdx = paragraphs.length;
    paragraphs.push({ start: pm.index, end: pm.index + pXml.length, text, parts });

    // ハイライト group を走査して slot を生成
    let i = 0;
    while (i < parts.length) {
      const part = parts[i];
      if (part.type === "run" && part.highlighted) {
        const startIdx = i;
        let lastHl = i;
        let groupText = "";
        while (i < parts.length) {
          const p = parts[i];
          if (p.type === "run" && p.highlighted) {
            groupText += p.text;
            lastHl = i;
            i++;
          } else if (p.type === "other" && isMetaOnly(p.content)) {
            i++;
          } else {
            break;
          }
        }
        slots.push({
          slotId,
          originalValue: groupText,
          paragraphIdx,
          groupStartIdx: startIdx,
          groupEndIdx: lastHl,
        });
        slotId++;
      } else {
        i++;
      }
    }
  }

  return { docXml, paragraphs, slots };
}
