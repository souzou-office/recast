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

// 1 slot を 1 つの set コマンドに変換する。
// find = oldValue (前案件の値) / replace = newValue。
// docx は paraId、xlsx は /シート名/セル を path に。
function slotToCommand(slot: ResolvedSlot, newValue: string): OfficeCliCommandPayload | null {
  if (slot.docx) {
    if (!slot.docx.paraId) return null; // paraId 無しは安全に特定できない → スキップ
    const props: Record<string, string> = { highlight: "none" };
    if (slot.oldValue) {
      // 通常: find/replace で前案件値を新値に。run 分割を跨いで officecli が探す。
      props.find = slot.oldValue;
      props.replace = newValue;
    } else {
      // 空マーカー (oldValue 無し): 段落末尾に追記しかできないが、ここでは text 設定で対応
      props.text = newValue;
    }
    return { command: "set", path: `/body/p[@paraId=${slot.docx.paraId}]`, props };
  }
  if (slot.xlsx) {
    // xlsx は find/replace が run 分割で 0 マッチしやすいので必ず value= でセル丸ごと上書き。
    return {
      command: "set",
      path: `/${slot.xlsx.sheetName}/${slot.xlsx.ref}`,
      props: { value: newValue, fill: "FFFFFF" },
    };
  }
  return null;
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
function generateForOneOutput(
  slots: ResolvedSlot[],
  valueTable: Record<string, string>,
  entity?: Record<string, string>,
  outputLabel?: string
): GeneratedDoc {
  const commands: OfficeCliCommandPayload[] = [];
  const unresolvedLabels: string[] = [];
  for (const slot of slots) {
    const value = resolveValue(slot.label, valueTable, entity);
    if (value === undefined) {
      unresolvedLabels.push(slot.label);
      continue; // 埋める値が無い → そのマーカーは触らない (空欄や前案件値が残る → verify が拾う)
    }
    const cmd = slotToCommand(slot, value);
    if (cmd) commands.push(cmd);
    else unresolvedLabels.push(`${slot.label}(位置不明)`);
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
}): GeneratedDoc[] {
  const { plan, slots, valueTable, entityGroups } = args;

  if (plan.mode === "fill") {
    return [generateForOneOutput(slots, valueTable)];
  }

  if (plan.mode === "loop") {
    const group = entityGroups.find((g) => g.groupId === plan.entityGroupId);
    if (!group) {
      // グループが見つからない → fill 扱いにフォールバック (1通だけ生成)
      return [generateForOneOutput(slots, valueTable)];
    }
    return group.entities.map((entity) => {
      const outputLabel = plan.outputLabelField
        ? entity[plan.outputLabelField]
        : Object.values(entity)[0]; // フィールド指定なければ先頭値を識別に
      return generateForOneOutput(slots, valueTable, entity, outputLabel);
    });
  }

  // mode === "ai" はここに来ない想定
  return [];
}
