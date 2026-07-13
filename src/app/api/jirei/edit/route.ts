// 木の編集 API（コンソール v2 の裏側）。
//
//   GET /api/jirei/edit?id=<jireiId>  … 木の生 JSON（編集用）
//   PUT /api/jirei/edit               … { id, jirei } を検証して保存
//
// 保存前に検証する（loader は無検証なので、壊れた木は「分岐が無言で死ぬ」形で現れる。
// 編集 UI 経由の保存はここで堰き止める）:
//   - when が参照する questionId が実在するか
//   - when の anyOf が参照先 choice 質問の選択肢に含まれるか
//   - slots の answer が参照する questionId が実在するか
// 旧版は data/jirei/history/<id>/ にバックアップしてから上書きする（戻せる）。

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { loadJirei } from "@/lib/jirei/loader";
import { condQuestionIds } from "@/lib/event-filing/select";
import type { Jirei, JireiCondition, SlotBinding } from "@/types/jirei";

const JIREI_DIR = path.join(process.cwd(), "data", "jirei");

function collectAtoms(when: JireiCondition | undefined): { questionId: string; anyOf: string[] }[] {
  if (!when) return [];
  if ("all" in when) return when.all.flatMap(collectAtoms);
  if ("any" in when) return when.any.flatMap(collectAtoms);
  return [when];
}

// 木の整合性チェック。errors = 保存を止める / warnings = 保存はするが表示する
function validateJirei(j: Jirei): { errors: string[]; warnings: string[] } {
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

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id は必須です" }, { status: 400 });
  const jirei = await loadJirei(id);
  if (!jirei) return NextResponse.json({ error: "事由が見つかりません" }, { status: 404 });
  return NextResponse.json({ jirei });
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const id: string | undefined = body.id;
    const jirei: Jirei | undefined = body.jirei;
    if (!id || !jirei) return NextResponse.json({ error: "id と jirei は必須です" }, { status: 400 });
    if (jirei.id !== id) return NextResponse.json({ error: "id が一致しません" }, { status: 400 });
    if (!/^[a-z0-9-]+$/.test(id)) return NextResponse.json({ error: "不正な id です" }, { status: 400 });

    const { errors, warnings } = validateJirei(jirei);
    if (errors.length > 0) return NextResponse.json({ error: "検証エラー", errors, warnings }, { status: 422 });

    // 旧版をバックアップしてから上書き（編集ミスから戻せるように）
    const target = path.join(JIREI_DIR, `${id}.json`);
    try {
      const old = await fs.readFile(target, "utf-8");
      const histDir = path.join(JIREI_DIR, "history", id);
      await fs.mkdir(histDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.writeFile(path.join(histDir, `${stamp}.json`), old, "utf-8");
    } catch {
      /* 新規（バックアップ対象なし） */
    }
    await fs.writeFile(target, JSON.stringify(jirei, null, 2), "utf-8");
    return NextResponse.json({ ok: true, warnings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "保存に失敗しました" }, { status: 500 });
  }
}
