// edit-engine.ts
//
// AI が出した 3 種類の edit (delete / replace / insert) を docx/xlsx Buffer に適用する
// インタプリタ。
//
// 設計判断:
//   AI 視野には「★ラベル★ という識別子」を見せず、「テンプレ本文中の★…★文字列をリテラル
//   引用してもらう」設計に変更 (旧 `modify` を `replace` に置換)。
//   AI は本文を見て ★…★ をコピペするだけなので、意味的な言い換えが構造的に発生しない。
//
// 入力:
//   - buffer: テンプレ docx/xlsx の元バイト列
//   - normalized: template-normalize.ts が生成した markerToSlots (★…★文字列 → 物理位置群)
//   - edits: AI が返した編集オペレーション配列
// 出力:
//   - buffer: 編集適用後の docx/xlsx
//   - applied: 適用できた edit のインデックス
//   - skipped: 適用できなかった edit と理由

import type { NormalizedTemplate, SlotRef } from "./template-normalize";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const decodeXml = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// AI が返す edit プリミティブ。3 種類だけ。
export type Edit =
  | {
      op: "delete";
      anchor: string;
      endAnchor?: string;
      reason?: string;
    }
  | {
      op: "replace";
      // テンプレ本文中の★…★文字列を**そのままリテラル**で指定。
      // 例: find: "★同意書の日付★", replaceWith: "令和８年５月２８日"
      find: string;
      replaceWith: string;
      reason?: string;
    }
  | {
      op: "insert";
      // 複製元: anchor 段落から endAnchor 段落 (両端含む) までを 1 ユニット
      copyFromAnchor: string;
      copyFromEndAnchor: string;
      // 挿入先: insertAfterAnchor を含む段落の直後に複製を貼る
      insertAfterAnchor: string;
      // 各複製ユニットの中の★…★を find/replaceWith で埋める
      replaces: { find: string; replaceWith: string }[];
      reason?: string;
    };

export interface EditApplyResult {
  buffer: Buffer;
  applied: number[];
  skipped: { index: number; reason: string }[];
}

// -----------------------------------------------------------------------------
// メインのディスパッチ
// -----------------------------------------------------------------------------

export async function applyEdits(
  buffer: Buffer,
  fileName: string,
  normalized: NormalizedTemplate,
  edits: Edit[],
): Promise<EditApplyResult> {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (ext === "xlsx" || ext === "xls" || ext === "xlsm") {
    return applyEditsXlsx(buffer, normalized, edits);
  }
  return applyEditsDocx(buffer, normalized, edits);
}

// -----------------------------------------------------------------------------
// docx 適用
// -----------------------------------------------------------------------------

function applyEditsDocx(
  buffer: Buffer,
  normalized: NormalizedTemplate,
  edits: Edit[],
): EditApplyResult {
  const zip = new PizZip(buffer);
  let docXml = zip.file("word/document.xml")?.asText();
  if (!docXml) {
    return {
      buffer,
      applied: [],
      skipped: edits.map((_, i) => ({ index: i, reason: "document.xml が見つかりません" })),
    };
  }

  const applied: number[] = [];
  const skipped: { index: number; reason: string }[] = [];

  // 順番: delete → insert → replace の順で適用。
  //   delete: 不要範囲を先に消す
  //   insert: 残った既存ユニットを複製 (複製内の★は同じ replace 処理で後で埋まる)
  //   replace: 各 marker に値を流し込む
  const deleteEdits: { idx: number; edit: Extract<Edit, { op: "delete" }> }[] = [];
  const insertEdits: { idx: number; edit: Extract<Edit, { op: "insert" }> }[] = [];
  const replaceEdits: { idx: number; edit: Extract<Edit, { op: "replace" }> }[] = [];
  edits.forEach((edit, idx) => {
    if (edit.op === "delete") deleteEdits.push({ idx, edit });
    else if (edit.op === "insert") insertEdits.push({ idx, edit });
    else if (edit.op === "replace") replaceEdits.push({ idx, edit });
  });

  // ----- delete: 段落範囲の削除 -----
  for (const { idx, edit } of deleteEdits) {
    const res = deleteParagraphRangeDocx(docXml, edit.anchor, edit.endAnchor);
    if (res.ok) {
      docXml = res.xml;
      applied.push(idx);
    } else {
      skipped.push({ index: idx, reason: res.reason });
    }
  }

  // ----- insert: 既存パターン段落の複製 -----
  for (const { idx, edit } of insertEdits) {
    const res = insertParagraphRangeDocx(docXml, edit);
    if (res.ok) {
      docXml = res.xml;
      applied.push(idx);
    } else {
      skipped.push({ index: idx, reason: res.reason });
    }
  }

  // ----- replace: marker (★ラベル★) を値で流し込む -----
  // 同じ marker に対応する SlotRef が複数 ref あれば全 ref に同じ値を書き込む。
  // - docx-highlight ref: slotId 単位でハイライト run 群を書き換え
  // - docx-placeholder ref: テキスト直接置換
  const highlightReplacements = new Map<number, string>();
  const placeholderReplacements: { placeholder: string; value: string; openClose: [string, string] }[] = [];
  // insert で増えた複製ブロックに対する replace は markerToSlots に載っていない (元テンプレベース)。
  // そのため insert 内の replaces は **複製ブロック内のテキスト置換** として個別に処理する。
  // ここで生成する「最終 docXml に対する追加テキスト置換」を集める。
  const literalReplacements: { find: string; replaceWith: string }[] = [];

  for (const { idx, edit } of replaceEdits) {
    const refs = normalized.markerToSlots.get(edit.find);
    if (!refs || refs.length === 0) {
      // marker がテンプレに見当たらない (例: 削除済みブロック内の slot)。
      // また、AI が ★ なしの裸文字列を出した場合もここに来る (これはエラー扱い、skip)。
      skipped.push({ index: idx, reason: `find "${edit.find}" がテンプレ本文の ★…★ に存在せず (削除済み or 文字列不一致)` });
      continue;
    }
    let any = false;
    for (const ref of refs) {
      if (ref.kind === "docx-highlight") {
        highlightReplacements.set(ref.slotId, edit.replaceWith);
        any = true;
      } else if (ref.kind === "docx-placeholder") {
        placeholderReplacements.push({ placeholder: ref.placeholder, value: edit.replaceWith, openClose: ref.openClose });
        any = true;
      }
    }
    if (any) applied.push(idx);
    else skipped.push({ index: idx, reason: `find "${edit.find}" は xlsx 用 ref のみで docx で適用先なし` });
  }

  // insert で挿入された複製ブロックの中の ★…★ も「リテラル置換」として後段で処理する
  for (const { edit } of insertEdits) {
    for (const r of edit.replaces || []) {
      literalReplacements.push({ find: r.find, replaceWith: r.replaceWith });
    }
  }

  // placeholder は単純な text 置換 (XML 内の【foo】等を全部)
  for (const r of placeholderReplacements) {
    const [open, close] = r.openClose;
    const target = `${open}${r.placeholder}${close}`;
    docXml = (docXml as string).split(target).join(xmlEscape(r.value));
  }

  // highlight slot は replaceMarkedFieldsBySlot 相当
  if (highlightReplacements.size > 0) {
    docXml = applyHighlightReplacementsDocx(docXml, highlightReplacements);
  }

  // insert で増えた複製ブロックの★…★を埋める (XML 上の <w:t> 内テキストで find → replaceWith)
  for (const r of literalReplacements) {
    docXml = (docXml as string).split(xmlEscape(r.find)).join(xmlEscape(r.replaceWith));
  }

  // 仕上げ: 残ったハイライト・赤フォント・コメント関連を除去
  docXml = (docXml as string)
    .replace(/<w:highlight\s+w:val="[^"]*"\s*\/>/g, "")
    .replace(/<w:color\s+w:val="FF0000"\s*\/>/gi, "")
    .replace(/<w:commentRangeStart\s+w:id="\d+"\s*\/>/g, "")
    .replace(/<w:commentRangeEnd\s+w:id="\d+"\s*\/>/g, "")
    .replace(/<w:commentReference\s+w:id="\d+"\s*\/>/g, "");

  zip.file("word/document.xml", docXml);

  // comments.xml と関連 rels を片付ける (空コメントが Word で警告を出すため)
  if (zip.file("word/comments.xml")) {
    zip.remove("word/comments.xml");
    const relsXml = zip.file("word/_rels/document.xml.rels")?.asText();
    if (relsXml) {
      const cleanedRels = relsXml.replace(/<Relationship[^>]*\bType="[^"]*comments[^"]*"[^>]*\/>/g, "");
      zip.file("word/_rels/document.xml.rels", cleanedRels);
    }
  }

  return { buffer: zip.generate({ type: "nodebuffer" }), applied: dedupe(applied), skipped };
}

// 段落範囲 (anchor 段落 〜 endAnchor 段落の直前まで) を削除
function deleteParagraphRangeDocx(
  docXml: string,
  anchor: string,
  endAnchor: string | undefined,
): { ok: true; xml: string } | { ok: false; reason: string } {
  const paragraphs = enumerateTopLevelParagraphs(docXml);
  const anchorIdx = paragraphs.findIndex(p => p.text.includes(anchor));
  if (anchorIdx < 0) return { ok: false, reason: `anchor "${anchor}" を含む段落が見つからず` };
  let endIdx = paragraphs.length; // exclusive
  if (endAnchor) {
    for (let i = anchorIdx + 1; i < paragraphs.length; i++) {
      if (paragraphs[i].text.includes(endAnchor)) {
        endIdx = i;
        break;
      }
    }
    if (endIdx === paragraphs.length) {
      return { ok: false, reason: `endAnchor "${endAnchor}" が anchor 以降に見つからず (末尾全削除を回避)` };
    }
  }
  const from = paragraphs[anchorIdx].start;
  const to = endIdx === paragraphs.length
    ? paragraphs[paragraphs.length - 1].end
    : paragraphs[endIdx].start;
  return { ok: true, xml: docXml.slice(0, from) + docXml.slice(to) };
}

// 既存パターン段落範囲を複製して挿入。複製ブロック内の★を埋めるのは後段の literalReplacements で。
function insertParagraphRangeDocx(
  docXml: string,
  edit: Extract<Edit, { op: "insert" }>,
): { ok: true; xml: string } | { ok: false; reason: string } {
  const paragraphs = enumerateTopLevelParagraphs(docXml);
  const copyFromIdx = paragraphs.findIndex(p => p.text.includes(edit.copyFromAnchor));
  if (copyFromIdx < 0) {
    return { ok: false, reason: `copyFromAnchor "${edit.copyFromAnchor}" が見つからず` };
  }
  let copyToIdx = copyFromIdx;
  for (let i = copyFromIdx; i < paragraphs.length; i++) {
    if (paragraphs[i].text.includes(edit.copyFromEndAnchor)) {
      copyToIdx = i;
      break;
    }
  }
  if (copyToIdx < copyFromIdx) {
    return { ok: false, reason: `copyFromEndAnchor "${edit.copyFromEndAnchor}" が見つからず` };
  }
  const blockXml = docXml.slice(paragraphs[copyFromIdx].start, paragraphs[copyToIdx].end);

  const insertAfterIdx = paragraphs.findIndex(p => p.text.includes(edit.insertAfterAnchor));
  if (insertAfterIdx < 0) {
    return { ok: false, reason: `insertAfterAnchor "${edit.insertAfterAnchor}" が見つからず` };
  }
  const insertPos = paragraphs[insertAfterIdx].end;

  // 複製ブロックをそのまま挿入。中の★を埋めるのは後段の literalReplacements で処理。
  // ただし「同じ insert を 2 回」(取締役 2 名分など) のケースは、replaces で個別の find/replaceWith を
  // 与えれば 1 回の insert で良い (find は ★ラベル★ なので、複製後の同じラベルにも当たる)。
  // 複数ユニット追加したい場合は複数の insert を発行してもらう想定。
  return { ok: true, xml: docXml.slice(0, insertPos) + blockXml + docXml.slice(insertPos) };
}

// docx のハイライト run 群を slotId 単位で値で書き換える
function applyHighlightReplacementsDocx(docXml: string, replacements: Map<number, string>): string {
  const paragraphRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let slotId = 0;
  let out = "";
  let lastEnd = 0;
  let pm: RegExpExecArray | null;
  while ((pm = paragraphRe.exec(docXml)) !== null) {
    out += docXml.slice(lastEnd, pm.index);
    let pXml = pm[0];

    // 段落内のラン分割
    const parts: { type: "other" | "run"; content: string; highlighted?: boolean }[] = [];
    const runRe = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
    let rm: RegExpExecArray | null;
    let plast = 0;
    while ((rm = runRe.exec(pXml)) !== null) {
      if (rm.index > plast) parts.push({ type: "other", content: pXml.slice(plast, rm.index) });
      const hl = /<w:highlight\s+w:val="[^"]*"\s*\/>/.test(rm[0]) || /<w:color\s+w:val="FF0000"\s*\/>/i.test(rm[0]);
      parts.push({ type: "run", content: rm[0], highlighted: hl });
      plast = rm.index + rm[0].length;
    }
    if (plast < pXml.length) parts.push({ type: "other", content: pXml.slice(plast) });

    type Group = { startIdx: number; endIdx: number; slotId: number };
    const groups: Group[] = [];
    const isMetaOnly = (s: string) =>
      s.replace(/<w:bookmark(?:Start|End)\b[^>]*\/>/g, "")
       .replace(/<w:commentRange(?:Start|End)\b[^>]*\/>/g, "")
       .replace(/<w:commentReference\b[^>]*\/>/g, "")
       .replace(/<w:proofErr\b[^>]*\/>/g, "")
       .trim() === "";
    let i = 0;
    while (i < parts.length) {
      if (parts[i].type === "run" && parts[i].highlighted) {
        const startIdx = i;
        let lastHl = i;
        while (i < parts.length) {
          if (parts[i].type === "run" && parts[i].highlighted) { lastHl = i; i++; }
          else if (parts[i].type === "other" && isMetaOnly(parts[i].content)) { i++; }
          else break;
        }
        groups.push({ startIdx, endIdx: lastHl, slotId: slotId++ });
      } else {
        i++;
      }
    }

    for (let g = groups.length - 1; g >= 0; g--) {
      const group = groups[g];
      const newVal = replacements.get(group.slotId);
      if (newVal === undefined) continue;
      const escNew = xmlEscape(newVal);
      for (let j = group.endIdx; j >= group.startIdx; j--) {
        if (j === group.startIdx) {
          let r = parts[j].content;
          r = r.replace(/<w:highlight\s+w:val="[^"]*"\s*\/>/g, "");
          r = r.replace(/<w:color\s+w:val="FF0000"\s*\/>/gi, "");
          r = r.replace(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g, `<w:t xml:space="preserve">${escNew}</w:t>`);
          parts[j] = { ...parts[j], content: r };
        } else if (parts[j].type === "run" && parts[j].highlighted) {
          parts.splice(j, 1);
        }
      }
    }
    pXml = parts.map(p => p.content).join("");
    out += pXml;
    lastEnd = pm.index + pm[0].length;
  }
  out += docXml.slice(lastEnd);
  return out;
}

// トップレベルの <w:p> を列挙
function enumerateTopLevelParagraphs(docXml: string): { start: number; end: number; text: string }[] {
  const result: { start: number; end: number; text: string }[] = [];
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(docXml)) !== null) {
    const inner = m[0].replace(/<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g, "");
    const texts: string[] = [];
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(inner)) !== null) texts.push(decodeXml(tm[1]));
    result.push({ start: m.index, end: m.index + m[0].length, text: texts.join("") });
  }
  return result;
}

const dedupe = (arr: number[]): number[] => Array.from(new Set(arr)).sort((a, b) => a - b);

// -----------------------------------------------------------------------------
// xlsx 適用
// -----------------------------------------------------------------------------

function applyEditsXlsx(
  buffer: Buffer,
  normalized: NormalizedTemplate,
  edits: Edit[],
): EditApplyResult {
  const applied: number[] = [];
  const skipped: { index: number; reason: string }[] = [];

  // xlsx は replace のみ (delete/insert は将来拡張)
  const highlightReplacements = new Map<number, string>();
  const placeholderReplacements: { placeholder: string; value: string }[] = [];

  for (let idx = 0; idx < edits.length; idx++) {
    const edit = edits[idx];
    if (edit.op !== "replace") {
      if (edit.op === "delete") {
        skipped.push({ index: idx, reason: "xlsx の delete は未実装" });
      } else if (edit.op === "insert") {
        skipped.push({ index: idx, reason: "xlsx の insert は expandYellowRowBlock で別途対応 (現状未実装)" });
      }
      continue;
    }
    const refs = normalized.markerToSlots.get(edit.find);
    if (!refs || refs.length === 0) {
      skipped.push({ index: idx, reason: `find "${edit.find}" がテンプレ本文の ★…★ に存在せず` });
      continue;
    }
    let any = false;
    for (const ref of refs) {
      if (ref.kind === "xlsx-highlight") {
        highlightReplacements.set(ref.slotId, edit.replaceWith);
        any = true;
      } else if (ref.kind === "xlsx-placeholder") {
        placeholderReplacements.push({ placeholder: ref.placeholder, value: edit.replaceWith });
        any = true;
      }
    }
    if (any) applied.push(idx);
    else skipped.push({ index: idx, reason: `find "${edit.find}" は docx 用 ref のみで xlsx で適用先なし` });
  }

  let currentBuffer = buffer;
  if (highlightReplacements.size > 0) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { replaceXlsxMarkedCellsBySlot } = require("./xlsx-marker-parser");
    currentBuffer = replaceXlsxMarkedCellsBySlot(currentBuffer, highlightReplacements);
  }

  if (placeholderReplacements.length > 0) {
    const zip = new PizZip(currentBuffer);
    const ss = zip.file("xl/sharedStrings.xml")?.asText();
    if (ss) {
      let newSs = ss;
      for (const r of placeholderReplacements) {
        const candidates = [
          `【${r.placeholder}】`, `{{${r.placeholder}}}`,
          `｛｛${r.placeholder}｝｝`, `＜${r.placeholder}＞`, `［${r.placeholder}］`,
        ];
        for (const c of candidates) {
          newSs = newSs.split(c).join(xmlEscape(r.value));
        }
      }
      zip.file("xl/sharedStrings.xml", newSs);
      currentBuffer = zip.generate({ type: "nodebuffer" });
    }
  }

  return { buffer: currentBuffer, applied: dedupe(applied), skipped };
}
