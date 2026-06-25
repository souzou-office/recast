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

// self-review は廃止 (横断的チェックは verify に集約)

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

        // ===== OfficeCLI モード: decisionDoc.officeCommands があれば優先 =====
        // (新スキーマ。AI が officecli の用語そのままで commands を出す。
        //  recast は引数組み立て + exec のみ。)
        if (decisionDoc.officeCommands && decisionDoc.officeCommands.length > 0) {
          const { copyToTemp, applyCommands } = await import("@/lib/officecli");
          const workCopy = await copyToTemp(f.path, decisionDoc.outputLabel);

          // 数式セル保護 (xlsx): テンプレで =SUM 等になっている「計算結果セル」(合計・割合など) への
          // AI set コマンドをドロップする。計算結果はスプレッドシートが自動計算するのが正しく、
          // ai モードで AI が同じセルに値を書くと数式を潰して事故る (合計% が 100%→1% に化けた件)。
          // 「AI は判断、計算は spreadsheet」の切り分け。docx には数式が無いので xlsx のみ対象。
          let sourceCommands = decisionDoc.officeCommands;
          if (/\.(xlsx|xlsm|xls)$/i.test(f.name)) {
            try {
              const { getXlsxFormulaCells } = await import("@/lib/xlsx-marker-parser");
              const formulaCells = getXlsxFormulaCells(await fs.readFile(f.path));
              if (formulaCells.size > 0) {
                const before = sourceCommands.length;
                sourceCommands = sourceCommands.filter((cmd) => {
                  if (cmd.command !== "set" || !cmd.path) return true;
                  const key = cmd.path.replace(/^\//, ""); // "/Sheet/F24" → "Sheet/F24"
                  return !formulaCells.has(key);
                });
                const dropped = before - sourceCommands.length;
                if (dropped > 0) {
                  console.log(`[produce-v2 officecli] ${f.name}: 数式セルへの set を ${dropped} 件スキップ (合計・割合などの計算結果を保護)`);
                }
              }
            } catch (e) {
              console.warn(`[produce-v2 officecli] 数式セル保護スキップ:`, e instanceof Error ? e.message : e);
            }
          }

          // AI のブレ対策: 強制補完。
          // - docx 段落への set: props.highlight が無ければ "none" 補完 (マーカー除去忘れ防止)
          // - xlsx セルへの set: props.fill が無ければ "FFFFFF" 補完 (塗りつぶし除去忘れ防止)
          const sanitizedCommands = sourceCommands.map((cmd) => {
            if (cmd.command !== "set" || !cmd.path) return cmd;
            const isDocxPara = /\/body\/p\[/.test(cmd.path);
            const isXlsxCell = /^\/[^/]+\/[A-Z]+\d+/.test(cmd.path); // /SheetName/CellAddr
            if (!isDocxPara && !isXlsxCell) return cmd;
            const props: Record<string, string> = { ...(cmd.props || {}) };
            if (isDocxPara && props.find && !("highlight" in props)) {
              props.highlight = "none";
            }
            if (isXlsxCell) {
              // xlsx セルへの find/replace は run 分割で 0 マッチ失敗しやすい。
              // replace 値があれば value= に変換 (セル丸ごと上書き、確実)。
              // (analyze プロンプトでも value 指定を指示済みだが、AI が find/replace を出した時の保険)
              if (props.find && props.replace !== undefined && props.value === undefined) {
                console.warn(`[produce-v2 officecli] ${f.name} xlsx cell ${cmd.path}: find/replace → value 変換`);
                props.value = props.replace;
                delete props.find;
                delete props.replace;
              }
              if (!("fill" in props)) props.fill = "FFFFFF";
            }
            return { ...cmd, props };
          });

          // 同じ `after` で連続する add は逆順に並べ替える。
          // officecli の `add --after X` 仕様: 同じ位置に連続 add すると LIFO で積まれる
          // (後に add したものが先頭に来る)。AI が「A → B → C」の順で書いても
          // 結果は「C → B → A」になる事故 (Deep30 組合の同意欄が逆順になった原因)。
          // recast が逆順に並べ替えることで、AI の出力順 = 結果順に揃える。
          const reordered: typeof sanitizedCommands = [];
          let idx = 0;
          while (idx < sanitizedCommands.length) {
            const c = sanitizedCommands[idx];
            if (c.command === "add" && c.after) {
              const group = [c];
              let j = idx + 1;
              while (j < sanitizedCommands.length && sanitizedCommands[j].command === "add" && sanitizedCommands[j].after === c.after) {
                group.push(sanitizedCommands[j]);
                j++;
              }
              // 逆順で push (LIFO 対策)
              for (let k = group.length - 1; k >= 0; k--) reordered.push(group[k]);
              idx = j;
            } else {
              reordered.push(c);
              idx++;
            }
          }

          // add で段落を足すとき、隣 (after=) の行の書式 (字下げ・行間・配置) を自動コピーする。
          // officecli の add は default 書式で段落を作るので、足した行だけ左端に飛んで字下げが崩れる
          // (組合の同意欄で発生)。after 段落を get して layout 系プロパティを add の props に注入。
          // 値の継承は recast が機械的にやる → AI に書式判断させない (決定論的)。
          //
          // ★致命的な落とし穴 (実機で再現確認済み)★
          //   get の対象は workCopy では「絶対に」なく、テンプレ原本 (f.path) にすること。
          //   officecli は get したファイルを resident process で掴むらしく、同じファイルを直後に
          //   batch すると【全コマンドを success と報告するのに保存が一切反映されない】無言失敗を起こす。
          //   → add を持つ書類 (組合の提案書兼同意書など) だけがこの get を通るため、組合書類だけが
          //     丸ごとテンプレのまま出力される (Deep30 組合の提案書が Polaris テンプレのまま出た原因)。
          //   get(別ファイル) + batch(workCopy) なら汚染されないことを確認済み。afterId 段落はコピー
          //   直後の workCopy とテンプレで同一なので、f.path から読んでも書式は同じ。
          {
            const { runOfficeCli } = await import("@/lib/officecli");
            // after paraId → 書式プロパティ のキャッシュ (同じ after に複数 add がぶら下がる)
            const fmtCache = new Map<string, Record<string, string>>();
            const LAYOUT_KEYS = ["indent", "firstLineIndent", "hangingIndent", "lineSpacing", "lineRule", "align", "spaceBefore", "spaceAfter"];
            for (const c of reordered) {
              if (c.command !== "add" || !c.after) continue;
              const m = c.after.match(/paraId=([0-9A-Fa-f]+)/);
              if (!m) continue;
              const afterId = m[1];
              if (!fmtCache.has(afterId)) {
                try {
                  // ★workCopy ではなく f.path (テンプレ原本) から読む。理由は上のコメント参照★
                  const r = await runOfficeCli(["get", f.path, `/body/p[@paraId=${afterId}]`, "--json"], { timeoutMs: 10_000 });
                  const parsed = JSON.parse(r.stdout || "{}");
                  const fmt = parsed?.data?.results?.[0]?.format || {};
                  const picked: Record<string, string> = {};
                  for (const k of LAYOUT_KEYS) {
                    if (fmt[k] !== undefined && fmt[k] !== null) picked[k] = String(fmt[k]);
                  }
                  fmtCache.set(afterId, picked);
                } catch { fmtCache.set(afterId, {}); }
              }
              const inherited = fmtCache.get(afterId)!;
              // AI が既に指定してるプロパティは尊重、未指定のものだけ継承
              c.props = { ...inherited, ...(c.props || {}) };
            }
          }

          const execResults = await applyCommands(workCopy, reordered);
          const failed = execResults.filter((r) => !r.ok);
          if (failed.length > 0) {
            console.warn(
              `[produce-v2 officecli] ${f.name}${decisionDoc.outputLabel ? ` [${decisionDoc.outputLabel}]` : ""} ` +
              `${failed.length}/${execResults.length} commands failed:`,
              failed.slice(0, 3).map((x) => x.error)
            );
          } else {
            console.log(
              `[produce-v2 officecli] ${f.name}${decisionDoc.outputLabel ? ` [${decisionDoc.outputLabel}]` : ""} ` +
              `applied ${execResults.length} commands`
            );
          }

          // self-review は廃止。
          // 横断的な整合性チェックは verify (produce 後) に集約 (生成書類だけを入力に絞り、
          // 全書類間の整合性 + 明らかな誤りを 1 回の LLM 呼び出しで指摘する設計)。
          // 旧設計: 書類ごとに 1-2 回 LLM 呼び出し → 14 書類で $1+ かかってた。

          let resultBuf: Buffer = await fs.readFile(workCopy);
          const ext0 = f.name.split(".").pop() || "docx";
          const isDocxOut = /^docx|^docm/i.test(ext0);

          // ★穴埋め未完 (サイレントスキップ) 検出 — cleanup の"前"に必ず実行★
          // 穴埋めが効くと set が highlight を消す。cleanup は全 highlight を消してしまうので、その前に
          // 「highlight が残ってる=変換が効いてないマーカー」を機械検出してログに出す。
          // 「officecli が成功と言いつつ書類が変わってない」(recast 最大の怖さ) を黙って出さず可視化する。
          if (isDocxOut) {
            try {
              const { detectUnfilledMarkers } = await import("@/lib/docx-verify");
              const unfilled = detectUnfilledMarkers(resultBuf);
              if (unfilled.length > 0) {
                console.warn(
                  `[produce-v2 verify] ${f.name}${decisionDoc.outputLabel ? ` [${decisionDoc.outputLabel}]` : ""} ` +
                  `★穴埋め未完 ${unfilled.length} 件 (highlight 残り=変換が効いてない可能性): ` +
                  unfilled.slice(0, 10).map((u) => `"${u.text}"`).join(" / ")
                );
              }
            } catch (e) {
              console.warn(`[produce-v2 verify] detectUnfilledMarkers 失敗:`, e instanceof Error ? e.message : e);
            }
          }

          // 清書クリーンアップ (docx のみ): fitText (文字幅固定) と マーカー (黄色ハイライト・赤文字) を
          // PizZip で XML 直接編集して確実に除去する。
          //   - fitText: 長い値 (「Deep30投資事業有限責任組合」等) を固定幅に押し込んで極小・潰れ
          //     表示になる事故 (組合の提案書兼同意書「無限責任組合員」「代表取締役」行) を解消。
          //     列位置は段落の字下げ (indent) が保つので fitText を外しても崩れない。
          //   - highlight/赤文字: テンプレ上の「ここを埋める」目印。清書には絶対に残さない。
          // ★officecli ではなく XML 直接編集にする理由★: officecli の後処理は高負荷時 (Word
          //   プロセス枯渇) に無言で失敗し「修正したのに直らない」事故の元凶だった。XML 直接編集なら
          //   Word/officecli に依存せず負荷状況に関係なく決定論的に効く。
          if (isDocxOut) {
            try {
              const { cleanupGeneratedDocx } = await import("@/lib/docx-cleanup");
              const { buf: cleaned, counts } = cleanupGeneratedDocx(resultBuf);
              resultBuf = cleaned;
              if (counts.fitText || counts.highlight || counts.redColor) {
                console.log(
                  `[produce-v2 officecli] ${f.name}${decisionDoc.outputLabel ? ` [${decisionDoc.outputLabel}]` : ""} ` +
                  `cleanup: fitText=${counts.fitText}, highlight=${counts.highlight}, redColor=${counts.redColor}`
                );
              }
            } catch (e) {
              console.warn(`[produce-v2 officecli] cleanup 失敗:`, e instanceof Error ? e.message : e);
            }
          } else if (/^xls[xm]/i.test(ext0)) {
            // xlsx/xlsm: 数式 (合計・割合) を Excel 開封時に必ず再計算させる。
            // officecli はセル値を書き換えるが数式を再計算しないため、放置すると古いキャッシュ値
            // (例: 合計 24756 のまま、実データは 105263) が残る。fullCalcOnLoad で開封時に強制再計算。
            try {
              const { ensureXlsxRecalc } = await import("@/lib/xlsx-cleanup");
              const { buf: recalced, changed } = ensureXlsxRecalc(resultBuf);
              resultBuf = recalced;
              if (changed) {
                console.log(`[produce-v2 officecli] ${f.name}${decisionDoc.outputLabel ? ` [${decisionDoc.outputLabel}]` : ""}: xlsx fullCalcOnLoad 設定 (数式を開封時に再計算)`);
              }
            } catch (e) {
              console.warn(`[produce-v2 officecli] xlsx recalc 設定失敗:`, e instanceof Error ? e.message : e);
            }
          }

          const baseName = f.name.replace(/\.[^.]+$/, "");
          const labelSuffix = decisionDoc.outputLabel ? `_${sanitizeFsName(decisionDoc.outputLabel)}` : "";

          // プレビュー HTML はフロント側 docx-preview に任せる (CLAUDE.md 方針)。
          // officecli view html はブラウザを自動起動する副作用があるため使わない。
          return {
            name: `${baseName}${labelSuffix}`,
            fileName: `${baseName}${labelSuffix}.${ext0}`,
            docxBase64: resultBuf.toString("base64"),
            previewHtml: "",
            templatePath: f.path,
          };
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
        // 共通関数化 (produce-edits.addMarkedTextNumbering) で analyze / analyze-questions と
        // 完全に同じ番号付けを保証する。番号がズレると AI の changes が全部誤爆する。
        const { addMarkedTextNumbering } = await import("@/lib/produce-edits");
        const markedText = addMarkedTextNumbering(markedTextRaw, buf, isXlsx);

        // === Phase 2 決定を機械的に edit op に変換 ===
        const numberedLines = parseNumberedLines(markedText);

        const fills: FillsOp = {};
        const paragraphActions: ParagraphActionOp[] = [];
        const inserts: InsertOp[] = [];
        const replaces: ReplaceOp[] = [];

        // === 新スキーマ (changes 配列) があれば優先で処理 ===
        // 旧スキーマ (slotDecisions / blockDeletes / rowInsertions / textReplaces) は
        // changes が無い時の互換 fallback として残置 (changesProcessed フラグで分岐)。
        let changesProcessed = false;
        if (decisionDoc.changes && decisionDoc.changes.length > 0) {
          changesProcessed = true;
          for (const ch of decisionDoc.changes) {
            if (ch.action === "delete") {
              if (isXlsx) continue; // xlsx は構造変更禁止
              const end = ch.until ?? ch.idx;
              for (let i = ch.idx; i <= end; i++) {
                paragraphActions.push({ paragraphIndex: i, action: "delete" });
              }
            } else if (ch.action === "fill") {
              if (ch.slot) {
                const marker = ch.slot.startsWith("★") ? ch.slot : `★${ch.slot}★`;
                fills[marker] = ch.value ?? "";
              }
            } else if (ch.action === "rewrite") {
              if (isXlsx) continue;
              paragraphActions.push({ paragraphIndex: ch.idx, action: "rewrite", newText: ch.text ?? "" });
            } else if (ch.action === "insertAfter") {
              if (isXlsx) continue;
              // **重要**: 同じ idx に対する複数の insertAfter は 1 op の contents 配列にマージする。
              // 別々の op にすると produce-edits.ts で全てが同じ sortKey になり、毎回「先頭に追加」
              // される形で挿入されるため、AI の入力順と逆順に並んでしまう
              // (Polaris ケース: Deep30 組合用 同意欄が完全逆順になった)。
              // 1 op の contents 配列なら makeStyledParagraphFromReference を順次 join するため
              // 順序が保たれる。
              const existing = inserts.find((i) => i.afterParagraphIndex === ch.idx);
              if (existing) {
                existing.contents.push(ch.text ?? "");
              } else {
                inserts.push({ afterParagraphIndex: ch.idx, contents: [ch.text ?? ""] });
              }
            }
          }

          // auto-clear (Phase 2 が触らなかった ★label★ を空文字 fill で消す)
          // delete された段落の slot は対象外 (どうせ消えるので)
          const deletedIndices = new Set<number>();
          for (const ch of decisionDoc.changes) {
            if (ch.action === "delete") {
              const end = ch.until ?? ch.idx;
              for (let i = ch.idx; i <= end; i++) deletedIndices.add(i);
            }
          }
          let autoClearedCount = 0;
          if (labels?.slots) {
            for (const s of labels.slots) {
              const labelStr = s.label && s.label !== "不明" ? s.label : `要入力_${s.slotId}`;
              const paraIdx = numberedLines.find(nl => nl.labels.includes(labelStr))?.idx ?? null;
              if (paraIdx !== null && deletedIndices.has(paraIdx)) continue;
              const marker = `★${labelStr}★`;
              if (!(marker in fills)) {
                fills[marker] = "";
                autoClearedCount++;
              }
            }
          }
          if (autoClearedCount > 0) {
            console.log(`[produce-v2] ${f.name} (changes) auto-cleared ${autoClearedCount} unaddressed markers`);
          }
          console.log(
            `[produce-v2] ${f.name}${decisionDoc.outputLabel ? ` [${decisionDoc.outputLabel}]` : ""} (changes mode) prepared:`,
            JSON.stringify({
              paragraphActions: paragraphActions.length,
              inserts: inserts.length,
              fills: Object.keys(fills).length,
              deletedIndices: [...deletedIndices],
            })
          );
        }

        // === 旧スキーマ処理 (changes が無い時の互換) ===
        if (!changesProcessed) {
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

        // blockDelete 範囲内にある slot のラベル集合を事前に計算。
        // fill / auto-clear どちらも blockDelete 範囲内の slot は対象外にすることで、
        // 「議案2 ブロック削除なのに中の slot に空 fill が積まれ、edit engine が
        //  『fill 優先で delete を skip』して議案ブロックが残る」事故を構造的に防ぐ。
        // findParagraphIndex は部分一致まで許すため、別 slot の段落を誤検出してしまう
        // (例: 「記名押印する代表取締役の氏名」を検索すると「代表取締役の氏名」と部分一致して
        //  そちらの段落番号が返り、blockDelete 範囲内と誤判定されて fill が drop される)。
        // ここでは ★label★ の完全一致で探す。
        const blockDeleteSlotLabels = new Set<string>();
        if (!isXlsx && labels?.slots) {
          for (const s of labels.slots) {
            const labelStr = s.label && s.label !== "不明" ? s.label : `要入力_${s.slotId}`;
            // 完全一致で段落探索 (numberedLines の labels 配列に厳密一致)
            const paraIdx = numberedLines.find(nl => nl.labels.includes(labelStr))?.idx ?? null;
            if (paraIdx !== null && blockDeleteIndices.has(paraIdx)) {
              blockDeleteSlotLabels.add(labelStr);
            }
          }
        }

        // 5. slotDecisions[fill] → fills
        // 旧設計の unconfirmed action は Phase 2-A 質問フェーズに分離されたので
        // ここには到達しない (action は fill / delete-row の2択)。
        // blockDelete 範囲内の slot fill は drop (削除が優先される)。
        for (const sd of decisionDoc.slotDecisions || []) {
          if (sd.action === "fill") {
            if (blockDeleteSlotLabels.has(sd.slot)) continue;
            fills[`★${sd.slot}★`] = sd.value ?? "";
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
            if (blockDeleteSlotLabels.has(labelStr)) continue; // blockDelete 範囲内も除外 (どうせ段落ごと消える)
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

        // 全 delete indices をマージして paragraphActions に (旧スキーマ)
        const allDeleteIndices = new Set([...blockDeleteIndices, ...slotDeleteIndices]);
        for (const idx of allDeleteIndices) {
          paragraphActions.push({ paragraphIndex: idx, action: "delete" });
        }
        } // ← 旧スキーマ処理 (changes が無い時の互換) ここまで

        const edits: ProduceEdits = { paragraphActions, inserts, replaces, fills };

        if (!changesProcessed) {
          console.log(
            `[produce-v2] ${f.name}${decisionDoc.outputLabel ? ` [${decisionDoc.outputLabel}]` : ""} (legacy mode) edits:`,
            JSON.stringify({
              paragraphActions: paragraphActions.length,
              inserts: inserts.length,
              replaces: replaces.length,
              fills: Object.keys(fills).length,
            })
          );
        }

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
