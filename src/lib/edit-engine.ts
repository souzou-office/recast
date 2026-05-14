// edit-engine.ts
//
// AI が出した 3 種類の edit (delete / replace / insert) を docx/xlsx Buffer に適用する
// インタプリタ。
//
// 設計判断:
//   - AI 視野には「★ラベル★ という識別子」を見せず、「テンプレ本文中の★…★文字列をリテラル
//     引用してもらう」設計 (旧 `modify` を `replace` に置換)。
//   - slotId の割り振りは `walkDocxSlots` という共通関数に集約。template-normalize.ts も
//     同じ関数を使うので、AI に渡す ★ラベル★ と、サーバーが書き換える物理位置の
//     対応関係が**原理的に保証**される。旧設計では両者が別実装で slotId がズレる事故が
//     起きていた (テキストボックス含むテンプレで「全く違うところに全く違う値が入る」)。

import type { NormalizedTemplate } from "./template-normalize";
import { walkDocxSlots, type RunPart } from "./docx-slot-walker";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// AI が返す edit プリミティブ。3 種類だけ。
export type Edit =
  | { op: "delete"; anchor: string; endAnchor?: string; reason?: string }
  | { op: "replace"; find: string; replaceWith: string; reason?: string }
  | {
      op: "insert";
      copyFromAnchor: string;
      copyFromEndAnchor: string;
      insertAfterAnchor: string;
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
  const docXmlRaw = zip.file("word/document.xml")?.asText();
  if (!docXmlRaw) {
    return {
      buffer,
      applied: [],
      skipped: edits.map((_, i) => ({ index: i, reason: "document.xml が見つかりません" })),
    };
  }

  const applied: number[] = [];
  const skipped: { index: number; reason: string }[] = [];

  // 🔴 順番: replace → insert → delete (この順序が重要)
  //   旧: delete を先にやると docXml が変わって、replace 時に walker を再実行すると
  //       slotId が振り直されて template-normalize の markerToSlots と不一致になる
  //       → AI が出した「★同意書の日付★」が、全く別の slot 位置に書き込まれる事故
  //   新: replace を先に元 docXml の slot 位置で適用 (slotId が変わる前なので一致保証)
  //        → その後 delete で範囲削除 (slotId 不要、テキスト検索のみ)
  //        → insert は段落複製 (これも slotId 不要)
  const deleteEdits: { idx: number; edit: Extract<Edit, { op: "delete" }> }[] = [];
  const insertEdits: { idx: number; edit: Extract<Edit, { op: "insert" }> }[] = [];
  const replaceEdits: { idx: number; edit: Extract<Edit, { op: "replace" }> }[] = [];
  edits.forEach((edit, idx) => {
    if (edit.op === "delete") deleteEdits.push({ idx, edit });
    else if (edit.op === "insert") insertEdits.push({ idx, edit });
    else if (edit.op === "replace") replaceEdits.push({ idx, edit });
  });

  // walker は AlternateContent 除去版の docXml を返す。これを基準に編集する。
  let docXml = walkDocxSlots(docXmlRaw).docXml;

  // ----- replace (最初) -----
  // 各 marker (★…★) を normalize の markerToSlots で物理 slot に解決。
  // この時点では delete も insert も適用されていないので、元 docXml の slotId のまま。
  const highlightReplacements = new Map<number, string>();
  const placeholderReplacements: { placeholder: string; value: string; openClose: [string, string] }[] = [];

  for (const { idx, edit } of replaceEdits) {
    const refs = normalized.markerToSlots.get(edit.find);
    if (!refs || refs.length === 0) {
      skipped.push({ index: idx, reason: `find "${edit.find}" がテンプレ本文の ★…★ に存在せず (文字列不一致)` });
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

  // placeholder の text 置換
  for (const r of placeholderReplacements) {
    const [open, close] = r.openClose;
    const target = `${open}${r.placeholder}${close}`;
    docXml = docXml.split(target).join(xmlEscape(r.value));
  }

  // highlight slot は walker と一致した slotId で書き換え
  if (highlightReplacements.size > 0) {
    docXml = applyHighlightReplacementsDocx(docXml, highlightReplacements);
  }

  // 安全網 1: 残ったハイライト run の中身を空文字化 (前案件の値混入防止)
  docXml = clearUnreplacedHighlightRuns(docXml);
  // 安全網 2: 残ったプレースホルダーを空文字化
  docXml = clearUnreplacedPlaceholders(docXml);

  // ----- insert (replace の後、delete の前) -----
  // 複製ブロック内の ★…★ は既に値で埋まっているので、複製先で別の値にしたい時は
  // edit.replaces を使う (find/replaceWith で text 置換)。
  for (const { idx, edit } of insertEdits) {
    const res = insertParagraphRangeDocx(docXml, edit);
    if (res.ok) {
      docXml = res.xml;
      // 複製した範囲だけ literal 置換 (全体に走らせると元範囲も巻き込むので慎重に)
      // 簡略実装: docXml 全体で split-join (元範囲は既に値が入ってるので無害)
      for (const r of edit.replaces || []) {
        docXml = docXml.split(xmlEscape(r.find)).join(xmlEscape(r.replaceWith));
      }
      applied.push(idx);
    } else {
      skipped.push({ index: idx, reason: res.reason });
    }
  }

  // ----- delete (最後) -----
  // 段落範囲削除は slotId 非依存 (テキスト検索のみ) なので最後でよい。
  for (const { idx, edit } of deleteEdits) {
    const res = deleteParagraphRangeDocx(docXml, edit.anchor, edit.endAnchor);
    if (res.ok) { docXml = res.xml; applied.push(idx); }
    else skipped.push({ index: idx, reason: res.reason });
  }

  // 仕上げ: 残ったハイライト属性 / コメント関連を除去
  docXml = docXml
    .replace(/<w:highlight\s+w:val="[^"]*"\s*\/>/g, "")
    .replace(/<w:color\s+w:val="FF0000"\s*\/>/gi, "")
    .replace(/<w:commentRangeStart\s+w:id="\d+"\s*\/>/g, "")
    .replace(/<w:commentRangeEnd\s+w:id="\d+"\s*\/>/g, "")
    .replace(/<w:commentReference\s+w:id="\d+"\s*\/>/g, "");

  zip.file("word/document.xml", docXml);

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
  const { paragraphs } = walkDocxSlots(docXml);
  const anchorIdx = paragraphs.findIndex(p => p.text.includes(anchor));
  if (anchorIdx < 0) return { ok: false, reason: `anchor "${anchor}" を含む段落が見つからず` };
  let endIdx = paragraphs.length;
  if (endAnchor) {
    for (let i = anchorIdx + 1; i < paragraphs.length; i++) {
      if (paragraphs[i].text.includes(endAnchor)) { endIdx = i; break; }
    }
    if (endIdx === paragraphs.length) {
      return { ok: false, reason: `endAnchor "${endAnchor}" が anchor 以降に見つからず` };
    }
  }
  const from = paragraphs[anchorIdx].start;
  const to = endIdx === paragraphs.length ? paragraphs[paragraphs.length - 1].end : paragraphs[endIdx].start;
  return { ok: true, xml: docXml.slice(0, from) + docXml.slice(to) };
}

// 既存パターン段落範囲を複製して挿入
function insertParagraphRangeDocx(
  docXml: string,
  edit: Extract<Edit, { op: "insert" }>,
): { ok: true; xml: string } | { ok: false; reason: string } {
  const { paragraphs } = walkDocxSlots(docXml);
  const copyFromIdx = paragraphs.findIndex(p => p.text.includes(edit.copyFromAnchor));
  if (copyFromIdx < 0) return { ok: false, reason: `copyFromAnchor "${edit.copyFromAnchor}" が見つからず` };
  let copyToIdx = copyFromIdx;
  for (let i = copyFromIdx; i < paragraphs.length; i++) {
    if (paragraphs[i].text.includes(edit.copyFromEndAnchor)) { copyToIdx = i; break; }
  }
  if (copyToIdx < copyFromIdx) return { ok: false, reason: `copyFromEndAnchor "${edit.copyFromEndAnchor}" が見つからず` };
  const blockXml = docXml.slice(paragraphs[copyFromIdx].start, paragraphs[copyToIdx].end);

  const insertAfterIdx = paragraphs.findIndex(p => p.text.includes(edit.insertAfterAnchor));
  if (insertAfterIdx < 0) return { ok: false, reason: `insertAfterAnchor "${edit.insertAfterAnchor}" が見つからず` };
  const insertPos = paragraphs[insertAfterIdx].end;

  return { ok: true, xml: docXml.slice(0, insertPos) + blockXml + docXml.slice(insertPos) };
}

/**
 * docx のハイライト run 群を slotId 単位で値で書き換える。
 * walker と同じ走査で物理位置を取得し、後ろから書き換え (index ズレ防止)。
 */
function applyHighlightReplacementsDocx(docXml: string, replacements: Map<number, string>): string {
  const walk = walkDocxSlots(docXml);
  let out = walk.docXml;

  // 後ろの段落から処理 (前から処理すると後の段落の start/end がズレる)
  for (let pIdx = walk.paragraphs.length - 1; pIdx >= 0; pIdx--) {
    const para = walk.paragraphs[pIdx];
    const slotsInPara = walk.slots
      .filter(s => s.paragraphIdx === pIdx && replacements.has(s.slotId))
      .sort((a, b) => b.groupStartIdx - a.groupStartIdx); // 段落内も後ろから
    if (slotsInPara.length === 0) continue;

    // parts を mutable な配列に。後ろから書き換えていく。
    const parts: RunPart[] = para.parts.map(p => ({ ...p }));

    for (const slot of slotsInPara) {
      const newVal = replacements.get(slot.slotId);
      if (newVal === undefined) continue;
      const escNew = xmlEscape(newVal);
      // group 範囲: groupStartIdx..groupEndIdx
      // 先頭 run のテキストを新値に + 残りのハイライト run を削除
      for (let j = slot.groupEndIdx; j >= slot.groupStartIdx; j--) {
        if (j === slot.groupStartIdx) {
          if (parts[j].type !== "run") continue;
          let r = parts[j].content;
          r = r.replace(/<w:highlight\s+w:val="[^"]*"\s*\/>/g, "");
          r = r.replace(/<w:color\s+w:val="FF0000"\s*\/>/gi, "");
          r = r.replace(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g, `<w:t xml:space="preserve">${escNew}</w:t>`);
          parts[j] = { ...parts[j], content: r };
        } else if (parts[j].type === "run" && (parts[j] as { highlighted: boolean }).highlighted) {
          parts.splice(j, 1);
        }
      }
    }

    // 段落の中身を再構築 (parts を順に結合)。テキストボックス (txbxContent) は walker が
    // 除外しているので、ここで失われる。テキストボックスを使うテンプレでは要対応 (将来課題)。
    const newParaInner = parts.map(p => p.content).join("");
    const origPXml = out.slice(para.start, para.end);
    const openMatch = origPXml.match(/^<w:p\b[^>]*>/);
    const openTag = openMatch ? openMatch[0] : "<w:p>";
    const newPXml = `${openTag}${newParaInner}</w:p>`;
    out = out.slice(0, para.start) + newPXml + out.slice(para.end);
  }

  return out;
}

/**
 * 残ったハイライト run (= AI が replace し損ねた slot) の <w:t> 内テキストを空に。
 * 前案件の値が出力 docx に紛れ込むのを防ぐ。
 */
function clearUnreplacedHighlightRuns(docXml: string): string {
  return docXml.replace(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, (runXml: string) => {
    const hasHl = /<w:highlight\s+w:val="[^"]*"\s*\/>/.test(runXml) ||
                  /<w:color\s+w:val="FF0000"\s*\/>/i.test(runXml);
    if (!hasHl) return runXml;
    return runXml.replace(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g, '<w:t xml:space="preserve"></w:t>');
  });
}

/** 残った 【foo】 / {{foo}} / ｛｛foo｝｝ / ＜foo＞ / ［foo］ プレースホルダーを空文字化 */
function clearUnreplacedPlaceholders(docXml: string): string {
  let out = docXml;
  const patterns: RegExp[] = [
    /【([^】#/][^】]*)】/g,
    /\{\{([^}#/][^}]*)\}\}/g,
    /｛｛([^｝#/][^｝]*)｝｝/g,
    /＜([^＞#/][^＞]*)＞/g,
    /［([^\]\][#/][^\]\]]*)］/g,
  ];
  for (const re of patterns) out = out.replace(re, "");
  return out;
}

const dedupe = (arr: number[]): number[] => Array.from(new Set(arr)).sort((a, b) => a - b);

// -----------------------------------------------------------------------------
// xlsx 適用 (現状 replace のみ。delete/insert は未実装)
// -----------------------------------------------------------------------------

function applyEditsXlsx(
  buffer: Buffer,
  normalized: NormalizedTemplate,
  edits: Edit[],
): EditApplyResult {
  const applied: number[] = [];
  const skipped: { index: number; reason: string }[] = [];

  const highlightReplacements = new Map<number, string>();
  const placeholderReplacements: { placeholder: string; value: string }[] = [];

  for (let idx = 0; idx < edits.length; idx++) {
    const edit = edits[idx];
    if (edit.op !== "replace") {
      if (edit.op === "delete") {
        skipped.push({ index: idx, reason: "xlsx の delete は未実装" });
      } else if (edit.op === "insert") {
        skipped.push({ index: idx, reason: "xlsx の insert は未実装" });
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
        for (const c of candidates) newSs = newSs.split(c).join(xmlEscape(r.value));
      }
      zip.file("xl/sharedStrings.xml", newSs);
      currentBuffer = zip.generate({ type: "nodebuffer" });
    }
  }

  return { buffer: currentBuffer, applied: dedupe(applied), skipped };
}
