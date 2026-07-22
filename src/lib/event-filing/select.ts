// 事由駆動の中核ロジック（純粋関数・AI なし・決定論）。
//
//   requiredDocuments : この事由で必要な書類（when 条件を回答で評価）
//   pendingQuestions  : 資料で埋まらず、ユーザーに聞く必要が残っている質問
//   buildFillMap      : 各穴(ラベル) -> 値。既存の穴埋めエンジンに渡す。
//
// 「木 → 必要書類 + 聞くこと + 穴の値」を、facts(資料) と answers(回答) から機械的に出す。
//
// ★分岐 (when) の考え方★
//   questions / documents / slots は when: { questionId, anyOf } を持てる。
//   「kind=取締役の就任 のときだけ就任承諾書が要る」のような分岐は全部これで表現する。
//   分岐を決める質問 (when が参照する questionId) は自動的に「先に聞く」対象になり、
//   回答が進むごとに pendingQuestions を再評価すれば質問が段階的に出てくる（波状の質問）。

import type { Jirei, JireiCondition, JireiDocument, JireiQuestion, SlotBinding } from "@/types/jirei";

// when 条件の評価。when が無ければ常に有効。
// all = すべて満たす（かつ）/ any = どれか満たす（または）/ 基本形 = 回答の等値。
export function condOk(
  when: JireiCondition | undefined,
  answers: Record<string, string>
): boolean {
  if (!when) return true;
  if ("all" in when) return when.all.every((c) => condOk(c, answers));
  if ("any" in when) return when.any.some((c) => condOk(c, answers));
  const v = (answers[when.questionId] || "").trim();
  return v !== "" && when.anyOf.includes(v);
}

// when 条件が参照している questionId をすべて集める（分岐を決める質問 = 先に聞く対象）。
export function condQuestionIds(when: JireiCondition | undefined): string[] {
  if (!when) return [];
  if ("all" in when) return when.all.flatMap(condQuestionIds);
  if ("any" in when) return when.any.flatMap(condQuestionIds);
  return [when.questionId];
}

export function requiredDocuments(
  jirei: Jirei,
  answers: Record<string, string>
): JireiDocument[] {
  return jirei.documents.filter((d) => condOk(d.when, answers));
}

// いま有効なスロット（when を満たすもの）だけを返す。
// 配列バインディングは「when を満たす最初の出所」を採用する
// （同じ穴でも分岐によって出所が変わるとき用。例: 委任状の日付 = 就任なら総会日/辞任なら辞任日）。
export function activeSlots(
  jirei: Jirei,
  answers: Record<string, string>
): [string, SlotBinding][] {
  const out: [string, SlotBinding][] = [];
  for (const [label, b] of Object.entries(jirei.slots)) {
    if (Array.isArray(b)) {
      const hit = b.find((x) => condOk(x.when, answers));
      if (hit) out.push([label, hit]);
    } else if (condOk(b.when, answers)) {
      out.push([label, b]);
    }
  }
  return out;
}

// slots の全バインディングをフラットに列挙（when の参照質問の収集用）
function allBindings(jirei: Jirei): SlotBinding[] {
  return Object.values(jirei.slots).flatMap((b) => (Array.isArray(b) ? b : [b]));
}

// いま有効なガード（ユーザーへの注意・制止メッセージ）。
export function activeGuards(jirei: Jirei, answers: Record<string, string>): string[] {
  return (jirei.guards || [])
    .filter((g) => condOk(g.when, answers))
    .map((g) => g.message);
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
    case "answer": {
      const raw = answers[binding.questionId] ?? null;
      if (raw === null || binding.lineField === undefined) return raw;
      // 行リスト回答（氏名／住所 など）から n 番目のフィールドだけを一覧化
      const sep = binding.separator || "／";
      return raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (l.split(sep)[binding.lineField!] || "").trim())
        .join("\n");
    }
    case "const":
      return binding.value;
    default:
      return null;
  }
}

// まだ聞く必要のある質問。
//   聞く対象 =
//     ① 有効な answer 型スロットが参照する質問
//     ② 分岐 (when) が参照する質問（documents / questions / slots のどれかが依存している）
//   のうち、when を満たしていて、まだ回答が無いもの。
//   資料(fact)で埋まる穴は聞かない、が構造的に保証される（fact スロットは questions を経由しない）。
export function pendingQuestions(
  jirei: Jirei,
  answers: Record<string, string>
): JireiQuestion[] {
  const needed = new Set<string>();
  // ① 有効なスロットが参照する回答
  for (const [, binding] of activeSlots(jirei, answers)) {
    if (binding.type === "answer") needed.add(binding.questionId);
  }
  // ② 分岐を決める質問（何かの when に出てくる questionId は答えが要る）
  for (const d of jirei.documents) {
    for (const qid of condQuestionIds(d.when)) needed.add(qid);
  }
  for (const q of jirei.questions) {
    for (const qid of condQuestionIds(q.when)) needed.add(qid);
  }
  for (const binding of allBindings(jirei)) {
    for (const qid of condQuestionIds(binding.when)) needed.add(qid);
  }
  for (const g of jirei.guards || []) {
    for (const qid of condQuestionIds(g.when)) needed.add(qid);
  }
  return jirei.questions.filter(
    (q) =>
      needed.has(q.id) &&
      condOk(q.when, answers) &&
      !(answers[q.id] && answers[q.id].trim() !== "")
  );
}

// いま有効な質問すべて（回答済みも含む）。UI の表示用。
//   pendingQuestions は「未回答だけ」なので、回答した瞬間に画面から消えてしまう。
//   判断（choice）は答えた後も見え続け、選び直せる必要がある — そのための表示集合。
//   生成のゲートは従来どおり pendingQuestions（未回答ゼロ）で判定する。
export function activeQuestions(
  jirei: Jirei,
  answers: Record<string, string>
): JireiQuestion[] {
  const needed = new Set<string>();
  for (const [, binding] of activeSlots(jirei, answers)) {
    if (binding.type === "answer") needed.add(binding.questionId);
  }
  for (const d of jirei.documents) {
    for (const qid of condQuestionIds(d.when)) needed.add(qid);
  }
  for (const q of jirei.questions) {
    for (const qid of condQuestionIds(q.when)) needed.add(qid);
  }
  for (const binding of allBindings(jirei)) {
    for (const qid of condQuestionIds(binding.when)) needed.add(qid);
  }
  for (const g of jirei.guards || []) {
    for (const qid of condQuestionIds(g.when)) needed.add(qid);
  }
  return jirei.questions.filter((q) => needed.has(q.id) && condOk(q.when, answers));
}

// 各穴 -> 値。既存の穴埋めエンジンに渡す fill map。
//   filled     : 解決できた穴 (ラベル -> 値)
//   unresolved : 値が決まらなかった穴のラベル（呼び出し側で警告 / 空扱い）
//   when を満たさないスロットは「存在しない」扱い（unresolved にも入れない）。
export function buildFillMap(
  jirei: Jirei,
  facts: Record<string, string>,
  answers: Record<string, string>
): { filled: Record<string, string>; unresolved: string[] } {
  const filled: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const [label, binding] of activeSlots(jirei, answers)) {
    const v = resolveSlot(binding, facts, answers);
    if (v === null || v === "") unresolved.push(label);
    else filled[label] = v;
  }
  return { filled, unresolved };
}
