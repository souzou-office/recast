// 仕分け式アーキテクチャの「ルール生成器」。
//
// 役割: マーカーパーサーの slot 位置 (slotId → paraId/セル + oldValue) と、
//       Step A が出した「slotId → 値」割り当てから、officecli の set コマンドを機械生成する。
//
// ★slotId 直接方式★ (ラベル名照合は廃止):
//   AI が「slot 6 = この値」と番号で指定 → 機械は slot 6 の場所 (paraId/セル) に置くだけ。
//   ラベル名の表記揺れで外れることが構造的に起きない。
//   officecli へは今まで通り paraId/セル指定のコマンドで渡す (slotId は recast 内部のみ)。

import type { DocxSlotPosition, RegionSlot } from "./docx-marker-parser";
import type { XlsxSlotPosition } from "./xlsx-marker-parser";
import type { OfficeCliCommandPayload, TemplatePlan, SlotFill, RegionFill } from "@/types";

// 1 書類分の生成結果。
export interface GeneratedDoc {
  outputLabel?: string;                  // loop のとき: そのエンティティの識別 (氏名等)
  commands: OfficeCliCommandPayload[];
  skippedSlotIds: number[];              // 場所不明等で処理できなかった slotId (ログ用)
}

// slotId → 位置 + oldValue。パーサーの出力から作る (labels.json は不要になった)。
export interface SlotInfo {
  slotId: number;
  oldValue: string;
  docx?: DocxSlotPosition;
  xlsx?: XlsxSlotPosition;
}

// パーサーの slots/positions を突き合わせて SlotInfo[] を作る。
export function resolveSlots(args: {
  slots: Map<number, string>;                       // slotId → oldValue (パーサー)
  docxPositions?: Map<number, DocxSlotPosition>;
  xlsxPositions?: Map<number, XlsxSlotPosition>;
}): SlotInfo[] {
  const { slots, docxPositions, xlsxPositions } = args;
  const out: SlotInfo[] = [];
  for (const [slotId, oldValue] of slots) {
    out.push({
      slotId,
      oldValue,
      docx: docxPositions?.get(slotId),
      xlsx: xlsxPositions?.get(slotId),
    });
  }
  return out;
}

// docx slot → set コマンド (find=oldValue / replace=newValue)。
function docxSlotToCommand(slot: SlotInfo, newValue: string): OfficeCliCommandPayload | null {
  if (!slot.docx?.paraId) return null;
  const props: Record<string, string> = { highlight: "none" };
  if (slot.oldValue) {
    props.find = slot.oldValue;
    props.replace = newValue;
  } else {
    props.text = newValue;
  }
  return { command: "set", path: `/body/p[@paraId=${slot.docx.paraId}]`, props };
}

// 1 書類分のコマンドを生成する。
// slotValues: slotId → 入れる値。空文字 "" は「その行は不要 → 段落削除」。
// xlsxCellTexts: xlsx のセルテンプレ (1 セルに複数 slot の場合の再構築用)。
// % 書式セルの値を正規化。officecli は "78.40%" を 0.784 として格納し 78.40% と表示する。
// AI が % 無しの裸の数字 "78.40" を出すと ×100 されて 7840% になるので、% を補う。
// 既に % 付き、または小数 (0〜1) や非数値はそのまま。
function normalizePercentValue(value: string): string {
  const v = value.trim();
  if (v === "" || v.includes("%")) return v;            // 空 or 既に % 付き → そのまま
  const num = Number(v.replace(/,/g, ""));
  if (!Number.isFinite(num)) return v;                  // 数値でない → そのまま
  if (num > 0 && num < 1) return v;                     // 0〜1 の小数 → 既に格納形式 → そのまま
  return `${v}%`;                                       // 裸の数字 (78.40 等) → % を補う
}

function generateForOneOutput(
  slots: SlotInfo[],
  slotValues: Map<number, string>,
  outputLabel: string | undefined,
  xlsxCellTexts?: Map<string, string>,
  percentRefs?: Set<string>,
  regionSlots?: Map<number, RegionSlot>,
  regionValues?: Map<number, string[]>
): GeneratedDoc {
  const commands: OfficeCliCommandPayload[] = [];
  const skippedSlotIds: number[] = [];
  const slotById = new Map(slots.map((s) => [s.slotId, s]));

  // --- docx: 段落 (paraId) 単位でまとめる ---
  // 同じ段落の slot が全部「空値」になったら段落ごと削除 (未使用の取締役枠等のスキマ防止)。
  const docxSlots = slots.filter((s) => s.docx && slotValues.has(s.slotId));
  const docxByPara = new Map<string, SlotInfo[]>();
  for (const s of docxSlots) {
    if (!s.docx!.paraId) { skippedSlotIds.push(s.slotId); continue; }
    const id = s.docx!.paraId;
    if (!docxByPara.has(id)) docxByPara.set(id, []);
    docxByPara.get(id)!.push(s);
  }
  for (const [paraId, paraSlots] of docxByPara) {
    const vals = paraSlots.map((s) => ({ slot: s, value: slotValues.get(s.slotId)! }));
    // 既存テキストのある slot が全部「空値」→ 段落ごと削除
    const allEmpty = vals.every((v) => v.value === "" && v.slot.oldValue.trim() !== "");
    if (allEmpty) {
      commands.push({ command: "remove", path: `/body/p[@paraId=${paraId}]` });
      continue;
    }
    for (const v of vals) {
      const cmd = docxSlotToCommand(v.slot, v.value);
      if (cmd) commands.push(cmd);
      else skippedSlotIds.push(v.slot.slotId);
    }
  }

  // --- xlsx: セル (ref) 単位で再構築 (1 セル複数 slot の上書き事故防止) ---
  const xlsxSlots = slots.filter((s) => s.xlsx && slotValues.has(s.slotId));
  if (xlsxSlots.length > 0) {
    const byRef = new Map<string, { sheetName: string; slots: SlotInfo[] }>();
    for (const s of xlsxSlots) {
      const ref = s.xlsx!.ref;
      if (!byRef.has(ref)) byRef.set(ref, { sheetName: s.xlsx!.sheetName, slots: [] });
      byRef.get(ref)!.slots.push(s);
    }
    for (const [ref, { sheetName, slots: cellSlots }] of byRef) {
      const template = xlsxCellTexts?.get(ref);
      let newCellValue: string;
      if (template) {
        // テンプレの ［要入力_N］ を各 slot の値で置換。値が無ければ前値を残す。
        newCellValue = template.replace(/［要入力_(\d+)］/g, (_, idStr) => {
          const sid = Number(idStr);
          if (slotValues.has(sid)) return slotValues.get(sid)!;
          return slotById.get(sid)?.oldValue ?? "";
        });
      } else {
        newCellValue = slotValues.get(cellSlots[0].slotId)!;
      }
      // % 書式のセルは値を正規化 (78.40 → 78.40%) して ×100 事故を防ぐ
      if (percentRefs?.has(ref)) newCellValue = normalizePercentValue(newCellValue);
      // value=中身、fill=FFFFFF=黄色背景クリア、font.color=000000=赤文字マーカークリア
      commands.push({ command: "set", path: `/${sheetName}/${ref}`, props: { value: newCellValue, fill: "FFFFFF", "font.color": "000000" } });
    }
  }

  // --- 領域 (緑マーカー = 入れ替えブロック): 旧領域を remove して afterParaId 直後に新行を add ---
  // 場所 (removeParaIds / afterParaId) はパーサーが確定済み。AI が出した lines を入れるだけ。
  // ★重複は機械で除去★ (同じ remove を2回・同じ行を複数回 = ダブりの元 を構造的に防ぐ)。
  // 挿入順序の整列 (officecli の同一 after への LIFO) と書式継承は produce-v2 が行う。
  if (regionSlots && regionValues) {
    for (const [slotId, lines] of regionValues) {
      const region = regionSlots.get(slotId);
      if (!region) { skippedSlotIds.push(slotId); continue; }
      const seenRemove = new Set<string>();
      for (const pid of region.removeParaIds) {
        if (!pid || seenRemove.has(pid)) continue;
        seenRemove.add(pid);
        commands.push({ command: "remove", path: `/body/p[@paraId=${pid}]` });
      }
      if (region.afterParaId) {
        // ★書式の継承元★: 挿入位置(afterParaId=日付など)から継承すると、日付が右寄せの場合
        // 新行も全部右寄せになる。代わりに旧領域の行から継承する:
        //   先頭行 → 旧領域の先頭段落 (例: 「（株主）住所…」= 行頭プレフィックスありの行)
        //   2行目以降 → 旧領域の末尾段落 (例: 「氏名…」= 字下げされたラベル行)
        // これで個人テンプレと同じ2段字下げ・左寄せになる。
        const firstOld = region.removeParaIds[0];
        const lastOld = region.removeParaIds[region.removeParaIds.length - 1] || firstOld;
        const seenLine = new Set<string>();
        let addIdx = 0;
        for (const line of lines) {
          if (line == null || seenLine.has(line)) continue;
          seenLine.add(line);
          const formatFromParaId = addIdx === 0 ? firstOld : lastOld;
          commands.push({
            command: "add", parent: "/body", after: `/body/p[@paraId=${region.afterParaId}]`,
            type: "paragraph", props: { text: line },
            ...(formatFromParaId ? { formatFromParaId } : {}),
          });
          addIdx++;
        }
      }
    }
  }

  return { outputLabel, commands, skippedSlotIds };
}

// SlotFill[] → Map<slotId, value>
function fillsToMap(fills: SlotFill[] | undefined): Map<number, string> {
  const m = new Map<number, string>();
  for (const f of fills || []) m.set(f.slotId, f.value);
  return m;
}

// RegionFill[] → Map<slotId, lines[]>
function regionFillsToMap(fills: RegionFill[] | undefined): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const f of fills || []) m.set(f.slotId, f.lines || []);
  return m;
}

// テンプレ 1 つ分の生成。mode に応じて fill (1通) / loop (人数分) を機械展開する。
// mode === "ai" の場合はこの関数を呼ばない (呼び出し側で AI に officeCommands を出させる)。
export function generateFillCommands(args: {
  plan: TemplatePlan;
  slots: SlotInfo[];
  regionSlots?: Map<number, RegionSlot>;   // パーサーが検出した領域 (緑) の位置情報
  xlsxCellTexts?: Map<string, string>;
  percentRefs?: Set<string>;
}): GeneratedDoc[] {
  const { plan, slots, regionSlots, xlsxCellTexts, percentRefs } = args;

  if (plan.mode === "fill") {
    return [generateForOneOutput(slots, fillsToMap(plan.slotFills), undefined, xlsxCellTexts, percentRefs, regionSlots, regionFillsToMap(plan.regionFills))];
  }

  if (plan.mode === "loop") {
    const shared = fillsToMap(plan.sharedSlotFills);
    const entities = plan.entities || [];
    if (entities.length === 0) {
      // エンティティ無し → 共通分だけで 1 通
      return [generateForOneOutput(slots, shared, undefined, xlsxCellTexts, percentRefs, regionSlots, regionFillsToMap(plan.regionFills))];
    }
    return entities.map((ent) => {
      // 共通 slot + この人固有 slot をマージ (固有が優先)。領域は各人固有 (同意欄ブロック等)。
      const merged = new Map(shared);
      for (const f of ent.slotFills) merged.set(f.slotId, f.value);
      return generateForOneOutput(slots, merged, ent.outputLabel, xlsxCellTexts, percentRefs, regionSlots, regionFillsToMap(ent.regionFills));
    });
  }

  return []; // ai
}
