// edit-engine.ts
//
// AI が出した 3 種類の edit (delete / modify / insert) を docx/xlsx Buffer に適用する
// インタプリタ。
//
// AI 視野には ★ラベル★ しか出さない。slot 番号、件数検証 (expectedMatches)、
// 文脈ヒント (contextBefore/After)、フォールバック保険等は持たない。失敗したら
// `skipped[]` に理由を入れて返すだけ。再試行は check ステージで AI に追加 edit を
// 出してもらう。
//
// 入力:
//   - buffer: テンプレ docx/xlsx の元バイト列
//   - normalized: template-normalize.ts が生成した SlotIndex (★ラベル → 物理位置群)
//   - edits: AI が返した編集オペレーション配列
// 出力:
//   - buffer: 編集適用後の docx/xlsx
//   - applied: 適用できた edit のインデックス
//   - skipped: 適用できなかった edit と理由
//
// 既存の proofread-edits.ts (delete-section), docx-marker-parser.ts (replaceMarkedFieldsBySlot),
// xlsx-marker-parser.ts (replaceXlsxMarkedCellsBySlot, expandYellowRowBlock) のロジックは
// 部分的に内部で流用するが、新規実装側で完結する。

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
      op: "modify";
      slotKey: string;       // ★ラベル★ の中身 (★は付けない)
      value: string;
      reason?: string;
    }
  | {
      op: "insert";
      // 複製元: anchor 段落から endAnchor 段落 (両端含む) までを 1 ユニットとして扱う
      copyFromAnchor: string;
      copyFromEndAnchor: string;
      // 挿入先: insertAfterAnchor を含む段落の直後に複製を貼る
      insertAfterAnchor: string;
      // 各複製の中の ★ラベル★ を埋める値リスト。fills の要素数だけユニットが複製される
      fills: { slotKey: string; value: string }[];
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

  // 順番: delete → insert → modify の順で適用すると安全。
  //   delete: 不要範囲を先に消す
  //   insert: 残った既存ユニットを複製
  //   modify: 各 slot に値を流し込む (このときに insert で増えた slot も埋める)
  // ただし insert で増えた slot の SlotRef は modify 適用までに更新する必要がある。
  // 単純化のため insert 時に「fills を直接埋めた段落 XML」を生成して挿入することにし、
  // SlotRef の追加更新は不要にする。

  const deleteEdits: { idx: number; edit: Extract<Edit, { op: "delete" }> }[] = [];
  const insertEdits: { idx: number; edit: Extract<Edit, { op: "insert" }> }[] = [];
  const modifyEdits: { idx: number; edit: Extract<Edit, { op: "modify" }> }[] = [];
  edits.forEach((edit, idx) => {
    if (edit.op === "delete") deleteEdits.push({ idx, edit });
    else if (edit.op === "insert") insertEdits.push({ idx, edit });
    else if (edit.op === "modify") modifyEdits.push({ idx, edit });
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
    const res = insertParagraphRangeDocx(docXml, edit, normalized);
    if (res.ok) {
      docXml = res.xml;
      applied.push(idx);
    } else {
      skipped.push({ index: idx, reason: res.reason });
    }
  }

  // ----- modify: 各 slot に値を流し込む -----
  // 同じ slotKey に対して複数 SlotRef があれば、全 ref に同じ値を書き込む。
  // docx-highlight: slot 番号で一括置換 (replaceMarkedFieldsBySlot 相当を内蔵)
  // docx-placeholder: テキスト直接置換
  const highlightReplacements = new Map<number, string>();
  const placeholderReplacements: { placeholder: string; value: string; openClose: [string, string] }[] = [];

  for (const { idx, edit } of modifyEdits) {
    const refs = normalized.labelToSlots.get(edit.slotKey);
    if (!refs || refs.length === 0) {
      // 削除済みブロック内の slot を埋めようとした等の理由でラベルが消えていることもある (= 想定通り)
      skipped.push({ index: idx, reason: `slotKey "${edit.slotKey}" がテンプレに存在せず (削除済み等)` });
      continue;
    }
    let anyMatch = false;
    for (const ref of refs) {
      if (ref.kind === "docx-highlight") {
        highlightReplacements.set(ref.slotId, edit.value);
        anyMatch = true;
      } else if (ref.kind === "docx-placeholder") {
        placeholderReplacements.push({ placeholder: ref.placeholder, value: edit.value, openClose: ref.openClose });
        anyMatch = true;
      }
    }
    if (anyMatch) applied.push(idx);
    else skipped.push({ index: idx, reason: `slotKey "${edit.slotKey}" は xlsx 用 ref のみで docx で適用先なし` });
  }

  // placeholder は単純な text 置換 (XML 内の【foo】等を全部) を先に
  for (const r of placeholderReplacements) {
    const [open, close] = r.openClose;
    const target = `${open}${r.placeholder}${close}`;
    // XML 中に直接書かれてる前提で、xmlEscape された value を流し込む
    docXml = (docXml as string).split(target).join(xmlEscape(r.value));
  }

  // highlight slot は replaceMarkedFieldsBySlot 相当の処理
  if (highlightReplacements.size > 0) {
    docXml = applyHighlightReplacementsDocx(docXml, highlightReplacements);
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

// 既存パターン段落範囲を複製して挿入
function insertParagraphRangeDocx(
  docXml: string,
  edit: Extract<Edit, { op: "insert" }>,
  normalized: NormalizedTemplate,
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

  // fills 各エントリごとに blockXml を 1 度ずつ複製し、その中の★ラベルを fills の値で
  // 個別に置換する。fills が空なら何もしない。
  // 各複製ブロックでは、複製テンプレ内のハイライト run の <w:t> 内のテキストを直接書き換える。
  // SlotRef は元テンプレ基準なので使えない。代わりに「ハイライト run の表示テキスト
  // = labels.json のラベル相当」と仮定して text 単純置換する。
  // ただし fills の slotKey は ★ラベル★ の中身。複製ブロックには ★ がそのまま入っているわけではないので、
  // 元テンプレの SlotRef で参照されている「同じ段落範囲内の slot」のラベルから originalValue を求める。

  // 段落範囲内の slot を集める (順序保存)
  const refsInBlock: { ref: SlotRef; label: string }[] = [];
  for (const [label, refs] of normalized.labelToSlots) {
    for (const ref of refs) {
      if (ref.kind !== "docx-highlight") continue;
      // この slot が段落範囲に含まれるかどうかは、走査順 (slotId 昇順) と
      // 段落の slotId 範囲を別途求めるのが筋。簡易には originalValue が blockXml に出現するか判定。
      if (blockXml.includes(xmlEscape(ref.originalValue)) || blockXml.includes(ref.originalValue)) {
        refsInBlock.push({ ref, label });
      }
    }
  }

  const dupBlocks: string[] = [];
  for (const fillSet of edit.fills) {
    let dup = blockXml;
    // 一度の複製で fillSet.slotKey 1 件分しか埋まらないので、fills 全部を 1 つの fillSet オブジェクトに集約する
    // ……というのは insert の仕様にバグがある。型を変えるべき。
    // 簡易対応: fillSet が「slotKey → value 単発」ではなく、複数 slot の値を持つオブジェクトを想定して
    // 実は { slotKey, value }[] でなく { [slotKey]: value } で来るのが正しい。
    // 今は単発エントリだけ対応 (1 fill = 1 slot 埋め)。複数 slot のユニットは insert を複数回呼んで対応。
    const target = `★${fillSet.slotKey}★`;
    // blockXml には ★ラベル★ ではなく原 XML が入っているので、SlotRef の originalValue を探して置換
    // 残念ながら ★ 表現の検索置換はできない。fillSet の slotKey から refsInBlock を引いて、originalValue で置換する。
    const ref = refsInBlock.find(r => r.label === fillSet.slotKey);
    if (ref) {
      const original = ref.ref.kind === "docx-highlight" ? ref.ref.originalValue : "";
      if (original) {
        const escOld = xmlEscape(original);
        const escNew = xmlEscape(fillSet.value);
        // ハイライト run の <w:t> 内に original があるはずなので XML レベルで置換
        dup = dup.split(escOld).join(escNew);
      }
    } else {
      // ラベルが見つからなくても XML の ★target★ パターン (placeholder 系) を試行
      dup = dup.split(target).join(xmlEscape(fillSet.value));
    }
    dupBlocks.push(dup);
  }
  if (dupBlocks.length === 0) {
    return { ok: false, reason: "fills が空のため複製対象なし" };
  }

  const insertContent = dupBlocks.join("");
  return { ok: true, xml: docXml.slice(0, insertPos) + insertContent + docXml.slice(insertPos) };
}

// docx のハイライト run 群を slotId 単位で値で書き換える
// (docx-marker-parser.ts の replaceMarkedFieldsBySlot の挙動をここに集約)
function applyHighlightReplacementsDocx(docXml: string, replacements: Map<number, string>): string {
  // <mc:AlternateContent> 内の偽 <w:p> は無視する必要があるが、簡略のため stripAlternateContent
  // 風に除去せず正規表現で全段落を走査する。実テンプレで問題が出たら強化する。
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

    // ハイライトグループを連続走査
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

    // 後ろから適用
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

// トップレベルの <w:p> を列挙 (テキストボックス内 <w:p> は親段落の一部として扱う)
function enumerateTopLevelParagraphs(docXml: string): { start: number; end: number; text: string }[] {
  // 簡易版: <w:p> ... </w:p> をフラットに enumerate。テキストボックス内の <w:p> は親に含まれるが、
  // 検索目的なら問題ない (大抵 anchor は親段落のテキストに存在する)。
  const result: { start: number; end: number; text: string }[] = [];
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(docXml)) !== null) {
    // テキスト抽出 (子の <w:t> を集める)
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

  // xlsx は処理が重いので、modify (主要操作) だけ確実に。delete/insert は将来拡張。
  // modify を集約してから replaceXlsxMarkedCellsBySlot 相当を流用する。
  const highlightReplacements = new Map<number, string>();
  const placeholderReplacements: { placeholder: string; value: string }[] = [];

  for (let idx = 0; idx < edits.length; idx++) {
    const edit = edits[idx];
    if (edit.op !== "modify") {
      if (edit.op === "delete") {
        skipped.push({ index: idx, reason: "xlsx の delete はまだ未実装 (delete-row 拡張で対応予定)" });
      } else if (edit.op === "insert") {
        skipped.push({ index: idx, reason: "xlsx の insert は expandYellowRowBlock で別途対応 (現状未実装)" });
      }
      continue;
    }
    const refs = normalized.labelToSlots.get(edit.slotKey);
    if (!refs || refs.length === 0) {
      skipped.push({ index: idx, reason: `slotKey "${edit.slotKey}" がテンプレに存在せず` });
      continue;
    }
    let any = false;
    for (const ref of refs) {
      if (ref.kind === "xlsx-highlight") {
        highlightReplacements.set(ref.slotId, edit.value);
        any = true;
      } else if (ref.kind === "xlsx-placeholder") {
        placeholderReplacements.push({ placeholder: ref.placeholder, value: edit.value });
        any = true;
      }
    }
    if (any) applied.push(idx);
    else skipped.push({ index: idx, reason: `slotKey "${edit.slotKey}" は docx 用 ref のみで xlsx で適用先なし` });
  }

  let currentBuffer = buffer;
  if (highlightReplacements.size > 0) {
    // 既存の replaceXlsxMarkedCellsBySlot を流用
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { replaceXlsxMarkedCellsBySlot } = require("./xlsx-marker-parser");
    currentBuffer = replaceXlsxMarkedCellsBySlot(currentBuffer, highlightReplacements);
  }

  // sharedStrings.xml 内の単純 placeholder 置換 (Excel)
  if (placeholderReplacements.length > 0) {
    const zip = new PizZip(currentBuffer);
    const ss = zip.file("xl/sharedStrings.xml")?.asText();
    if (ss) {
      let newSs = ss;
      for (const r of placeholderReplacements) {
        // 5 種類のオープン/クローズで試行
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
