"use client";

// 事由の「木」のレビュー画面 + 編集モード（コンソール v2）。
//
// 編集モードの原則: ★画面はレビュー表示のまま。鉛筆を押した1箇所だけがフォームに開く★
//   （全項目を一斉にフォーム化すると条件エディタが20個並んで読めなくなる — 実際になった）
//
// 表示: [聞くこと] | [分岐の選択肢ごとの書類レーン] | [共通]
// 編集: 質問の文言・選択肢・分岐条件(when)・ガード・穴の出所を 1つずつ開いて編集 → 保存。
// ★選択肢の文言を変えたら、それを参照する全 when を自動で追随させる★
// 削除は参照チェック付き。保存はサーバー側でも検証、旧版は data/jirei/history/ に退避。

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import type { Jirei, JireiCondition, JireiQuestion, SlotBinding } from "@/types/jirei";

interface TreeNode {
  label: string;
  kind: "jirei" | "branch" | "choice" | "doc" | "hole";
  source?: "fact" | "answer" | "const" | "list" | "unknown";
  detail?: string;
  badge?: string;
  cond?: string;
  children?: TreeNode[];
}

const SOURCE_ORDER = ["unknown", "answer", "fact", "list", "const"] as const;
type SourceKind = (typeof SOURCE_ORDER)[number];

const SOURCE_LABEL: Record<SourceKind, string> = {
  unknown: "出所なし",
  answer: "質問で聞く",
  fact: "資料から自動",
  list: "一覧から展開",
  const: "固定値",
};

const DOT: Record<SourceKind, string> = {
  unknown: "bg-red-500",
  answer: "bg-amber-500",
  fact: "bg-green-500",
  list: "bg-sky-500",
  const: "bg-gray-400",
};

const GROUP_TEXT: Record<SourceKind, string> = {
  unknown: "text-red-800",
  answer: "text-amber-800",
  fact: "text-green-800",
  list: "text-sky-800",
  const: "text-[var(--color-fg-muted)]",
};

const norm = (s: string) => s.replace(/[\s　]/g, "");

// ============================================================
// 条件（when）ユーティリティ
// ============================================================

interface CondRow {
  questionId: string;
  anyOf: string[];
}
interface CondModel {
  mode: "none" | "single" | "all" | "any" | "complex";
  rows: CondRow[];
}

const isAtom = (c: JireiCondition): c is { questionId: string; anyOf: string[] } =>
  !("all" in c) && !("any" in c);

function parseCond(when: JireiCondition | undefined): CondModel {
  if (!when) return { mode: "none", rows: [] };
  if (isAtom(when)) return { mode: "single", rows: [{ questionId: when.questionId, anyOf: [...when.anyOf] }] };
  const kids = "all" in when ? when.all : when.any;
  if (kids.every(isAtom)) {
    return {
      mode: "all" in when ? "all" : "any",
      rows: kids.map((k) => ({ questionId: (k as CondRow).questionId, anyOf: [...(k as CondRow).anyOf] })),
    };
  }
  return { mode: "complex", rows: [] };
}

function buildCond(m: CondModel): JireiCondition | undefined {
  const rows = m.rows.filter((r) => r.questionId && r.anyOf.length > 0);
  if (m.mode === "none" || rows.length === 0) return undefined;
  if (m.mode === "single" || rows.length === 1) return { questionId: rows[0].questionId, anyOf: rows[0].anyOf };
  return m.mode === "all" ? { all: rows } : { any: rows };
}

function humanizeCond(when: JireiCondition | undefined): string {
  if (!when) return "";
  if ("all" in when) return when.all.map(humanizeCond).join(" かつ ");
  if ("any" in when) return `（${when.any.map(humanizeCond).join(" または ")}）`;
  return `「${when.anyOf.join("・")}」のとき`;
}

function mapConds(j: Jirei, fn: (c: JireiCondition | undefined) => JireiCondition | undefined): Jirei {
  const mapBinding = (b: SlotBinding): SlotBinding => ({ ...b, when: fn(b.when) });
  return {
    ...j,
    questions: j.questions.map((q) => ({ ...q, when: fn(q.when) })),
    documents: j.documents.map((d) => ({ ...d, when: fn(d.when) })),
    guards: (j.guards || []).map((g) => ({ ...g, when: fn(g.when) })),
    slots: Object.fromEntries(
      Object.entries(j.slots).map(([label, b]) => [label, Array.isArray(b) ? b.map(mapBinding) : mapBinding(b)])
    ),
  };
}

function renameChoiceEverywhere(j: Jirei, qid: string, oldV: string, newV: string): Jirei {
  const fix = (c: JireiCondition | undefined): JireiCondition | undefined => {
    if (!c) return c;
    if ("all" in c) return { all: c.all.map((x) => fix(x)!) };
    if ("any" in c) return { any: c.any.map((x) => fix(x)!) };
    if (c.questionId !== qid) return c;
    return { ...c, anyOf: c.anyOf.map((v) => (v === oldV ? newV : v)) };
  };
  return mapConds(j, fix);
}

function collectAtoms(when: JireiCondition | undefined): CondRow[] {
  if (!when) return [];
  if ("all" in when) return when.all.flatMap(collectAtoms);
  if ("any" in when) return when.any.flatMap(collectAtoms);
  return [when];
}

function choiceRefs(j: Jirei, qid: string, val: string): string[] {
  const out: string[] = [];
  const hit = (w: JireiCondition | undefined, where: string) => {
    if (collectAtoms(w).some((a) => a.questionId === qid && a.anyOf.includes(val))) out.push(where);
  };
  j.questions.forEach((q) => hit(q.when, `質問「${q.label.slice(0, 14)}…」の条件`));
  j.documents.forEach((d) => hit(d.when, `書類「${d.templateFile}」の条件`));
  (j.guards || []).forEach((g, i) => hit(g.when, `ガード${i + 1}`));
  Object.entries(j.slots).forEach(([label, b]) =>
    (Array.isArray(b) ? b : [b]).forEach((x) => hit(x.when, `穴「${label}」の条件`))
  );
  return out;
}

function questionRefs(j: Jirei, qid: string): string[] {
  const out: string[] = [];
  const hit = (w: JireiCondition | undefined, where: string) => {
    if (collectAtoms(w).some((a) => a.questionId === qid)) out.push(where);
  };
  j.questions.forEach((q) => q.id !== qid && hit(q.when, `質問「${q.label.slice(0, 14)}…」の条件`));
  j.documents.forEach((d) => hit(d.when, `書類「${d.templateFile}」の条件`));
  (j.guards || []).forEach((g, i) => hit(g.when, `ガード${i + 1}`));
  Object.entries(j.slots).forEach(([label, b]) =>
    (Array.isArray(b) ? b : [b]).forEach((x) => {
      hit(x.when, `穴「${label}」の条件`);
      if (x.type === "answer" && x.questionId === qid) out.push(`穴「${label}」の出所`);
    })
  );
  return out;
}

const newId = () => `q_${Math.random().toString(36).slice(2, 7)}`;

// 編集中アイテムのキー
const K = {
  q: (id: string) => `q:${id}`,
  guard: (i: number) => `g:${i}`,
  doc: (f: string) => `d:${f}`,
  hole: (f: string, label: string) => `h:${f}::${label}`,
};

// ============================================================
// 条件エディタ（開いた1箇所にだけ出る）
// ============================================================

function CondEditor({
  when,
  questions,
  selfId,
  onChange,
}: {
  when: JireiCondition | undefined;
  questions: JireiQuestion[];
  selfId?: string;
  onChange: (w: JireiCondition | undefined) => void;
}) {
  const model = parseCond(when);
  const choiceQs = questions.filter((q) => q.kind === "choice" && (q.choices?.length || 0) > 0 && q.id !== selfId);
  const qById = new Map(questions.map((q) => [q.id, q]));

  if (model.mode === "complex") {
    return (
      <p className="rounded-md bg-[var(--color-hover)] px-2 py-1 text-[10.5px] text-[var(--color-fg-muted)]">
        複雑な入れ子条件（{humanizeCond(when)}）— JSON で編集してください
      </p>
    );
  }

  const update = (m: CondModel) => onChange(buildCond(m));
  const setMode = (mode: CondModel["mode"]) => {
    let rows = model.rows;
    if (mode !== "none" && rows.length === 0 && choiceQs.length > 0) {
      rows = [{ questionId: choiceQs[0].id, anyOf: [] }];
    }
    if (mode === "single") rows = rows.slice(0, 1);
    update({ mode, rows });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--color-fg-muted)]">
        出る条件:
        <select
          value={model.mode}
          onChange={(e) => setMode(e.target.value as CondModel["mode"])}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-0.5 text-[10.5px]"
        >
          <option value="none">常に</option>
          <option value="single">条件1つ</option>
          <option value="all">すべて満たすとき（かつ）</option>
          <option value="any">どれか満たすとき（または）</option>
        </select>
      </div>
      {model.mode !== "none" &&
        model.rows.map((row, ri) => {
          const q = qById.get(row.questionId);
          return (
            <div key={ri} className="rounded-md bg-[var(--color-bg)] p-1.5">
              <div className="flex items-center gap-1">
                <select
                  value={row.questionId}
                  onChange={(e) => {
                    const rows = model.rows.map((r, i) => (i === ri ? { questionId: e.target.value, anyOf: [] } : r));
                    update({ ...model, rows });
                  }}
                  className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1 py-0.5 text-[10.5px]"
                >
                  {choiceQs.map((cq) => (
                    <option key={cq.id} value={cq.id}>
                      {cq.label.slice(0, 30)}
                    </option>
                  ))}
                  {row.questionId && !choiceQs.some((cq) => cq.id === row.questionId) && (
                    <option value={row.questionId}>{row.questionId}</option>
                  )}
                </select>
                {model.mode !== "single" && model.rows.length > 1 && (
                  <button
                    onClick={() => update({ ...model, rows: model.rows.filter((_, i) => i !== ri) })}
                    className="rounded p-0.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                    title="この条件を外す"
                  >
                    <Icon name="X" size={11} />
                  </button>
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                {(q?.choices || []).map((c) => (
                  <label key={c} className="flex items-center gap-1 text-[10.5px]">
                    <input
                      type="checkbox"
                      checked={row.anyOf.includes(c)}
                      onChange={(e) => {
                        const anyOf = e.target.checked ? [...row.anyOf, c] : row.anyOf.filter((x) => x !== c);
                        update({ ...model, rows: model.rows.map((r, i) => (i === ri ? { ...r, anyOf } : r)) });
                      }}
                    />
                    {c}
                  </label>
                ))}
                {row.anyOf.length === 0 && <span className="text-[10px] text-red-600">選択肢に✓を入れてください</span>}
              </div>
            </div>
          );
        })}
      {(model.mode === "all" || model.mode === "any") && (
        <button
          onClick={() =>
            choiceQs.length > 0 && update({ ...model, rows: [...model.rows, { questionId: choiceQs[0].id, anyOf: [] }] })
          }
          className="text-[10.5px] text-[var(--color-accent-fg)] hover:underline"
        >
          ＋ 条件を足す
        </button>
      )}
    </div>
  );
}

// 鉛筆（編集の入口。開いているときは強調）
function Pencil({ active, onClick, title }: { active: boolean; onClick: () => void; title: string }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className={`shrink-0 rounded p-0.5 ${
        active
          ? "bg-[var(--color-accent)] text-white"
          : "text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-accent-fg)]"
      }`}
    >
      <Icon name="PencilLine" size={11} className={active ? "text-white" : undefined} />
    </button>
  );
}

const Q_KIND: Record<string, { label: string; cls: string }> = {
  choice: { label: "判断", cls: "bg-purple-100 text-purple-800 border-purple-300" },
  date: { label: "日付", cls: "bg-amber-50 text-amber-800 border-amber-300" },
  text: { label: "入力", cls: "bg-[var(--color-hover)] text-[var(--color-fg-muted)] border-[var(--color-border)]" },
};

interface QuestionOverview {
  label: string;
  kind: string;
  when?: string;
}

function groupHoles(holes: TreeNode[]): { source: SourceKind; items: TreeNode[] }[] {
  return SOURCE_ORDER.map((s) => ({
    source: s,
    items: holes.filter((h) => (h.source || "unknown") === s),
  })).filter((g) => g.items.length > 0);
}

// ============================================================
// 本体
// ============================================================

export default function JireiTreeView({ jireiId, onClose }: { jireiId: string; onClose: () => void }) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [questions, setQuestions] = useState<QuestionOverview[]>([]);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expandAll, setExpandAll] = useState(false);
  // --- 編集モード ---
  const [editMode, setEditMode] = useState(false);
  const [raw, setRaw] = useState<Jirei | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: "ok" | "error"; lines: string[] } | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // 開いている編集対象は常に1つ

  const fetchTree = () => {
    fetch(`/api/jirei/tree?id=${encodeURIComponent(jireiId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.tree) {
          setTree(d.tree);
          setQuestions(d.questions || []);
          setDescription(d.description || "");
          setError(null); // 一時的な通信エラーの表示を成功時に消す
        } else setError(d.error || "木を読み込めませんでした");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "通信エラー"));
  };

  useEffect(fetchTree, [jireiId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const enterEdit = async () => {
    try {
      const d = await fetch(`/api/jirei/edit?id=${encodeURIComponent(jireiId)}`).then((r) => r.json());
      if (!d.jirei) {
        setError(d.error || "木を読み込めませんでした");
        return;
      }
      setRaw(d.jirei);
      setDirty(false);
      setSaveMsg(null);
      setEditing(null);
      setEditMode(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信エラー");
    }
  };

  const mutate = (fn: (j: Jirei) => Jirei) => {
    setRaw((prev) => (prev ? fn(prev) : prev));
    setDirty(true);
    setSaveMsg(null);
  };

  const save = async () => {
    if (!raw) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const r = await fetch("/api/jirei/edit", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: jireiId, jirei: raw }),
      });
      const d = await r.json();
      if (!r.ok) {
        setSaveMsg({ kind: "error", lines: [...(d.errors || [d.error || "保存に失敗しました"])] });
        return;
      }
      setDirty(false);
      setSaveMsg({ kind: "ok", lines: ["保存しました（旧版は data/jirei/history/ に退避）", ...(d.warnings || [])] });
      fetchTree();
    } catch (e) {
      setSaveMsg({ kind: "error", lines: [e instanceof Error ? e.message : "通信に失敗しました"] });
    } finally {
      setSaving(false);
    }
  };

  const lanes = useMemo(() => {
    if (!tree) return [];
    const out: { title: string; sub?: string; kind: "choice" | "common" | "flat"; docs: TreeNode[] }[] = [];
    const kids = tree.children || [];
    const branch = kids.find((k) => k.kind === "branch");
    if (branch) {
      for (const choice of branch.children || []) {
        out.push({ title: choice.label, sub: branch.label, kind: "choice", docs: choice.children || [] });
      }
      const common = kids.find((k) => k.kind === "choice" && k !== branch);
      if (common) out.push({ title: common.label, kind: "common", docs: common.children || [] });
    } else {
      out.push({ title: "書類一式", kind: "flat", docs: kids });
    }
    return out;
  }, [tree]);

  const summary = useMemo(() => {
    const counts: Record<SourceKind, number> = { unknown: 0, answer: 0, fact: 0, list: 0, const: 0 };
    let docs = 0;
    for (const lane of lanes) {
      for (const d of lane.docs) {
        docs++;
        for (const h of d.children || []) counts[(h.source || "unknown") as SourceKind]++;
      }
    }
    return { docs, counts, holes: Object.values(counts).reduce((a, b) => a + b, 0) };
  }, [lanes]);

  const factKeys = useMemo(() => {
    if (!raw) return [];
    const keys = new Set<string>();
    for (const b of Object.values(raw.slots).flatMap((x) => (Array.isArray(x) ? x : [x]))) {
      if (b.type === "fact") keys.add(b.key);
    }
    ["会社名", "本店所在地", "代表取締役氏名", "代表取締役住所", "会社法人等番号", "総議決権数", "株主総数"].forEach((k) =>
      keys.add(k)
    );
    return [...keys].sort();
  }, [raw]);

  const slotLabelForHole = (docFile: string, hole: string): string => {
    const doc = raw?.documents.find((d) => d.templateFile === docFile);
    for (const [ph, lbl] of Object.entries(doc?.placeholders || {})) {
      if (norm(ph) === norm(hole)) return lbl;
    }
    return hole;
  };

  // ============ 編集操作 ============
  const updateQuestion = (qid: string, patch: Partial<JireiQuestion>) =>
    mutate((j) => ({ ...j, questions: j.questions.map((q) => (q.id === qid ? { ...q, ...patch } : q)) }));

  const renameChoice = (qid: string, idx: number, newV: string) =>
    mutate((j) => {
      const q = j.questions.find((x) => x.id === qid);
      if (!q || !q.choices) return j;
      const oldV = q.choices[idx];
      if (oldV === newV) return j;
      const j2 = oldV ? renameChoiceEverywhere(j, qid, oldV, newV) : j;
      return {
        ...j2,
        questions: j2.questions.map((x) =>
          x.id === qid ? { ...x, choices: x.choices!.map((c, i) => (i === idx ? newV : c)) } : x
        ),
      };
    });

  const deleteChoice = (qid: string, idx: number) => {
    if (!raw) return;
    const q = raw.questions.find((x) => x.id === qid);
    const val = q?.choices?.[idx];
    if (!q || val === undefined) return;
    const refs = choiceRefs(raw, qid, val);
    if (refs.length > 0) {
      alert(`この選択肢は使われているため消せません:\n${refs.join("\n")}\n先に分岐条件を変更してください`);
      return;
    }
    mutate((j) => ({
      ...j,
      questions: j.questions.map((x) => (x.id === qid ? { ...x, choices: x.choices!.filter((_, i) => i !== idx) } : x)),
    }));
  };

  const deleteQuestion = (qid: string) => {
    if (!raw) return;
    const refs = questionRefs(raw, qid);
    if (refs.length > 0) {
      alert(`この質問は使われているため消せません:\n${refs.join("\n")}`);
      return;
    }
    if (!confirm("この質問を削除しますか？")) return;
    setEditing(null);
    mutate((j) => ({ ...j, questions: j.questions.filter((q) => q.id !== qid) }));
  };

  const moveQuestion = (qid: string, dir: -1 | 1) =>
    mutate((j) => {
      const i = j.questions.findIndex((q) => q.id === qid);
      const t = i + dir;
      if (i < 0 || t < 0 || t >= j.questions.length) return j;
      const qs = [...j.questions];
      [qs[i], qs[t]] = [qs[t], qs[i]];
      return { ...j, questions: qs };
    });

  const addQuestion = (kind: "text" | "date" | "choice") => {
    const id = newId();
    mutate((j) => ({
      ...j,
      questions: [
        ...j.questions,
        {
          id,
          label: "",
          kind,
          ...(kind === "choice" ? { choices: ["選択肢A", "選択肢B"] } : {}),
        },
      ],
    }));
    setEditing(K.q(id));
  };

  // ============================================================
  return (
    <div className="fixed inset-0 z-50 bg-black/50 p-4 md:p-8" onClick={onClose}>
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-[var(--color-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="border-b border-[var(--color-border)] px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="text-[14px] font-semibold text-[var(--color-fg)]">
              {editMode && raw ? raw.name : tree?.label || "事由の木"}
            </span>
            {editMode && raw && (
              <Pencil active={editing === "meta"} onClick={() => setEditing(editing === "meta" ? null : "meta")} title="事由名・説明を編集" />
            )}
            <span className="text-[11px] text-[var(--color-fg-muted)]">
              {editMode ? "編集モード — 鉛筆を押した箇所だけ開きます。保存するまでファイルは変わりません" : "何を聞いて、何が出て、どこから埋まるか"}
            </span>
            <span className="ml-auto" />
            {!editMode ? (
              <>
                <button
                  onClick={enterEdit}
                  className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white"
                >
                  <span className="inline-flex items-center gap-1">
                    <Icon name="PencilLine" size={11} className="text-white" />
                    編集
                  </span>
                </button>
                <button
                  onClick={() => setExpandAll((v) => !v)}
                  className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                >
                  {expandAll ? "折りたたむ" : "全部展開"}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={save}
                  disabled={!dirty || saving}
                  className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                >
                  {saving ? "保存中..." : dirty ? "保存" : "保存済み"}
                </button>
                <button
                  onClick={() => {
                    if (dirty && !confirm("保存していない変更を捨てますか？")) return;
                    setEditMode(false);
                    setRaw(null);
                    setSaveMsg(null);
                    setEditing(null);
                    fetchTree();
                  }}
                  className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-[11px] text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                >
                  編集を終える
                </button>
              </>
            )}
            <button onClick={onClose} className="rounded-lg px-2 py-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]">
              ×
            </button>
          </div>
          {tree && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--color-fg-muted)]">
              <span className="font-medium text-[var(--color-fg)]">
                書類{summary.docs}種・穴{summary.holes}個
              </span>
              {SOURCE_ORDER.filter((s) => s !== "unknown").map(
                (s) =>
                  summary.counts[s] > 0 && (
                    <span key={s} className="inline-flex items-center gap-1">
                      <span className={`h-2 w-2 rounded-full ${DOT[s]}`} />
                      {SOURCE_LABEL[s]} {summary.counts[s]}
                    </span>
                  )
              )}
              {summary.counts.unknown > 0 ? (
                <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                  <span className={`h-2 w-2 rounded-full ${DOT.unknown}`} />
                  出所なし {summary.counts.unknown}件 — レビュー対象
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 font-medium text-green-700">
                  <Icon name="CircleCheck" size={11} />
                  出所なしゼロ
                </span>
              )}
            </div>
          )}
          {/* 事由名・説明の編集（鉛筆を押したときだけ） */}
          {editMode && raw && editing === "meta" && (
            <div className="mt-2 space-y-1.5 rounded-xl border border-[var(--color-accent)] bg-[var(--color-panel)] p-2.5">
              <input
                value={raw.name}
                onChange={(e) => mutate((j) => ({ ...j, name: e.target.value }))}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[12.5px] font-semibold"
                placeholder="事由名"
              />
              <textarea
                value={raw.description || ""}
                onChange={(e) => mutate((j) => ({ ...j, description: e.target.value }))}
                rows={3}
                placeholder="説明（前提 + 当たる依頼の言い回し。事由推定の手がかりになります）"
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px]"
              />
            </div>
          )}
          {saveMsg && (
            <div
              className={`mt-1.5 rounded-lg border p-2 text-[11px] ${
                saveMsg.kind === "ok" ? "border-green-300 bg-green-50 text-green-900" : "border-red-300 bg-red-50 text-red-800"
              }`}
            >
              {saveMsg.lines.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </div>
          )}
        </div>

        {/* 本体 */}
        <div className="flex-1 overflow-auto p-5">
          {error && <p className="text-[13px] text-red-700">{error}</p>}
          {!tree && !error && <p className="animate-pulse text-[13px] text-[var(--color-fg-muted)]">読込中...</p>}
          {tree && (
            <div className="flex items-start gap-5">
              {/* ============ 聞くことレーン ============ */}
              <div className="w-[300px] shrink-0 space-y-2">
                <div className="rounded-xl bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-semibold text-white">
                  聞くこと（{(editMode && raw ? raw.questions.length : questions.length) || 0}問）
                </div>

                {/* 表示は常にレビュー体裁。編集モードでは鉛筆が付き、開いた1件だけフォームになる */}
                {(editMode && raw
                  ? raw.questions.map((q) => ({
                      q,
                      view: { label: q.label || "（文言未入力）", kind: q.kind || "text", when: q.when ? humanizeCond(q.when) : undefined },
                    }))
                  : questions.map((v) => ({ q: null as JireiQuestion | null, view: v }))
                ).map(({ q, view }, qi) => {
                  const k = Q_KIND[view.kind] || Q_KIND.text;
                  const key = q ? K.q(q.id) : `view-${qi}`;
                  const open = q && editing === key;
                  return (
                    <div
                      key={key}
                      className={`rounded-xl border bg-[var(--color-panel)] px-3 py-2 ${
                        open ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"
                      }`}
                    >
                      <div className="flex items-start gap-1.5">
                        <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0 text-[10px] font-medium ${k.cls}`}>
                          {k.label}
                        </span>
                        <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-[var(--color-fg)]">{view.label}</span>
                        {q && (
                          <Pencil active={!!open} onClick={() => setEditing(open ? null : key)} title="この質問を編集" />
                        )}
                      </div>
                      {!open && view.when && (
                        <p className="mt-0.5 pl-1 text-[10.5px] text-[var(--color-fg-muted)]">└ {view.when}</p>
                      )}

                      {/* 開いた1件だけのフォーム */}
                      {open && q && raw && (
                        <div className="mt-2 space-y-2 border-t border-[var(--color-border)] pt-2">
                          <textarea
                            value={q.label}
                            onChange={(e) => updateQuestion(q.id, { label: e.target.value })}
                            rows={2}
                            placeholder="質問の文言"
                            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-[11.5px] leading-snug"
                          />
                          {q.kind === "choice" && (
                            <div className="space-y-1">
                              {(q.choices || []).map((c, ci) => (
                                <div key={ci} className="flex items-center gap-1">
                                  <span className="h-2 w-2 shrink-0 rounded-full border border-purple-400" />
                                  <input
                                    value={c}
                                    onChange={(e) => renameChoice(q.id, ci, e.target.value)}
                                    className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px]"
                                  />
                                  <button
                                    onClick={() => deleteChoice(q.id, ci)}
                                    className="rounded p-0.5 text-[var(--color-fg-muted)] hover:bg-red-50 hover:text-red-600"
                                    title="選択肢を削除（使用中なら止まります）"
                                  >
                                    <Icon name="X" size={11} />
                                  </button>
                                </div>
                              ))}
                              <button
                                onClick={() =>
                                  updateQuestion(q.id, { choices: [...(q.choices || []), `選択肢${(q.choices?.length || 0) + 1}`] })
                                }
                                className="text-[10.5px] text-[var(--color-accent-fg)] hover:underline"
                              >
                                ＋ 選択肢を足す
                              </button>
                              <p className="text-[10px] text-[var(--color-fg-muted)]">
                                文言を変えると、参照している分岐も自動で追随します
                              </p>
                            </div>
                          )}
                          <CondEditor
                            when={q.when}
                            questions={raw.questions}
                            selfId={q.id}
                            onChange={(w) => updateQuestion(q.id, { when: w })}
                          />
                          <div className="flex items-center gap-1 border-t border-[var(--color-border)] pt-1.5">
                            <button
                              onClick={() => moveQuestion(q.id, -1)}
                              className="rounded p-0.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                              title="上へ"
                            >
                              <Icon name="ChevronUp" size={13} />
                            </button>
                            <button
                              onClick={() => moveQuestion(q.id, 1)}
                              className="rounded p-0.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                              title="下へ"
                            >
                              <Icon name="ChevronDown" size={13} />
                            </button>
                            <button
                              onClick={() => deleteQuestion(q.id)}
                              className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-[var(--color-fg-muted)] hover:bg-red-50 hover:text-red-600"
                            >
                              <Icon name="Trash2" size={11} />
                              質問を削除
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {editMode && (
                  <div className="flex gap-1.5">
                    {(["choice", "date", "text"] as const).map((kind) => (
                      <button
                        key={kind}
                        onClick={() => addQuestion(kind)}
                        className="flex-1 rounded-xl border border-dashed border-[var(--color-border)] px-2 py-1.5 text-[10.5px] text-[var(--color-fg-muted)] hover:border-[var(--color-accent)]"
                      >
                        ＋ {kind === "choice" ? "判断" : kind === "date" ? "日付" : "入力"}
                      </button>
                    ))}
                  </div>
                )}

                {/* ガード（注意書き） */}
                {((editMode && raw) || (raw?.guards?.length ?? 0) > 0 || editMode) && editMode && raw && (
                  <>
                    <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-[12px] font-semibold text-amber-900">
                      注意書き（ガード）
                    </div>
                    {(raw.guards || []).map((g, gi) => {
                      const key = K.guard(gi);
                      const open = editing === key;
                      return (
                        <div
                          key={gi}
                          className={`rounded-xl border bg-amber-50 px-3 py-2 ${open ? "border-[var(--color-accent)]" : "border-amber-200"}`}
                        >
                          <div className="flex items-start gap-1.5">
                            <Icon name="TriangleAlert" size={12} className="mt-0.5 shrink-0 text-amber-600" />
                            <span className="min-w-0 flex-1 text-[11px] leading-snug text-amber-900">{g.message}</span>
                            <Pencil active={open} onClick={() => setEditing(open ? null : key)} title="このガードを編集" />
                          </div>
                          {!open && g.when && (
                            <p className="mt-0.5 pl-1 text-[10px] text-amber-700">└ {humanizeCond(g.when)}</p>
                          )}
                          {open && (
                            <div className="mt-2 space-y-2 border-t border-amber-200 pt-2">
                              <textarea
                                value={g.message}
                                onChange={(e) =>
                                  mutate((j) => ({
                                    ...j,
                                    guards: (j.guards || []).map((x, i) => (i === gi ? { ...x, message: e.target.value } : x)),
                                  }))
                                }
                                rows={2}
                                className="w-full rounded border border-amber-200 bg-white px-1.5 py-1 text-[11px] leading-snug"
                              />
                              <CondEditor
                                when={g.when}
                                questions={raw.questions}
                                onChange={(w) =>
                                  mutate((j) => ({
                                    ...j,
                                    guards: (j.guards || []).map((x, i) => (i === gi ? { ...x, when: w } : x)),
                                  }))
                                }
                              />
                              <button
                                onClick={() => {
                                  setEditing(null);
                                  mutate((j) => ({ ...j, guards: (j.guards || []).filter((_, i) => i !== gi) }));
                                }}
                                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-amber-800 hover:bg-red-50 hover:text-red-600"
                              >
                                <Icon name="Trash2" size={11} />
                                ガードを削除
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <button
                      onClick={() => {
                        const idx = raw.guards?.length || 0;
                        mutate((j) => ({ ...j, guards: [...(j.guards || []), { message: "" }] }));
                        setEditing(K.guard(idx));
                      }}
                      className="w-full rounded-xl border border-dashed border-amber-300 px-2 py-1.5 text-[10.5px] text-amber-800 hover:bg-amber-50"
                    >
                      ＋ 注意書きを追加
                    </button>
                  </>
                )}

                {!editMode && description && (
                  <p className="rounded-xl border border-dashed border-[var(--color-border)] p-2.5 text-[10.5px] leading-relaxed text-[var(--color-fg-muted)]">
                    {description}
                  </p>
                )}
              </div>

              {/* ============ 書類レーン ============ */}
              {lanes.map((lane, i) => (
                <div key={i} className="w-[330px] shrink-0 space-y-2">
                  <div
                    className={`rounded-xl px-3 py-1.5 text-[12px] font-semibold ${
                      lane.kind === "choice"
                        ? "border border-purple-300 bg-purple-100 text-purple-900"
                        : "border border-[var(--color-border)] bg-[var(--color-hover)] text-[var(--color-fg)]"
                    }`}
                  >
                    {lane.sub && (
                      <span className="flex items-center gap-1 text-[10px] font-medium opacity-70">
                        <Icon name="GitBranch" size={10} />
                        {lane.sub}
                      </span>
                    )}
                    {lane.title}
                    <span className="ml-1.5 text-[10.5px] font-normal opacity-70">書類{lane.docs.length}種</span>
                  </div>
                  {lane.docs.length === 0 && (
                    <p className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-2.5 text-[11px] text-amber-800">
                      この枝の書類は未登録（ガードで案内されます）
                    </p>
                  )}
                  {lane.docs.map((d, j) => {
                    const rawDoc = raw?.documents.find((x) => x.templateFile === d.label);
                    const docKey = K.doc(d.label);
                    const docOpen = editing === docKey;
                    const groups = groupHoles(d.children || []);
                    return (
                      <div key={j} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-3">
                        <div className="flex items-start gap-1.5 text-[12.5px] font-semibold text-[var(--color-fg)]">
                          <Icon
                            name={d.label.endsWith(".xlsx") ? "Sheet" : "FileText"}
                            size={13}
                            className="mt-0.5 shrink-0 text-[var(--color-accent-fg)]"
                          />
                          <span className="min-w-0 flex-1 break-all">{d.label.replace(/\.(docx|xlsx)$/i, "")}</span>
                          {editMode && rawDoc && (
                            <Pencil active={docOpen} onClick={() => setEditing(docOpen ? null : docKey)} title="出る条件を編集" />
                          )}
                        </div>
                        {d.badge && (
                          <span className="mt-1 inline-block rounded-full bg-[var(--color-accent)] px-2 py-0.5 text-[10px] text-white">
                            {d.badge}
                          </span>
                        )}
                        {!docOpen && (editMode && rawDoc ? rawDoc.when : d.cond) && (
                          <p className="mt-1 rounded-md border border-purple-200 bg-purple-50 px-2 py-1 text-[10.5px] leading-snug text-purple-900">
                            出る条件: {editMode && rawDoc ? humanizeCond(rawDoc.when) : d.cond}
                          </p>
                        )}
                        {docOpen && raw && rawDoc && (
                          <div className="mt-1.5 rounded-lg border border-[var(--color-accent)] bg-[var(--color-bg)] p-2">
                            <CondEditor
                              when={rawDoc.when}
                              questions={raw.questions}
                              onChange={(w) =>
                                mutate((j2) => ({
                                  ...j2,
                                  documents: j2.documents.map((x) =>
                                    x.templateFile === rawDoc.templateFile ? { ...x, when: w } : x
                                  ),
                                }))
                              }
                            />
                          </div>
                        )}
                        <div className="mt-1.5 space-y-1">
                          {groups.map((g) =>
                            g.source === "unknown" ? (
                              <div key={g.source} className="rounded-lg border border-red-300 bg-red-50 px-2 py-1.5">
                                <p className="flex items-center gap-1 text-[11px] font-semibold text-red-800">
                                  <Icon name="TriangleAlert" size={11} />
                                  出所なし {g.items.length}件 — レビュー対象
                                </p>
                                {g.items.map((h, hi) => (
                                  <HoleLine
                                    key={hi}
                                    hole={h}
                                    editMode={editMode}
                                    raw={raw}
                                    docFile={d.label}
                                    editing={editing}
                                    setEditing={setEditing}
                                    slotLabelForHole={slotLabelForHole}
                                    mutate={mutate}
                                    factKeys={factKeys}
                                  />
                                ))}
                              </div>
                            ) : (
                              <details
                                key={`${g.source}-${expandAll}`}
                                open={expandAll || g.source === "answer"}
                                className="group rounded-lg border border-[var(--color-border)] px-2 py-1"
                              >
                                <summary
                                  className={`flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold ${GROUP_TEXT[g.source]}`}
                                >
                                  <Icon name="ChevronRight" size={10} className="shrink-0 transition-transform group-open:rotate-90" />
                                  <span className={`h-2 w-2 rounded-full ${DOT[g.source]}`} />
                                  {SOURCE_LABEL[g.source]} {g.items.length}件
                                </summary>
                                <div className="mt-0.5 border-t border-[var(--color-border)] pt-1">
                                  {g.items.map((h, hi) => (
                                    <HoleLine
                                      key={hi}
                                      hole={h}
                                      editMode={editMode}
                                      raw={raw}
                                      docFile={d.label}
                                      editing={editing}
                                      setEditing={setEditing}
                                      slotLabelForHole={slotLabelForHole}
                                      mutate={mutate}
                                      factKeys={factKeys}
                                    />
                                  ))}
                                </div>
                              </details>
                            )
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-fg-muted)]">
          {editMode
            ? "穴の色分けは保存すると更新されます。旧版は data/jirei/history/ に残ります"
            : "「編集」から質問・選択肢・分岐・ガード・穴の出所を変更できます"}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 穴1行（表示 + 鉛筆。開いた1件だけ出所エディタ）
// ============================================================

function HoleLine({
  hole,
  editMode,
  raw,
  docFile,
  editing,
  setEditing,
  slotLabelForHole,
  mutate,
  factKeys,
}: {
  hole: TreeNode;
  editMode: boolean;
  raw: Jirei | null;
  docFile: string;
  editing: string | null;
  setEditing: (k: string | null) => void;
  slotLabelForHole: (docFile: string, hole: string) => string;
  mutate: (fn: (j: Jirei) => Jirei) => void;
  factKeys: string[];
}) {
  const src = (hole.source || "unknown") as SourceKind;
  const editable = editMode && raw && src !== "list";
  const slotLabel = editable ? slotLabelForHole(docFile, hole.label) : "";
  const key = K.hole(docFile, slotLabel);
  const open = editable && editing === key;
  const rawBinding = editable ? raw!.slots[slotLabel] : undefined;
  const isArray = Array.isArray(rawBinding);
  const current: SlotBinding = !rawBinding || isArray ? { type: "const", value: "" } : (rawBinding as SlotBinding);

  const setBinding = (b: SlotBinding) => mutate((j) => ({ ...j, slots: { ...j.slots, [slotLabel]: b } }));

  return (
    <div className="py-0.5">
      <div className="flex items-baseline gap-1.5 text-[11.5px] leading-snug">
        <span className={`mt-1 h-1.5 w-1.5 shrink-0 self-start rounded-full ${DOT[src]}`} />
        <span className="shrink-0 font-medium text-[var(--color-fg)]">{hole.label}</span>
        {hole.detail && <span className="min-w-0 text-[var(--color-fg-muted)]">← {hole.detail}</span>}
        {editable && !isArray && (
          <span className="ml-auto">
            <Pencil active={!!open} onClick={() => setEditing(open ? null : key)} title="出所を編集" />
          </span>
        )}
      </div>
      {editable && isArray && (
        <p className="pl-3 text-[10px] text-[var(--color-fg-muted)]">分岐で出所が変わる穴（JSON で編集）</p>
      )}
      {open && (
        <div className="mt-1 space-y-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-bg)] p-1.5 text-[10.5px]">
          <div className="flex items-center gap-1.5">
            出所:
            <select
              value={current.type}
              onChange={(e) => {
                const t = e.target.value;
                if (t === "fact") setBinding({ type: "fact", key: "", when: current.when });
                else if (t === "answer") setBinding({ type: "answer", questionId: raw!.questions[0]?.id || "", when: current.when });
                else setBinding({ type: "const", value: "", when: current.when });
              }}
              className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1 py-0.5 text-[10.5px]"
            >
              <option value="fact">資料から自動</option>
              <option value="answer">質問で聞く</option>
              <option value="const">固定値</option>
            </select>
          </div>
          {current.type === "fact" && (
            <div>
              <input
                list="fact-keys"
                value={current.key}
                onChange={(e) => setBinding({ ...current, key: e.target.value })}
                placeholder="事実キー（例: 会社名・本店所在地）"
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1.5 py-0.5 text-[10.5px]"
              />
              <datalist id="fact-keys">
                {factKeys.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </div>
          )}
          {current.type === "answer" && (
            <select
              value={current.questionId}
              onChange={(e) => setBinding({ ...current, questionId: e.target.value })}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1 py-0.5 text-[10.5px]"
            >
              {raw!.questions.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.label.slice(0, 34)}
                </option>
              ))}
            </select>
          )}
          {current.type === "const" && (
            <input
              value={current.value}
              onChange={(e) => setBinding({ ...current, value: e.target.value })}
              placeholder="固定の文言"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1.5 py-0.5 text-[10.5px]"
            />
          )}
        </div>
      )}
    </div>
  );
}
