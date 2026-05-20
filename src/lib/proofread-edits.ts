// proofread-edits.ts
// AI が校正モード (1回目 produce 後の修正パス) で出力する「edit list」を docx/xlsx に
// 適用するユーティリティ。
//
// edit のタイプ:
//   replace        : ある文字列を別の文字列に置換 (docx は <w:t> 内、xlsx は <t>/数値セル内)
//   delete-paragraph: アンカー文字列を含む段落 (<w:p>) を丸ごと削除 (docx 専用)
//   delete-row     : アンカー文字列を含む行を削除 (xlsx 専用)
//
// 設計方針:
//   - 書式 (太字・インデント・表構造・フォント色) を保つために XML 直接操作 (一括書き換え)
//   - 「<w:t> や <t> の中の文字列だけ」を対象に置換し、XML タグは触らない
//   - 段落削除は <w:p>...</w:p> 単位で削除 (Word 上で「行ごと削除」の自然な動作)
//   - 行削除は <row>...</row> 単位で削除し、後続行の r="N" を 1 ずつ詰める

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

export type ProofreadEdit =
  | { type: "replace"; old: string; new: string }
  | { type: "delete-paragraph"; anchor: string }
  | { type: "delete-row"; anchor: string };

export interface EditApplyResult {
  /** 適用された edit のインデックス */
  applied: number[];
  /** 適用できなかった edit のインデックス + 理由 */
  skipped: { index: number; reason: string }[];
  /** 修正後の docx/xlsx Buffer */
  buffer: Buffer;
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const decodeXml = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/**
 * docx に edit list を適用する。
 *
 * 仕組み:
 *   - replace: word/document.xml 内の <w:t> 要素のテキスト直接置換 (同一 <w:t> 内に検索文字列が
 *     収まってる場合)。同一段落内で <w:t> をまたぐケースは段落単位で結合してから置換し、
 *     最初の <w:t> に結果をまとめて入れる (書式は最初の run に統合される)
 *   - delete-paragraph: 段落内の結合テキストがアンカーを含む最初の <w:p>...</w:p> を削除
 */
export function applyProofreadEditsDocx(buffer: Buffer, edits: ProofreadEdit[]): EditApplyResult {
  const zip = new PizZip(buffer);
  let docXml = zip.file("word/document.xml")?.asText();
  if (!docXml) {
    return {
      applied: [],
      skipped: edits.map((_, i) => ({ index: i, reason: "document.xml が見つかりません" })),
      buffer,
    };
  }

  const applied: number[] = [];
  const skipped: { index: number; reason: string }[] = [];

  edits.forEach((edit, idx) => {
    if (edit.type === "replace") {
      const { old, new: newVal } = edit;
      if (!old) { skipped.push({ index: idx, reason: "old が空" }); return; }
      const oldEsc = xmlEscape(old);
      const newEsc = xmlEscape(newVal);
      let changed = false;
      const before = docXml as string;

      // ① 単一 <w:t> 内に old がそのまま入ってる単純ケース
      docXml = (docXml as string).replace(
        /<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g,
        (whole: string, attrs: string, inner: string) => {
          if (!inner.includes(oldEsc)) return whole;
          changed = true;
          const safeAttrs = /\bxml:space=/.test(attrs) ? attrs : ` xml:space="preserve"${attrs}`;
          return `<w:t${safeAttrs}>${inner.split(oldEsc).join(newEsc)}</w:t>`;
        }
      );

      // ② 段落をまたいだ run 分断対応: 段落単位でテキスト結合 → ヒットしたら最初の <w:t> に統合
      if (!changed) {
        docXml = (docXml as string).replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (pXml: string) => {
          const tTexts: string[] = [];
          let mTxt: RegExpExecArray | null;
          const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
          while ((mTxt = tRe.exec(pXml)) !== null) tTexts.push(mTxt[1]);
          const combined = tTexts.join("");
          if (!combined.includes(oldEsc)) return pXml;
          const replaced = combined.split(oldEsc).join(newEsc);
          let first = true;
          changed = true;
          return pXml.replace(/<w:t\b([^>]*)>[\s\S]*?<\/w:t>/g, (_m: string, attrs: string) => {
            if (first) {
              first = false;
              const safeAttrs = /\bxml:space=/.test(attrs) ? attrs : ` xml:space="preserve"${attrs}`;
              return `<w:t${safeAttrs}>${replaced}</w:t>`;
            }
            return `<w:t${attrs}></w:t>`;
          });
        });
      }

      if (changed) {
        applied.push(idx);
      } else {
        docXml = before;
        skipped.push({ index: idx, reason: `"${old}" が文書内に見つからず` });
      }
      return;
    }

    if (edit.type === "delete-paragraph") {
      const { anchor } = edit;
      if (!anchor) { skipped.push({ index: idx, reason: "anchor が空" }); return; }
      const anchorEsc = xmlEscape(anchor);
      let deleted = false;
      docXml = (docXml as string).replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (pXml: string) => {
        if (deleted) return pXml;
        const tTexts: string[] = [];
        let mTxt: RegExpExecArray | null;
        const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
        while ((mTxt = tRe.exec(pXml)) !== null) tTexts.push(decodeXml(mTxt[1]));
        const combined = tTexts.join("");
        if (combined.includes(anchor) || combined.includes(anchorEsc)) {
          deleted = true;
          return ""; // 段落丸ごと削除
        }
        return pXml;
      });
      if (deleted) applied.push(idx);
      else skipped.push({ index: idx, reason: `anchor "${anchor}" を含む段落が見つからず` });
      return;
    }

    skipped.push({ index: idx, reason: `${edit.type} は docx で未対応` });
  });

  zip.file("word/document.xml", docXml);
  return { applied, skipped, buffer: zip.generate({ type: "nodebuffer" }) };
}

/** sharedStrings の各 <si> の plain text を取り出す */
function getSiText(siInner: string): string {
  const stripped = siInner
    .replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")
    .replace(/<phoneticPr\b[^>]*\/>/g, "");
  const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let text = "";
  let tm: RegExpExecArray | null;
  while ((tm = tRe.exec(stripped)) !== null) text += tm[1];
  return decodeXml(text);
}

/**
 * xlsx に edit list を適用する。
 *
 * 仕組み:
 *   - replace: sharedStrings.xml の <si> 内テキスト + 数値セル <v> を置換 (書式維持)
 *   - delete-row: 行内のいずれかのセルがアンカーを含む <row> を削除し、後続行をシフト
 */
export function applyProofreadEditsXlsx(buffer: Buffer, edits: ProofreadEdit[]): EditApplyResult {
  const zip = new PizZip(buffer);

  const applied: number[] = [];
  const skipped: { index: number; reason: string }[] = [];

  // Step 1: replace
  edits.forEach((edit, idx) => {
    if (edit.type !== "replace") return;
    const { old, new: newVal } = edit;
    if (!old) { skipped.push({ index: idx, reason: "old が空" }); return; }
    let changed = false;

    // sharedStrings 内
    const ssXml = zip.file("xl/sharedStrings.xml")?.asText();
    if (ssXml) {
      let newSs = ssXml;
      newSs = newSs.replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, (whole: string, siInner: string) => {
        const text = getSiText(siInner);
        if (!text.includes(old)) return whole;
        const replacedText = text.split(old).join(newVal);
        changed = true;
        // <r> 構造があれば最初の <r><t> にまとめ、残りの <r><t> は空に
        if (/<r\b/.test(siInner)) {
          let first = true;
          const modified = siInner.replace(/<r\b[^>]*>[\s\S]*?<\/r>/g, (rWhole: string) => {
            if (!first) {
              return rWhole.replace(/<t\b[^>]*>[\s\S]*?<\/t>/, "<t></t>");
            }
            first = false;
            return rWhole.replace(/(<t\b[^>]*>)[\s\S]*?(<\/t>)/, `$1${xmlEscape(replacedText)}$2`);
          });
          return `<si>${modified}</si>`;
        }
        // 単一 <t>
        return `<si><t xml:space="preserve">${xmlEscape(replacedText)}</t></si>`;
      });
      if (changed) zip.file("xl/sharedStrings.xml", newSs);
    }

    // 数値セル <v> 直接置換 (t="s" 以外)
    for (const fn of Object.keys(zip.files)) {
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fn)) continue;
      const orig = zip.file(fn)?.asText();
      if (!orig) continue;
      let sheetChanged = false;
      const updated = orig.replace(
        /<c\b([^>]*)>([\s\S]*?)<\/c>/g,
        (whole: string, attrs: string, inner: string) => {
          if (/\bt="s"/.test(attrs)) return whole; // 共有文字列は上で処理済み
          const vMatch = inner.match(/<v>([^<]*)<\/v>/);
          if (!vMatch) return whole;
          const val = vMatch[1];
          if (!val.includes(old)) return whole;
          sheetChanged = true;
          const newCellVal = val.split(old).join(newVal);
          return `<c${attrs}>${inner.replace(/<v>[^<]*<\/v>/, `<v>${newCellVal}</v>`)}</c>`;
        }
      );
      if (sheetChanged) {
        zip.file(fn, updated);
        changed = true;
      }
    }

    if (changed) applied.push(idx);
    else skipped.push({ index: idx, reason: `"${old}" がブック内に見つからず` });
  });

  // Step 2: delete-row
  edits.forEach((edit, idx) => {
    if (edit.type !== "delete-row") return;
    const { anchor } = edit;
    if (!anchor) { skipped.push({ index: idx, reason: "anchor が空" }); return; }

    // sharedStrings をテキスト化
    const ssNow = zip.file("xl/sharedStrings.xml")?.asText();
    const shared: string[] = [];
    if (ssNow) {
      const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
      let m: RegExpExecArray | null;
      while ((m = siRe.exec(ssNow)) !== null) {
        shared.push(getSiText(m[1]));
      }
    }

    let foundAnywhere = false;
    for (const fn of Object.keys(zip.files)) {
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fn)) continue;
      const orig = zip.file(fn)?.asText();
      if (!orig) continue;
      let deletedRowNum = -1;

      // 行を 1 つだけ削除 (誤削除防止)
      let sx = orig.replace(/<row\b([^>]*\br="(\d+)"[^>]*)>([\s\S]*?)<\/row>/g, (whole: string, _rowAttrs: string, rowNumStr: string, rowInner: string) => {
        if (deletedRowNum >= 0) return whole;
        // 行内の全セル値を取り出して anchor を含むかチェック
        const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let cm: RegExpExecArray | null;
        let rowText = "";
        while ((cm = cellRe.exec(rowInner)) !== null) {
          const attrs = cm[1];
          const inner = cm[2] || "";
          const vMatch = inner.match(/<v>([^<]*)<\/v>/);
          if (!vMatch) continue;
          const tMatch = attrs.match(/\bt="([^"]*)"/);
          if (tMatch?.[1] === "s") {
            const idx2 = parseInt(vMatch[1]);
            rowText += (shared[idx2] || "") + " ";
          } else {
            rowText += vMatch[1] + " ";
          }
        }
        if (rowText.includes(anchor)) {
          deletedRowNum = parseInt(rowNumStr);
          return "";
        }
        return whole;
      });

      if (deletedRowNum >= 0) {
        // 後続行の r="N" を 1 デクリメント
        sx = sx.replace(/<row\b([^>]*)\br="(\d+)"([^>]*)>/g, (whole: string, p1: string, nStr: string, p3: string) => {
          const num = parseInt(nStr);
          if (num > deletedRowNum) return `<row${p1}r="${num - 1}"${p3}>`;
          return whole;
        });
        sx = sx.replace(/\br="([A-Z]+)(\d+)"/g, (whole: string, col: string, nStr: string) => {
          const num = parseInt(nStr);
          if (num > deletedRowNum) return `r="${col}${num - 1}"`;
          return whole;
        });
        sx = sx.replace(/<mergeCell\s+ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g, (_m: string, c1: string, n1: string, c2: string, n2: string) => {
          const r1 = parseInt(n1);
          const r2 = parseInt(n2);
          const nr1 = r1 > deletedRowNum ? r1 - 1 : r1;
          const nr2 = r2 > deletedRowNum ? r2 - 1 : r2;
          return `<mergeCell ref="${c1}${nr1}:${c2}${nr2}"`;
        });
        zip.file(fn, sx);
        foundAnywhere = true;
      }
    }

    if (foundAnywhere) applied.push(idx);
    else skipped.push({ index: idx, reason: `anchor "${anchor}" を含む行が見つからず` });
  });

  return { applied, skipped, buffer: zip.generate({ type: "nodebuffer" }) };
}
