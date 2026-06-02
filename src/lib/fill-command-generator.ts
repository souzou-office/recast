// 仕分け式アーキテクチャの「ルール生成器」。
//
// 役割: マーカーパーサーの slot 位置 + labels.json (slotId→label/oldValue) + Phase2Plan の確定値表
//       から、officecli の set コマンドを **AI を介さず機械的に** 生成する。
//
// これが「同じ値を人数分コピペする」作業を AI から奪い、決定論コードに移す中核。
// AI は確定値を1つ決めるだけ。ここでそれを全 slot / 全エンティティに機械展開する。

import type { TemplateLabels } from "./template-labels";
import type { DocxSlotPosition } from "./docx-marker-parser";
import type { XlsxSlotPosition } from "./xlsx-marker-parser";
import type { OfficeCliCommandPayload, EntityGroup, TemplatePlan } from "@/types";

// 1 書類分の生成結果。
export interface GeneratedDoc {
  outputLabel?: string;                  // loop のとき: そのエンティティの識別 (氏名等)
  commands: OfficeCliCommandPayload[];
  unresolvedLabels: string[];            // 確定値表にもエンティティにも無くて埋められなかった label (ログ用)
}

// slotId → 解決済み情報 (label + oldValue + 位置) をまとめた中間表現。
interface ResolvedSlot {
  slotId: number;
  label: string;
  oldValue: string;
  // docx か xlsx どちらかの位置
  docx?: DocxSlotPosition;
  xlsx?: XlsxSlotPosition;
}

// labels.json + パーサーの slots/positions を突き合わせて ResolvedSlot[] を作る。
export function resolveSlots(args: {
  labels: TemplateLabels;
  slots: Map<number, string>;                       // slotId → oldValue (パーサー)
  docxPositions?: Map<number, DocxSlotPosition>;
  xlsxPositions?: Map<number, XlsxSlotPosition>;
}): ResolvedSlot[] {
  const { labels, slots, docxPositions, xlsxPositions } = args;
  const labelById = new Map<number, string>();
  for (const s of labels.slots) labelById.set(s.slotId, s.label);

  const out: ResolvedSlot[] = [];
  for (const [slotId, oldValue] of slots) {
    const label = labelById.get(slotId);
    if (!label) continue; // labels.json に無い slot は扱えない (スキップ)
    out.push({
      slotId,
      label,
      oldValue,
      docx: docxPositions?.get(slotId),
      xlsx: xlsxPositions?.get(slotId),
    });
  }
  return out;
}

// docx slot → set コマンド (find=oldValue / replace=newValue)。
function docxSlotToCommand(slot: ResolvedSlot, newValue: string): OfficeCliCommandPayload | null {
  if (!slot.docx?.paraId) return null; // paraId 無しは安全に特定できない → スキップ
  const props: Record<string, string> = { highlight: "none" };
  if (slot.oldValue) {
    props.find = slot.oldValue;
    props.replace = newValue;
  } else {
    props.text = newValue;
  }
  return { command: "set", path: `/body/p[@paraId=${slot.docx.paraId}]`, props };
}

// label → 値 を引く。entity (loop の現在行) を優先、無ければ valueTable。
function resolveValue(
  label: string,
  valueTable: Record<string, string>,
  entity?: Record<string, string>
): string | undefined {
  if (entity && label in entity) return entity[label];
  if (label in valueTable) return valueTable[label];
  return undefined;
}

// 1 書類分のコマンドを生成する。entity が渡されれば loop の 1 エンティティ分。
// xlsxCellTexts があれば xlsx はセル単位で再構築する (1セル複数slot の上書き事故を防ぐ)。
function generateForOneOutput(
  slots: ResolvedSlot[],
  valueTable: Record<string, string>,
  entity?: Record<string, string>,
  outputLabel?: string,
  xlsxCellTexts?: Map<string, string>
): GeneratedDoc {
  const commands: OfficeCliCommandPayload[] = [];
  const unresolvedLabels: string[] = [];

  // --- docx: 段落 (paraId) 単位でまとめて処理 ---
  // 1 段落に複数 slot があることがあるので paraId でグループ化。
  // ある段落の slot が「全部 空値」になったら、その段落は不要 (取締役2人目/3人目の未使用枠など)
  // → 空文字に置換するとスキマが残るので、段落ごと remove して詰める。
  const docxByPara = new Map<string, ResolvedSlot[]>();
  const docxNoPara: ResolvedSlot[] = [];
  for (const slot of slots) {
    if (!slot.docx) continue;
    if (slot.docx.paraId) {
      const id = slot.docx.paraId;
      if (!docxByPara.has(id)) docxByPara.set(id, []);
      docxByPara.get(id)!.push(slot);
    } else {
      docxNoPara.push(slot);
    }
  }
  for (const [paraId, paraSlots] of docxByPara) {
    // 各 slot の値を解決
    const resolved = paraSlots.map((s) => ({ slot: s, value: resolveValue(s.label, valueTable, entity) }));
    const known = resolved.filter((r) => r.value !== undefined);
    for (const r of resolved) if (r.value === undefined) unresolvedLabels.push(r.slot.label);
    if (known.length === 0) continue; // 全部 未解決 → 触らない (前値のまま)

    // 既存テキストのある slot が全部「空値」になる → 段落ごと削除 (スキマ防止)
    const allEmpty = known.every((r) => r.value === "" && r.slot.oldValue.trim() !== "");
    if (allEmpty) {
      commands.push({ command: "remove", path: `/body/p[@paraId=${paraId}]` });
      continue;
    }
    // それ以外は slot ごとに find/replace
    for (const r of known) {
      const cmd = docxSlotToCommand(r.slot, r.value!);
      if (cmd) commands.push(cmd);
      else unresolvedLabels.push(`${r.slot.label}(位置不明)`);
    }
  }
  // paraId が取れなかった docx slot は従来通り (位置不明として記録)
  for (const slot of docxNoPara) unresolvedLabels.push(`${slot.label}(位置不明)`);

  // --- xlsx: セル単位で再構築 (同一セルの複数 slot を 1 つの value= にまとめる) ---
  const xlsxSlots = slots.filter((s) => s.xlsx);
  if (xlsxSlots.length > 0) {
    // ref ごとに slot をまとめる
    const byRef = new Map<string, { sheetName: string; slots: ResolvedSlot[] }>();
    for (const s of xlsxSlots) {
      const ref = s.xlsx!.ref;
      if (!byRef.has(ref)) byRef.set(ref, { sheetName: s.xlsx!.sheetName, slots: [] });
      byRef.get(ref)!.slots.push(s);
    }
    const slotById = new Map(xlsxSlots.map((s) => [s.slotId, s]));
    for (const [ref, { sheetName, slots: cellSlots }] of byRef) {
      const template = xlsxCellTexts?.get(ref);
      let newCellValue: string;
      if (template) {
        // テンプレの ［要入力_N］ を各 slot の値で置換。値が無ければ前値(oldValue)を残す。
        newCellValue = template.replace(/［要入力_(\d+)］/g, (_, idStr) => {
          const slot = slotById.get(Number(idStr));
          if (!slot) return "";
          const v = resolveValue(slot.label, valueTable, entity);
          if (v === undefined) { unresolvedLabels.push(slot.label); return slot.oldValue; }
          return v;
        });
      } else {
        // テンプレ無し (単一 slot 想定): その slot の値で
        const slot = cellSlots[0];
        const v = resolveValue(slot.label, valueTable, entity);
        if (v === undefined) { unresolvedLabels.push(slot.label); continue; }
        newCellValue = v;
      }
      // value = セルの中身、fill=FFFFFF = 黄色マーカー背景を消す、font.color=000000 = 赤文字マーカーを消す。
      // テンプレは「黄色背景」か「赤文字」でマーカーを示すので、両方リセットして通常の見た目にする。
      commands.push({ command: "set", path: `/${sheetName}/${ref}`, props: { value: newCellValue, fill: "FFFFFF", "font.color": "000000" } });
    }
  }

  return { outputLabel, commands, unresolvedLabels };
}

// テンプレ 1 つ分の生成。mode に応じて fill (1通) / loop (人数分) を機械展開する。
// mode === "ai" の場合はこの関数は呼ばない (呼び出し側で AI に投げる)。
export function generateFillCommands(args: {
  plan: TemplatePlan;
  slots: ResolvedSlot[];
  valueTable: Record<string, string>;
  entityGroups: EntityGroup[];
  xlsxCellTexts?: Map<string, string>;   // xlsx のセル単位再構築用 (パーサーの cellTexts)
}): GeneratedDoc[] {
  const { plan, slots, valueTable, entityGroups, xlsxCellTexts } = args;

  if (plan.mode === "fill") {
    return [generateForOneOutput(slots, valueTable, undefined, undefined, xlsxCellTexts)];
  }

  if (plan.mode === "loop") {
    const group = entityGroups.find((g) => g.groupId === plan.entityGroupId);
    if (!group) {
      // グループが見つからない → fill 扱いにフォールバック (1通だけ生成)
      return [generateForOneOutput(slots, valueTable, undefined, undefined, xlsxCellTexts)];
    }
    return group.entities.map((entity) => {
      const outputLabel = plan.outputLabelField
        ? entity[plan.outputLabelField]
        : Object.values(entity)[0]; // フィールド指定なければ先頭値を識別に
      return generateForOneOutput(slots, valueTable, entity, outputLabel, xlsxCellTexts);
    });
  }

  // mode === "ai" はここに来ない想定
  return [];
}
