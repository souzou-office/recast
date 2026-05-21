// /api/document-templates/produce-v2
// Phase 3 = 書類生成 (完全ルールベース、AI 呼び出しなし)。
//
// 設計:
//   - Phase 2 (analyze) が出した phase2Decisions を機械的に適用するだけ
//   - 判断は一切ない。決定はすべて Phase 2 で済んでいる前提
//   - 適用順序:
//       1. textReplaces        (全文一括置換 = 議案番号繰り上げ等)
//       2. blockDeletes        (start/end anchor で範囲決定 → 該当段落を delete に展開)
//       3. slotDecisions[delete-row]  (★slot★ を含む段落を特定 → delete)
//       4. rowInsertions       (★afterSlot★ を含む段落の直後に template を挿入)
//       5. slotDecisions[fill] + rowInsertions[].fills (★label★ → 値)
//       6. unconfirmed slot は空文字 fill (マーカー残骸防止)
//
// 出力: 旧 produce 互換の { documents: DocOut[] } シェイプ

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import {
  applyProduceEditsDocx,
  applyProduceEditsXlsx,
  type ProduceEdits,
  type ParagraphActionOp,
  type InsertOp,
  type ReplaceOp,
  type FillsOp,
} from "@/lib/produce-edits";
import type { ChatThread, Phase2DocumentDecision } from "@/types";

// 旧 produce 互換の出力シェイプ
interface DocOut {
  name: string;
  fileName: string;
  docxBase64: string;
  previewHtml: string;
  templatePath?: string;
}

// markedText の "段落N:" / "行N:" 行を抽出する。
// docx: 1-indexed の連番、xlsx: Excel 行番号 (間が飛ぶことあり)。
interface NumberedLine {
  idx: number;       // paragraphIndex (docx) or row number (xlsx)
  text: string;      // ★label★ 含む元の line 本文
  labels: string[];  // この line に含まれる ★label★ のラベル名
}

function parseNumberedLines(markedText: string): NumberedLine[] {
  const out: NumberedLine[] = [];
  for (const line of markedText.split("\n")) {
    const m = line.match(/^(?:段落|行)(\d+):\s(.*)$/);
    if (!m) continue;
    const text = m[2];
    const labels = [...text.matchAll(/★([^★]+)★/g)].map((mm) => mm[1]);
    out.push({ idx: Number(m[1]), text, labels });
  }
  return out;
}

// anchor (slot 名 or 任意文字列) から段落番号を引く。
// - まず ★label★ にラベル名がマッチするかで探す (双方向 substring)
// - ★ が無い anchor (議案ヘッダー等) は line text 全体に対して部分一致で探す
function findParagraphIndex(lines: NumberedLine[], anchor: string): number | null {
  if (!anchor) return null;
  const anchorNorm = anchor.replace(/\s/g, "");
  // 1) ラベル一致
  for (const nl of lines) {
    for (const lbl of nl.labels) {
      const lblNorm = lbl.replace(/\s/g, "");
      if (anchorNorm.includes(lblNorm) || lblNorm.includes(anchorNorm)) return nl.idx;
    }
  }
  // 2) line 本文の部分一致 (★ を除外したテキストと比較)
  for (const nl of lines) {
    const textNoMarkers = nl.text.replace(/★[^★]+★/g, "").replace(/\s/g, "");
    if (textNoMarkers.includes(anchorNorm)) return nl.idx;
  }
  return null;
}

// blockDeletes の startAnchor/endAnchor から削除対象の段落番号集合を作る。
// endAnchor が見つからなければ start 以降全段落を削除対象に。
function expandBlockDelete(
  lines: NumberedLine[],
  startAnchor: string,
  endAnchor: string | undefined,
): number[] {
  const startIdx = findParagraphIndex(lines, startAnchor);
  if (startIdx === null) return [];
  // endIdx: 最初に endAnchor が出てくる段落 (startIdx より大きい)。見つからなければ最大段落+1
  let endIdx: number | null = null;
  if (endAnchor) {
    const startPos = lines.findIndex((l) => l.idx === startIdx);
    for (let i = startPos + 1; i < lines.length; i++) {
      const nl = lines[i];
      const eN = endAnchor.replace(/\s/g, "");
      const tN = nl.text.replace(/★[^★]+★/g, "").replace(/\s/g, "");
      const labelMatch = nl.labels.some((lbl) => {
        const lN = lbl.replace(/\s/g, "");
        return eN.includes(lN) || lN.includes(eN);
      });
      if (labelMatch || tN.includes(eN)) {
        endIdx = nl.idx;
        break;
      }
    }
  }
  // 範囲展開
  const result: number[] = [];
  for (const nl of lines) {
    if (nl.idx < startIdx) continue;
    if (endIdx !== null && nl.idx >= endIdx) continue;
    result.push(nl.idx);
  }
  return result;
}

export async function POST(request: NextRequest) {
  const { companyId, threadId, templateFolderPath } = (await request.json()) as {
    companyId: string;
    threadId: string;
    templateFolderPath: string;
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find((c) => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // thread から phase2Decisions を読む
  let thread: ChatThread | null = null;
  try {
    const hash = crypto.createHash("md5").update(company.id).digest("hex");
    const tpath = path.join(process.cwd(), "data", "chat-threads", hash, `${threadId}.json`);
    const raw = await fs.readFile(tpath, "utf-8");
    thread = JSON.parse(raw) as ChatThread;
  } catch (e) {
    return NextResponse.json({ error: "スレッドが読めません: " + (e instanceof Error ? e.message : e) }, { status: 500 });
  }

  const phase2Decisions = thread.phase2Decisions;
  if (!phase2Decisions || !Array.isArray(phase2Decisions.documents)) {
    return NextResponse.json({ error: "Phase 2 決定がありません。analyze を先に走らせてください" }, { status: 400 });
  }

  // テンプレファイル一覧 (docx + xlsx)
  const tpFiles = await readAllFilesInFolder(templateFolderPath);
  const targetFiles = tpFiles.filter(
    (f) => /\.(docx|docm|xlsx|xlsm|xls)$/i.test(f.name) && !f.name.endsWith(".labels.json")
  );

  if (targetFiles.length === 0) {
    return NextResponse.json({ error: "対象テンプレートが見つかりません" }, { status: 400 });
  }

  // 物理ファイル名 → ファイル情報の lookup
  const physicalByName = new Map<string, (typeof targetFiles)[number]>();
  for (const f of targetFiles) physicalByName.set(f.name, f);
  const physicalByBase = new Map<string, (typeof targetFiles)[number]>();
  for (const f of targetFiles) physicalByBase.set(f.name.replace(/\.[^.]+$/, ""), f);

  // テンプレ別に marked text を作る (★label★ 入り)
  const { getMarkedDocumentTextWithSlots } = await import("@/lib/docx-marker-parser");
  const { getXlsxMarkedTextWithSlots } = await import("@/lib/xlsx-marker-parser");
  const { ensureDocxLabels, ensureXlsxLabels } = await import("@/lib/template-labels");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mammoth = require("mammoth");

  // 出力ファイル名のサニタイズ (Windows 等で使えない文字を _ に)
  const sanitizeFsName = (s: string): string => s.replace(/[\\/:*?"<>|]/g, "_");

  // Phase 2 documents 単位でループ (株主毎複数枚に対応するため物理ファイルではなく decision でループ)
  const docOuts = await Promise.all(
    phase2Decisions.documents.map(async (decisionDoc: Phase2DocumentDecision): Promise<DocOut | null> => {
      try {
        // Phase 2 の templateFile から物理ファイルを引く
        let f = physicalByName.get(decisionDoc.templateFile)
          || physicalByBase.get(decisionDoc.templateFile.replace(/\.[^.]+$/, ""))
          || null;
        if (!f) {
          // legacy suffix 救出 (古い templateFile に "（X用）" 付いてた場合)
          const cleaned = decisionDoc.templateFile.replace(/[（(].*?[）)]\.?[^.]*$/, "")
            .replace(/[（(].*$/, "");
          f = physicalByName.get(cleaned) || physicalByBase.get(cleaned.replace(/\.[^.]+$/, "")) || null;
        }
        if (!f) {
          console.warn(`[produce-v2] 物理テンプレが見つからない: ${decisionDoc.templateFile}`);
          return null;
        }
        const buf = await fs.readFile(f.path);
        const ext = f.name.toLowerCase().split(".").pop() || "";
        const isXlsx = ext === "xlsx" || ext === "xlsm" || ext === "xls";

        // marked text + labels を取得
        let rawText = "";
        let labels = null as Awaited<ReturnType<typeof ensureDocxLabels>> | null;
        if (isXlsx) {
          const r = getXlsxMarkedTextWithSlots(buf);
          rawText = r.text;
          labels = await ensureXlsxLabels(f.path);
        } else {
          const r = getMarkedDocumentTextWithSlots(buf);
          rawText = r.text;
          labels = await ensureDocxLabels(f.path);
        }
        const labelById = new Map<number, string>();
        for (const s of labels?.slots || []) {
          if (s.label && s.label !== "不明") labelById.set(s.slotId, s.label);
        }
        const markedTextRaw = rawText.replace(/［要入力_(\d+)］/g, (_, idStr) => {
          const id = Number(idStr);
          const lbl = labelById.get(id) || `要入力_${id}`;
          return `★${lbl}★`;
        });

        // markedText を index 付きで組み立てる。docx は連番、xlsx は Excel 行番号 (r= 値)。
        let markedText = "";
        if (isXlsx) {
          // xlsx: Excel 行番号で labelled する
          const PizZip = (await import("pizzip")).default;
          const zip = new PizZip(buf);
          const sheetFiles = Object.keys(zip.files)
            .filter((fn) => /^xl\/worksheets\/sheet\d+\.xml$/.test(fn))
            .sort();
          const xlsxRowNumbers: number[] = [];
          for (const sf of sheetFiles) {
            const sheetXml = zip.file(sf)?.asText() || "";
            const rowRe = /<row\b[^>]*?r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
            let rm2;
            while ((rm2 = rowRe.exec(sheetXml)) !== null) {
              const inner = rm2[2];
              const cellRe = /<c\b[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g;
              let hasContent = false;
              let cm2;
              while ((cm2 = cellRe.exec(inner)) !== null) {
                const cellInner = cm2[1] || "";
                if (/<v>[^<]*<\/v>/.test(cellInner)) {
                  hasContent = true;
                  break;
                }
              }
              if (hasContent) xlsxRowNumbers.push(parseInt(rm2[1], 10));
            }
          }
          const cleaned = markedTextRaw.replace(/\r\n/g, " / ").replace(/\r/g, " / ");
          const lines = cleaned.split("\n");
          let rowIdx = 0;
          markedText = lines
            .map((line) => {
              if (line.trim().length === 0) return line;
              const rowNum = xlsxRowNumbers[rowIdx++] ?? rowIdx;
              return `行${rowNum}: ${line}`;
            })
            .join("\n");
        } else {
          // docx: 1-indexed 連番 (空段落 "(空)" マーカー行は除外して連番つけない)
          // (空) 行は AI 向けに構造を見せる目的のみ。engine の paragraph index は
          // 非空段落のみで連番つけて contentParagraphs と一致させる。
          let lineCounter = 0;
          markedText = markedTextRaw
            .split("\n")
            .map((line) => {
              const trimmed = line.trim();
              if (trimmed.length === 0 || trimmed === "(空)") return line;
              lineCounter++;
              return `段落${lineCounter}: ${line}`;
            })
            .join("\n");
        }

        // === Phase 2 決定を機械的に edit op に変換 ===
        const numberedLines = parseNumberedLines(markedText);

        const fills: FillsOp = {};
        const paragraphActions: ParagraphActionOp[] = [];
        const inserts: InsertOp[] = [];
        const replaces: ReplaceOp[] = [];

        // === 設計原則: xlsx は構造変更禁止、fills のみ ===
        // xlsx テンプレ (株主リスト・株主名簿・集計表等) は行構造が固定。
        // 行追加・行削除・ブロック削除をやると数式参照崩れや表構造破壊が起きるので
        // Phase 3 で defensive に skip する。Phase 2 が出しても無視。
        // ユーザーが触る価値があるのは「セルの中身 (fills)」だけ。
        //
        // 構造的に貫くために、xlsx の場合は textReplaces / blockDeletes / rowInsertions /
        // slotDecisions[delete-row] を全部 skip し、警告ログを出すだけにする。

        if (isXlsx) {
          const skipCounts = {
            textReplaces: decisionDoc.textReplaces?.length ?? 0,
            blockDeletes: decisionDoc.blockDeletes?.length ?? 0,
            rowInsertions: decisionDoc.rowInsertions?.length ?? 0,
            deleteRows: (decisionDoc.slotDecisions || []).filter((sd) => sd.action === "delete-row").length,
          };
          const totalSkipped = skipCounts.textReplaces + skipCounts.blockDeletes + skipCounts.rowInsertions + skipCounts.deleteRows;
          if (totalSkipped > 0) {
            console.warn(
              `[produce-v2] ${f.name} (xlsx): 構造変更指示を skip (` +
              `textReplaces: ${skipCounts.textReplaces}, blockDeletes: ${skipCounts.blockDeletes}, ` +
              `rowInsertions: ${skipCounts.rowInsertions}, deleteRows: ${skipCounts.deleteRows})`
            );
          }
        }

        // 1. textReplaces → replaces (docx のみ)
        if (!isXlsx) {
          for (const tr of decisionDoc.textReplaces || []) {
            if (!tr.anchor) continue;
            replaces.push({ anchor: tr.anchor, replacement: tr.replacement || "" });
          }
        }

        // 2. blockDeletes → paragraphActions[delete] を範囲展開 (docx のみ)
        const blockDeleteIndices = new Set<number>();
        if (!isXlsx) {
          for (const bd of decisionDoc.blockDeletes || []) {
            const indices = expandBlockDelete(numberedLines, bd.startAnchor, bd.endAnchor);
            if (indices.length === 0) {
              console.warn(`[produce-v2] ${f.name} blockDelete startAnchor not found: ${bd.startAnchor}`);
            }
            for (const i of indices) blockDeleteIndices.add(i);
          }
        }

        // 3. slotDecisions[delete-row] → paragraphActions[delete] (docx のみ)
        const slotDeleteIndices = new Set<number>();
        if (!isXlsx) {
          for (const sd of decisionDoc.slotDecisions || []) {
            if (sd.action !== "delete-row") continue;
            const idx = findParagraphIndex(numberedLines, sd.slot);
            if (idx === null) {
              console.warn(`[produce-v2] ${f.name} delete-row slot not found: ${sd.slot}`);
              continue;
            }
            slotDeleteIndices.add(idx);
          }
        }

        // 4. rowInsertions → inserts + fills (docx のみ。xlsx は構造変更禁止)
        //
        // 連鎖挿入対応 (重要):
        //   AI は「★前の挿入で作った新ラベル★ の直後にさらに新しい行を挿入」というパターンを
        //   出力する (例: 本店行 → afterSlot=本店 で 商号行 → afterSlot=商号 で 代表取締役行)。
        //   afterSlot が markedText の既存 slot に無くても、前段の rowInsertion の template に
        //   含まれていれば「同じ afterParagraphIndex の挿入グループの末尾」に追加扱いする。
        //
        // 実装:
        //   - rowInsertions を順に走査し、各 ri の解決済み afterParagraphIndex を riToIdx に記録
        //   - afterSlot が既存 slot で見つからなければ、過去 ri の template に含まれる ★label★
        //     をスキャンして「親 ri」を見つけ、その afterParagraphIndex を継承
        //   - 最終的に afterParagraphIndex 単位で contents をまとめて 1 InsertOp にする
        //     (engine の制約: 同位置への複数 inserts はマージ順が逆転するため)
        const riList = isXlsx ? [] : (decisionDoc.rowInsertions || []);
        const riToIdx = new Map<number, number>(); // ri 配列の index → afterParagraphIndex
        const insertsByPos = new Map<number, string[]>(); // afterParagraphIndex → contents (順序保持)
        for (let i = 0; i < riList.length; i++) {
          const ri = riList[i];
          let afterIdx = findParagraphIndex(numberedLines, ri.afterSlot);
          // 既存 slot で見つからない → 過去 ri の template に含まれるラベルかチェック (連鎖挿入)
          if (afterIdx === null) {
            for (let j = 0; j < i; j++) {
              const prevRi = riList[j];
              const labelsInPrev = [...(prevRi.template || "").matchAll(/★([^★]+)★/g)].map((m) => m[1]);
              const norm = (s: string) => s.replace(/\s/g, "");
              const targetNorm = norm(ri.afterSlot);
              const hit = labelsInPrev.some((lbl) => {
                const lN = norm(lbl);
                return targetNorm.includes(lN) || lN.includes(targetNorm);
              });
              if (hit) {
                afterIdx = riToIdx.get(j) ?? null;
                if (afterIdx !== null) break;
              }
            }
          }
          if (afterIdx === null) {
            console.warn(`[produce-v2] ${f.name} rowInsertion afterSlot not found: ${ri.afterSlot}`);
            continue;
          }
          riToIdx.set(i, afterIdx);
          const arr = insertsByPos.get(afterIdx) || [];
          arr.push(ri.template);
          insertsByPos.set(afterIdx, arr);
          for (const f0 of ri.fills || []) {
            fills[`★${f0.slot}★`] = f0.value ?? "";
          }
        }
        for (const [afterIdx, contents] of insertsByPos) {
          inserts.push({ afterParagraphIndex: afterIdx, contents });
        }

        // 5. slotDecisions[fill] → fills
        // 6. slotDecisions[unconfirmed] → fills 空文字 (マーカー残骸防止)
        for (const sd of decisionDoc.slotDecisions || []) {
          if (sd.action === "fill") {
            fills[`★${sd.slot}★`] = sd.value ?? "";
          } else if (sd.action === "unconfirmed") {
            fills[`★${sd.slot}★`] = "";
          }
        }

        // 7. Phase 2 が触らなかった ★label★ マーカーを空文字 fill で自動クリア
        //
        // 背景: xlsx (株主リスト等) では 1-10 位 の slot が事前に用意されているが、Phase 2 が
        // データを持っている上位 N 位だけ fill 指示を出す。残りの slot は触らないため、
        // applyProduceEdits の flatten 工程で書き込まれた ★label★ がそのまま残ってしまう
        // (例: ★議決権上位株主3位の氏名★ が書類本文に出る)。
        //
        // 対策: labels.json から全 slot を見て、Phase 2 が触らなかったマーカーは空文字で fill。
        // これで「Phase 2 が使わない slot は空セルに」というユーザー期待動作になる。
        //
        // ただし docx で delete-row 対象の slot は除外する:
        //   - 同段落の delete と fill が同居すると edit-engine の保険機構が
        //     「fill 優先で delete を skip」する仕様 → 行が削除されずラベル文字列が残る事故
        //   - delete-row は行ごと消えるので auto-clear の必要がない
        //   - xlsx では delete-row 自体が無視されるので除外不要 (全 slot に対して auto-clear)
        //
        // 注意: rowInsertions で作った新ラベル (labels.json には無い) は ri.fills 経由で
        // 既に処理済みなので、ここでは labels.json の slot だけ扱えば十分。
        const deleteRowSlots = isXlsx
          ? new Set<string>()
          : new Set(
              (decisionDoc.slotDecisions || [])
                .filter((sd) => sd.action === "delete-row")
                .map((sd) => sd.slot)
            );
        let autoClearedCount = 0;
        if (labels?.slots) {
          for (const s of labels.slots) {
            const labelStr = s.label && s.label !== "不明" ? s.label : `要入力_${s.slotId}`;
            if (deleteRowSlots.has(labelStr)) continue; // delete-row 対象は auto-clear から除外 (docx のみ)
            const marker = `★${labelStr}★`;
            if (!(marker in fills)) {
              fills[marker] = "";
              autoClearedCount++;
            }
          }
        }
        if (autoClearedCount > 0) {
          console.log(`[produce-v2] ${f.name} auto-cleared ${autoClearedCount} unaddressed markers`);
        }

        // 全 delete indices をマージして paragraphActions に
        const allDeleteIndices = new Set([...blockDeleteIndices, ...slotDeleteIndices]);
        for (const idx of allDeleteIndices) {
          paragraphActions.push({ paragraphIndex: idx, action: "delete" });
        }

        const edits: ProduceEdits = { paragraphActions, inserts, replaces, fills };

        console.log(
          `[produce-v2] ${f.name}${decisionDoc.outputLabel ? ` [${decisionDoc.outputLabel}]` : ""} edits:`,
          JSON.stringify({
            paragraphActions: paragraphActions.length,
            inserts: inserts.length,
            replaces: replaces.length,
            fills: Object.keys(fills).length,
            blockDeleteIndices: [...blockDeleteIndices],
            slotDeleteIndices: [...slotDeleteIndices],
          })
        );

        // edit engine で適用
        const result = isXlsx
          ? await applyProduceEditsXlsx(buf, edits, labels)
          : await applyProduceEditsDocx(buf, edits, labels);
        if (result.skipped.length > 0) {
          console.warn(`[produce-v2] ${f.name} skipped:`, result.skipped);
        }
        console.log(`[produce-v2] ${f.name} applied: ${result.applied.length}, skipped: ${result.skipped.length}`);

        // previewHtml: docx は mammoth で
        let previewHtml = "";
        if (!isXlsx) {
          try {
            const { value } = await mammoth.convertToHtml({ buffer: result.buf });
            previewHtml = value;
          } catch (e) {
            console.warn(`[produce-v2] mammoth failed for ${f.name}:`, e instanceof Error ? e.message : e);
          }
        }

        // outputLabel があれば出力ファイル名にサフィックス付与
        const baseName = f.name.replace(/\.[^.]+$/, "");
        const extPart = f.name.slice(baseName.length);
        const labelSuffix = decisionDoc.outputLabel ? `_${sanitizeFsName(decisionDoc.outputLabel)}` : "";
        const outName = `${baseName}${labelSuffix}${extPart}`;
        const displayName = `${baseName}${labelSuffix}`;

        return {
          name: displayName,
          fileName: outName,
          docxBase64: result.buf.toString("base64"),
          previewHtml,
          templatePath: f.path,
        };
      } catch (e) {
        console.error(
          `[produce-v2] ${decisionDoc.templateFile} (${decisionDoc.outputLabel || ""}) failed:`,
          e instanceof Error ? e.stack || e.message : e
        );
        return null;
      }
    })
  );

  const documents = docOuts.filter((d): d is DocOut => d !== null);

  return NextResponse.json({ documents });
}
