// 木の整合性チェック（編集保存と AI 仮生成の両方が使う）。
// errors = 保存・適用を止める / warnings = 通すが人に見せる。
// loader は無検証なので、木がここを通らずに壊れると「分岐が無言で死ぬ」形で現れる。

import { condQuestionIds } from "@/lib/event-filing/select";
import type { Jirei, JireiCondition, SlotBinding } from "@/types/jirei";

export function collectAtoms(when: JireiCondition | undefined): { questionId: string; anyOf: string[] }[] {
  if (!when) return [];
  if ("all" in when) return when.all.flatMap(collectAtoms);
  if ("any" in when) return when.any.flatMap(collectAtoms);
  return [when];
}

export function validateJirei(j: Jirei): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const qById = new Map(j.questions.map((q) => [q.id, q]));

  const checkCond = (when: JireiCondition | undefined, where: string) => {
    for (const atom of collectAtoms(when)) {
      const q = qById.get(atom.questionId);
      if (!q) {
        errors.push(`${where}: 分岐が存在しない質問を参照しています（${atom.questionId}）`);
        continue;
      }
      if (atom.anyOf.length === 0) {
        errors.push(`${where}: 分岐の選択肢が空です（絶対に成立しない条件）`);
      }
      if (q.kind === "choice" && q.choices) {
        for (const v of atom.anyOf) {
          if (!q.choices.includes(v)) {
            errors.push(`${where}: 分岐の値「${v}」が質問「${q.label.slice(0, 20)}…」の選択肢にありません`);
          }
        }
      }
    }
  };

  j.questions.forEach((q) => {
    if (!q.id) errors.push("id の無い質問があります");
    if (!q.label?.trim()) errors.push(`質問 ${q.id}: 文言が空です`);
    if (q.kind === "choice" && (!q.choices || q.choices.length < 2)) {
      errors.push(`質問 ${q.id}: choice なのに選択肢が2つ未満です`);
    }
    checkCond(q.when, `質問「${(q.label || q.id).slice(0, 20)}」`);
  });
  const ids = j.questions.map((q) => q.id);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length > 0) errors.push(`質問 id が重複しています: ${[...new Set(dup)].join(", ")}`);

  j.documents.forEach((d) => checkCond(d.when, `書類「${d.templateFile}」`));
  (j.guards || []).forEach((g, i) => checkCond(g.when, `ガード${i + 1}`));

  const bindings: [string, SlotBinding][] = Object.entries(j.slots).flatMap(([label, b]) =>
    (Array.isArray(b) ? b : [b]).map((x) => [label, x] as [string, SlotBinding])
  );
  for (const [label, b] of bindings) {
    checkCond(b.when, `穴「${label}」`);
    if (b.type === "answer" && !qById.has(b.questionId)) {
      errors.push(`穴「${label}」: 存在しない質問（${b.questionId}）を出所にしています`);
    }
    if (b.type === "const" && !(b.value ?? "").trim()) {
      warnings.push(`穴「${label}」: 固定値が空です（空文字で埋まります）`);
    }
  }

  // どこからも参照されていない質問（絶対に聞かれない）
  const referenced = new Set<string>();
  for (const [, b] of bindings) {
    if (b.type === "answer") referenced.add(b.questionId);
    for (const qid of condQuestionIds(b.when)) referenced.add(qid);
  }
  for (const d of j.documents) for (const qid of condQuestionIds(d.when)) referenced.add(qid);
  for (const q of j.questions) for (const qid of condQuestionIds(q.when)) referenced.add(qid);
  for (const g of j.guards || []) for (const qid of condQuestionIds(g.when)) referenced.add(qid);
  for (const q of j.questions) {
    if (!referenced.has(q.id)) {
      warnings.push(`質問「${q.label.slice(0, 24)}…」はどの穴・分岐からも参照されていないため、聞かれません`);
    }
  }

  return { errors, warnings };
}
