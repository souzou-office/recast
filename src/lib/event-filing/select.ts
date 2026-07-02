// 事由駆動の中核ロジック（純粋関数・AI なし・決定論）。
//
//   requiredDocuments : この事由で必要な書類
//   pendingQuestions  : 資料で埋まらず、ユーザーに聞く必要が残っている質問
//   buildFillMap      : 各穴(ラベル) -> 値。既存の穴埋めエンジンに渡す。
//
// 「木 → 必要書類 + 聞くこと + 穴の値」を、facts(資料) と answers(回答) から機械的に出す。

import type { Jirei, JireiDocument, JireiQuestion, SlotBinding } from "@/types/jirei";

export function requiredDocuments(jirei: Jirei): JireiDocument[] {
  // v1: 条件分岐は無く、木に列挙された書類が全て必要。
  return jirei.documents;
}

// スロットの binding を facts + answers で解決。決まらなければ null。
export function resolveSlot(
  binding: SlotBinding,
  facts: Record<string, string>,
  answers: Record<string, string>
): string | null {
  switch (binding.type) {
    case "fact":
      return facts[binding.key] ?? null;
    case "answer":
      return answers[binding.questionId] ?? null;
    case "const":
      return binding.value;
    default:
      return null;
  }
}

// まだ聞く必要のある質問。
//   = answer 型スロットが実際に参照する質問のうち、まだ回答が無いもの。
//   資料(fact)で埋まる穴は聞かない、が構造的に保証される（fact スロットは questions を経由しない）。
export function pendingQuestions(
  jirei: Jirei,
  answers: Record<string, string>
): JireiQuestion[] {
  const needed = new Set<string>();
  for (const binding of Object.values(jirei.slots)) {
    if (binding.type === "answer") needed.add(binding.questionId);
  }
  return jirei.questions.filter(
    (q) => needed.has(q.id) && !(answers[q.id] && answers[q.id].trim() !== "")
  );
}

// 各穴 -> 値。既存の穴埋めエンジンに渡す fill map。
//   filled     : 解決できた穴 (ラベル -> 値)
//   unresolved : 値が決まらなかった穴のラベル（呼び出し側で警告 / 空扱い）
export function buildFillMap(
  jirei: Jirei,
  facts: Record<string, string>,
  answers: Record<string, string>
): { filled: Record<string, string>; unresolved: string[] } {
  const filled: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const [label, binding] of Object.entries(jirei.slots)) {
    const v = resolveSlot(binding, facts, answers);
    if (v === null || v === "") unresolved.push(label);
    else filled[label] = v;
  }
  return { filled, unresolved };
}
