"use client";

// 事由の「木」のレビュー画面 + 編集モード（コンソール v2）。
//
// 判断の枝分かれは★左→右のロジックツリー★で描く（枝とその先の分岐は別の列）:
//
//   [定款変更は必要?]─┬─[必要]────[決議方法?]─┬─[書面決議]──日付4問
//                     │                       └─[実開催]────⚠ガード
//                     └─[不要]────[誰が決める?]─┬─[取締役の決定]─⚠ガード
//                                              └─[総会で決める]─↩前出
//
// 書類レーンはその下。編集フォームはツリーの中に開かず、右側の固定パネルに出す
// （ツリーは常にレビュー表示のまま崩れない）。
// ★選択肢の文言を変えたら、それを参照する全 when を自動で追随させる★
// 削除は参照チェック付き。保存はサーバー側でも検証、旧版は data/jirei/history/ に退避。

import { useEffect, useMemo, useState, type ReactNode } from "react";
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

type JireiGuard = { when?: JireiCondition; message: string };

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

const K = {
  q: (id: string) => `q:${id}`,
  guard: (i: number) => `g:${i}`,
  doc: (f: string) => `d:${f}`,
  hole: (f: string, label: string) => `h:${f}::${label}`,
};

// 分岐ツリーでの「この枝にぶら下がるか」判定。
//   single / any → その原子条件の枝すべてに（any は各枝が独立の引き金。2回目以降は前出参照）
//   all → 最後の原子条件の枝にだけ（最も深い条件の下）
function attachesTo(when: JireiCondition | undefined, qid: string, choice: string): boolean {
  const m = parseCond(when);
  if (m.mode === "single" || m.mode === "any") {
    return m.rows.some((r) => r.questionId === qid && r.anyOf.includes(choice));
  }
  if (m.mode === "all") {
    const last = m.rows[m.rows.length - 1];
    return !!last && last.questionId === qid && last.anyOf.includes(choice);
  }
  return false;
}

// ============================================================
// 条件エディタ（右パネル内で使う）
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
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
        出る条件:
        <select
          value={model.mode}
          onChange={(e) => setMode(e.target.value as CondModel["mode"])}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-0.5 text-[11px]"
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
            <div key={ri} className="rounded-md bg-[var(--color-hover)] p-1.5">
              <div className="flex items-center gap-1">
                <select
                  value={row.questionId}
                  onChange={(e) => {
                    const rows = model.rows.map((r, i) => (i === ri ? { questionId: e.target.value, anyOf: [] } : r));
                    update({ ...model, rows });
                  }}
                  className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1 py-0.5 text-[11px]"
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
                  <label key={c} className="flex items-center gap-1 text-[11px]">
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
          className="text-[11px] text-[var(--color-accent-fg)] hover:underline"
        >
          ＋ 条件を足す
        </button>
      )}
    </div>
  );
}

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

function groupHoles(holes: TreeNode[]): { source: SourceKind; items: TreeNode[] }[] {
  return SOURCE_ORDER.map((s) => ({
    source: s,
    items: holes.filter((h) => (h.source || "unknown") === s),
  })).filter((g) => g.items.length > 0);
}

// ============================================================
// 判断の枝分かれ（左→右のロジックツリー）
// ============================================================

type FlowNode =
  | { t: "q"; q: JireiQuestion; condNote?: string; children: FlowNode[] }
  | { t: "choice"; label: string; children: FlowNode[] }
  | { t: "guard"; g: JireiGuard; gi: number; condNote?: string; children: [] }
  | { t: "ref"; label: string; children: [] }
  | { t: "none"; children: [] };

// 自分の箱 + 右側に子を縦に並べて罫線でつなぐ（横方向ツリー）。
// つなぎの棒は 2px のはっきりした線で描く（薄いと枝の対応が追えない）。
const RAIL = "border-gray-400";
function FlowBranch({ node, box }: { node: FlowNode; box: (n: FlowNode) => ReactNode }) {
  const kids = node.children || [];
  const multi = kids.length > 1;
  return (
    <div className="flex items-center">
      <div className="shrink-0">{box(node)}</div>
      {/* 分岐の付け根: 箱から横に出て（─）、縦の幹（│）に突き当たって上下の枝に割れる（┬ の形） */}
      {multi && <div className={`w-4 shrink-0 border-t-2 ${RAIL}`} />}
      {kids.length > 0 && (
        <div className="flex flex-col justify-center">
          {kids.map((c, i) => {
            const first = i === 0;
            const last = i === kids.length - 1;
            const single = kids.length === 1;
            return (
              <div key={i} className="flex items-center">
                {single ? (
                  // 子が1つ → 箱から箱まで1本の横棒でつなぐ
                  <div className={`w-8 shrink-0 border-t-2 ${RAIL}`} />
                ) : (
                  <>
                    {/* 縦の幹（兄弟の間を貫く縦棒） + 各枝への横棒。
                        h-full だと親が auto 高さのとき 0 に潰れて線が消える — self-stretch のみで伸ばす。
                        幹の div は幅0にする（幅を持たせると線が左端に描かれ、横枝との間に隙間ができて宙に浮く） */}
                    <div className="flex w-0 flex-col self-stretch">
                      <div className={`flex-1 ${!first ? `border-l-2 ${RAIL}` : ""}`} />
                      <div className={`flex-1 ${!last ? `border-l-2 ${RAIL}` : ""}`} />
                    </div>
                    <div className={`w-4 shrink-0 border-t-2 ${RAIL}`} />
                  </>
                )}
                <div className="py-1.5">
                  <FlowBranch node={c} box={box} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 本体
// ============================================================

export default function JireiTreeView({ jireiId, onClose }: { jireiId: string; onClose: () => void }) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [questions, setQuestions] = useState<JireiQuestion[]>([]);
  const [guards, setGuards] = useState<JireiGuard[]>([]);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expandAll, setExpandAll] = useState(false);
  // --- 編集モード ---
  const [editMode, setEditMode] = useState(false);
  const [raw, setRaw] = useState<Jirei | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: "ok" | "error"; lines: string[] } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // AI 仮生成（枝分かれの下書き。ファイルには書かない — レビューして保存で確定）
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiRunning, setAiRunning] = useState(false);
  const [aiNotes, setAiNotes] = useState<string[] | null>(null);
  const [aiFor, setAiFor] = useState<string | null>(null); // "all" or 重点対象の質問id（結果表示の対応付け用）

  const fetchTree = () => {
    fetch(`/api/jirei/tree?id=${encodeURIComponent(jireiId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.tree) {
          setTree(d.tree);
          setQuestions(d.questions || []);
          setGuards(d.guards || []);
          setDescription(d.description || "");
          setError(null);
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
        { id, label: "", kind, ...(kind === "choice" ? { choices: ["選択肢A", "選択肢B"] } : {}) },
      ],
    }));
    setEditing(K.q(id));
  };

  const qs = editMode && raw ? raw.questions : questions;
  const gs: JireiGuard[] = editMode && raw ? raw.guards || [] : guards;

  // ============ 判断の枝分かれ（FlowNode の組み立て） ============
  const flow = useMemo(() => {
    const rendered = new Set<string>();
    const renderedG = new Set<number>();
    const qNode = (q: JireiQuestion): FlowNode => {
      if (rendered.has(q.id)) return { t: "ref", label: q.label, children: [] };
      rendered.add(q.id);
      const m = parseCond(q.when);
      const condNote = m.mode === "all" || m.mode === "any" ? humanizeCond(q.when) : undefined;
      let children: FlowNode[] = [];
      if (q.kind === "choice" && (q.choices?.length || 0) > 0) {
        children = q.choices!.map((c) => {
          const kidGs = gs
            .map((g, i) => ({ g, i }))
            .filter(({ g, i }) => !renderedG.has(i) && attachesTo(g.when, q.id, c));
          kidGs.forEach(({ i }) => renderedG.add(i));
          const kidQs = qs.filter((x) => x.id !== q.id && attachesTo(x.when, q.id, c));
          const kids: FlowNode[] = [
            ...kidGs.map(({ g, i }) => ({
              t: "guard" as const,
              g,
              gi: i,
              condNote: parseCond(g.when).rows.length > 1 ? humanizeCond(g.when) : undefined,
              children: [] as [],
            })),
            ...kidQs.map(qNode),
          ];
          return { t: "choice" as const, label: c, children: kids.length > 0 ? kids : [{ t: "none" as const, children: [] as [] }] };
        });
      }
      return { t: "q", q, condNote, children };
    };
    const roots = qs.filter((q) => !q.when).map(qNode);
    const stray = qs.filter((q) => !rendered.has(q.id));
    const freeGuards = gs.map((g, i) => ({ g, i })).filter(({ i }) => !renderedG.has(i));
    return { roots, stray, freeGuards };
  }, [qs, gs]);

  // 枝ツリーのノードの箱（コンパクト。編集は鉛筆→右パネル）
  const flowBox = (n: FlowNode): ReactNode => {
    if (n.t === "none") {
      return <span className="text-[10.5px] text-[var(--color-fg-muted)]">追加の質問なし</span>;
    }
    if (n.t === "ref") {
      return (
        <div
          className="w-[170px] rounded-lg border border-dashed border-[var(--color-border)] px-2 py-1 text-[10.5px] text-[var(--color-fg-muted)]"
          title={n.label}
        >
          ↩ {n.label.slice(0, 16)}…（前出）
        </div>
      );
    }
    if (n.t === "choice") {
      return (
        <div
          className="max-w-[190px] rounded-full border border-purple-300 bg-purple-50 px-2.5 py-1 text-[10.5px] font-medium leading-tight text-purple-900"
          title={n.label}
        >
          {n.label.length > 22 ? `${n.label.slice(0, 22)}…` : n.label}
        </div>
      );
    }
    if (n.t === "guard") {
      const open = editing === K.guard(n.gi);
      return (
        <div
          onClick={() => editMode && setEditing(open ? null : K.guard(n.gi))}
          className={`w-[210px] rounded-xl border px-2.5 py-1.5 ${open ? "border-[var(--color-accent)]" : "border-amber-300"} bg-amber-50 ${
            editMode ? "cursor-pointer hover:border-[var(--color-accent)]" : ""
          }`}
          title={editMode ? "クリックで編集" : n.g.message + (n.condNote ? `\n条件: ${n.condNote}` : "")}
        >
          <div className="flex items-start gap-1.5">
            <Icon name="TriangleAlert" size={11} className="mt-0.5 shrink-0 text-amber-600" />
            <span className="min-w-0 flex-1 text-[10.5px] leading-snug text-amber-900 line-clamp-2">
              {n.g.message || "（文言未入力）"}
            </span>
            {editMode && (
              <Pencil active={open} onClick={() => setEditing(open ? null : K.guard(n.gi))} title="この注意書きを編集" />
            )}
          </div>
        </div>
      );
    }
    // 質問
    const q = n.q;
    const k = Q_KIND[q.kind || "text"] || Q_KIND.text;
    const open = editing === K.q(q.id);
    return (
      <div
        onClick={() => editMode && setEditing(open ? null : K.q(q.id))}
        className={`w-[230px] rounded-xl border bg-[var(--color-panel)] px-2.5 py-1.5 ${
          open ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"
        } ${editMode ? "cursor-pointer hover:border-[var(--color-accent)]" : ""}`}
        title={editMode ? "クリックで編集" : q.label + (n.condNote ? `\n条件: ${n.condNote}` : "")}
      >
        <div className="flex items-start gap-1.5">
          <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0 text-[10px] font-medium ${k.cls}`}>{k.label}</span>
          <span className="min-w-0 flex-1 text-[11px] leading-snug text-[var(--color-fg)] line-clamp-2">
            {q.label || "（文言未入力）"}
          </span>
          {editMode && <Pencil active={open} onClick={() => setEditing(open ? null : K.q(q.id))} title="この質問を編集" />}
        </div>
        {n.condNote && <p className="mt-0.5 truncate pl-1 text-[10px] text-[var(--color-fg-muted)]">条件: {n.condNote}</p>}
      </div>
    );
  };

  // AI に枝分かれを下書きさせる（結果は編集バッファへ。保存するまでファイルは変わらない）。
  // focusQuestionId を渡すと「この判断の下の枝」を重点的に育てる（判断カードから呼ぶ文脈付き仮生成）。
  const runAiBranches = async (focusQuestionId?: string) => {
    setAiRunning(true);
    setAiNotes(null);
    setAiFor(focusQuestionId || "all");
    setError(null);
    try {
      const r = await fetch("/api/jirei/suggest-branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: jireiId, instruction: aiInstruction, focusQuestionId }),
      });
      const d = await r.json();
      if (!r.ok) {
        setAiNotes([d.error || "仮生成に失敗しました", ...(d.errors || [])]);
        return;
      }
      setRaw(d.jirei);
      setDirty(true);
      setAiNotes([
        "枝分かれの下書きを木に反映しました（未保存）。左のツリーでレビューしてください。",
        ...(d.notes || []),
        ...(d.warnings || []),
      ]);
    } catch (e) {
      setAiNotes([e instanceof Error ? e.message : "通信に失敗しました"]);
    } finally {
      setAiRunning(false);
    }
  };

  // ============ 右側の編集パネルの中身 ============
  const editTarget = useMemo(() => {
    if (!editMode || !raw || !editing) return null;
    if (editing === "meta") return { kind: "meta" as const };
    if (editing === "ai") return { kind: "ai" as const };
    if (editing.startsWith("q:")) {
      const q = raw.questions.find((x) => x.id === editing.slice(2));
      return q ? { kind: "q" as const, q } : null;
    }
    if (editing.startsWith("g:")) {
      const gi = Number(editing.slice(2));
      const g = (raw.guards || [])[gi];
      return g !== undefined ? { kind: "g" as const, g, gi } : null;
    }
    return null; // 書類・穴はカード内インラインのまま
  }, [editMode, raw, editing]);

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
              {editMode ? "編集モード — 鉛筆を押すと右側に編集パネルが開きます" : "何を聞いて、何が出て、どこから埋まるか"}
            </span>
            <span className="ml-auto" />
            {!editMode ? (
              <>
                <button onClick={enterEdit} className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white">
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
                  onClick={() => setEditing(editing === "ai" ? null : "ai")}
                  className={`rounded-lg border px-3 py-1 text-[11px] font-medium ${
                    editing === "ai"
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                      : "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent)] hover:text-white"
                  }`}
                >
                  <span className="inline-flex items-center gap-1">
                    <Icon name="Sparkles" size={11} />
                    AIで枝を仮生成
                  </span>
                </button>
                <button
                  onClick={save}
                  disabled={!dirty || saving}
                  className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                >
                  {saving ? "保存中..." : "保存"}
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
          {/* 編集モードの案内（何をすればいいかが画面から分かるように。編集を始めたら消える） */}
          {editMode && !editing && !dirty && !saveMsg && (
            <div className="mt-1.5 rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-2 text-[11.5px] text-[var(--color-fg)]">
              <span className="inline-flex items-center gap-1.5">
                <Icon name="MousePointerClick" size={13} className="text-[var(--color-accent-fg)]" />
                変えたいカードをクリックしてください（質問・注意書き・書類名・穴の行）— エディタが開きます。
                枝分かれごと AI に下書きさせるなら右上の「AIで枝を仮生成」。「保存」を押すまでファイルは変わりません
              </span>
            </div>
          )}
        </div>

        {/* 本体（右パネルの分だけ右余白） */}
        <div className="relative flex-1 overflow-hidden">
          <div className={`h-full overflow-auto p-5 ${editTarget ? "pr-[400px]" : ""}`}>
            {error && <p className="text-[13px] text-red-700">{error}</p>}
            {!tree && !error && <p className="animate-pulse text-[13px] text-[var(--color-fg-muted)]">読込中...</p>}
            {tree && (
              <div className="space-y-6">
                {/* ============ 判断の枝分かれ（左→右） ============ */}
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="rounded-xl bg-[var(--color-accent)] px-3 py-1 text-[12px] font-semibold text-white">
                      判断の枝分かれ（{qs.length}問）
                    </span>
                    <span className="text-[11px] text-[var(--color-fg-muted)]">左から右へ。選択肢の先に、その選択で増える質問と注意書き</span>
                  </div>
                  <div className="space-y-4 overflow-x-auto pb-2">
                    {flow.roots.map((n, i) => (
                      <FlowBranch key={i} node={n} box={flowBox} />
                    ))}
                    {flow.stray.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10.5px] font-medium text-[var(--color-fg-muted)]">条件付き（枝に置けなかったもの）</p>
                        <div className="flex flex-wrap gap-2">
                          {flow.stray.map((q) => (
                            <div key={q.id}>{flowBox({ t: "q", q, condNote: humanizeCond(q.when), children: [] })}</div>
                          ))}
                        </div>
                      </div>
                    )}
                    {flow.freeGuards.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {flow.freeGuards.map(({ g, i }) => (
                          <div key={i}>{flowBox({ t: "guard", g, gi: i, condNote: g.when ? humanizeCond(g.when) : undefined, children: [] })}</div>
                        ))}
                      </div>
                    )}
                  </div>
                  {editMode && (
                    <div className="mt-2 flex gap-1.5">
                      {(["choice", "date", "text"] as const).map((kind) => (
                        <button
                          key={kind}
                          onClick={() => addQuestion(kind)}
                          className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[10.5px] text-[var(--color-fg-muted)] hover:border-[var(--color-accent)]"
                        >
                          ＋ {kind === "choice" ? "判断" : kind === "date" ? "日付" : "入力"}を追加
                        </button>
                      ))}
                      <button
                        onClick={() => {
                          const idx = raw?.guards?.length || 0;
                          mutate((j) => ({ ...j, guards: [...(j.guards || []), { message: "" }] }));
                          setEditing(K.guard(idx));
                        }}
                        className="rounded-xl border border-dashed border-amber-300 px-3 py-1.5 text-[10.5px] text-amber-800 hover:bg-amber-50"
                      >
                        ＋ 注意書きを追加
                      </button>
                      <button
                        onClick={() => setEditing("ai")}
                        className="rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-1.5 text-[10.5px] font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent)] hover:text-white"
                      >
                        <span className="inline-flex items-center gap-1">
                          <Icon name="Sparkles" size={11} />
                          AIで枝分かれを仮生成
                        </span>
                      </button>
                    </div>
                  )}
                  {!editMode && description && (
                    <p className="mt-2 max-w-[720px] rounded-xl border border-dashed border-[var(--color-border)] p-2.5 text-[10.5px] leading-relaxed text-[var(--color-fg-muted)]">
                      {description}
                    </p>
                  )}
                </div>

                {/* ============ 書類レーン ============ */}
                <div>
                  <div className="mb-2">
                    <span className="rounded-xl border border-[var(--color-border)] bg-[var(--color-hover)] px-3 py-1 text-[12px] font-semibold text-[var(--color-fg)]">
                      書類と穴（{summary.docs}種）
                    </span>
                  </div>
                  <div className="flex items-start gap-5 overflow-x-auto pb-2">
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
                              <div
                                onClick={() => editMode && rawDoc && setEditing(docOpen ? null : docKey)}
                                title={editMode && rawDoc ? "クリックで出る条件を編集" : undefined}
                                className={`flex items-start gap-1.5 text-[12.5px] font-semibold text-[var(--color-fg)] ${
                                  editMode && rawDoc ? "cursor-pointer hover:text-[var(--color-accent-fg)]" : ""
                                }`}
                              >
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
                </div>
              </div>
            )}
          </div>

          {/* ============ 右側の編集パネル（開いている1件だけ） ============ */}
          {editTarget && raw && (
            <div className="absolute bottom-0 right-0 top-0 z-10 w-[380px] overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-panel)] p-4 shadow-2xl">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[12.5px] font-semibold text-[var(--color-fg)]">
                  {editTarget.kind === "meta"
                    ? "事由名・説明"
                    : editTarget.kind === "q"
                      ? "質問の編集"
                      : editTarget.kind === "ai"
                        ? "AIで枝分かれを仮生成"
                        : "注意書きの編集"}
                </span>
                <button
                  onClick={() => setEditing(null)}
                  className="rounded-lg px-2 py-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                >
                  ×
                </button>
              </div>

              {editTarget.kind === "ai" && (
                <div className="space-y-3">
                  <p className="text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
                    この手続きの判断の分かれ道（判断・従属質問・注意書き）を AI が下書きし、左のツリーに反映します。
                    <span className="font-medium text-[var(--color-fg)]">ファイルは変わりません</span> —
                    レビューして「保存」を押すまで仮の状態です。気に入らなければ「編集を終える」で捨てられます。
                  </p>
                  <div>
                    <label className="mb-1 block text-[11px] text-[var(--color-fg-muted)]">追加の指示（任意）</label>
                    <textarea
                      value={aiInstruction}
                      onChange={(e) => setAiInstruction(e.target.value)}
                      rows={3}
                      placeholder="例: 後任の選任が必要なケースも考慮して / 監査役の辞任は対象外"
                      className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11.5px]"
                    />
                  </div>
                  <button
                    onClick={() => runAiBranches()}
                    disabled={aiRunning}
                    className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-2 text-[12px] font-medium text-white disabled:opacity-40"
                  >
                    {aiRunning ? "AI が判断の分かれ道を考えています...（20秒ほど）" : "仮生成する"}
                  </button>
                  <p className="text-[10.5px] text-[var(--color-fg-muted)]">
                    既存の質問・選択肢は壊しません（id と選択肢はサーバー側で強制温存。雛形が無い枝は注意書きで明示されます）
                  </p>
                  {aiNotes && (
                    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-[11px] leading-relaxed space-y-1">
                      {aiNotes.map((n, i) => (
                        <p key={i} className={i === 0 ? "font-medium text-[var(--color-fg)]" : "text-[var(--color-fg-muted)]"}>
                          {i === 0 ? n : `・${n}`}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {editTarget.kind === "meta" && (
                <div className="space-y-2">
                  <label className="block text-[11px] text-[var(--color-fg-muted)]">事由名</label>
                  <input
                    value={raw.name}
                    onChange={(e) => mutate((j) => ({ ...j, name: e.target.value }))}
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[12.5px] font-semibold"
                  />
                  <label className="block text-[11px] text-[var(--color-fg-muted)]">説明（前提 + 当たる依頼の言い回し）</label>
                  <textarea
                    value={raw.description || ""}
                    onChange={(e) => mutate((j) => ({ ...j, description: e.target.value }))}
                    rows={5}
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px]"
                  />
                </div>
              )}

              {editTarget.kind === "q" && (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-[11px] text-[var(--color-fg-muted)]">質問の文言</label>
                    <textarea
                      value={editTarget.q.label}
                      onChange={(e) => updateQuestion(editTarget.q.id, { label: e.target.value })}
                      rows={3}
                      className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-[12px] leading-snug"
                    />
                  </div>
                  {editTarget.q.kind === "choice" && (
                    <div>
                      <label className="mb-1 block text-[11px] text-[var(--color-fg-muted)]">選択肢（枝になる）</label>
                      <div className="space-y-1">
                        {(editTarget.q.choices || []).map((c, ci) => (
                          <div key={ci} className="flex items-center gap-1">
                            <span className="h-2 w-2 shrink-0 rounded-full border border-purple-400" />
                            <input
                              value={c}
                              onChange={(e) => renameChoice(editTarget.q.id, ci, e.target.value)}
                              className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-[11.5px]"
                            />
                            <button
                              onClick={() => deleteChoice(editTarget.q.id, ci)}
                              className="rounded p-0.5 text-[var(--color-fg-muted)] hover:bg-red-50 hover:text-red-600"
                              title="選択肢を削除（使用中なら止まります）"
                            >
                              <Icon name="X" size={12} />
                            </button>
                          </div>
                        ))}
                        <button
                          onClick={() =>
                            updateQuestion(editTarget.q.id, {
                              choices: [...(editTarget.q.choices || []), `選択肢${(editTarget.q.choices?.length || 0) + 1}`],
                            })
                          }
                          className="text-[11px] text-[var(--color-accent-fg)] hover:underline"
                        >
                          ＋ 選択肢を足す
                        </button>
                        <p className="text-[10px] text-[var(--color-fg-muted)]">
                          文言を変えると、参照している分岐条件も自動で追随します
                        </p>
                      </div>
                    </div>
                  )}
                  <div className="rounded-lg border border-dashed border-[var(--color-border)] p-2">
                    <CondEditor
                      when={editTarget.q.when}
                      questions={raw.questions}
                      selfId={editTarget.q.id}
                      onChange={(w) => updateQuestion(editTarget.q.id, { when: w })}
                    />
                  </div>
                  {/* 文脈付きの仮生成: この判断の下の枝（従属質問・ガード・足りない選択肢）を AI が下書き */}
                  {editTarget.q.kind === "choice" && (
                    <div className="rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-2 space-y-1.5">
                      <button
                        onClick={() => runAiBranches(editTarget.q.id)}
                        disabled={aiRunning}
                        className="w-full rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[11.5px] font-medium text-white disabled:opacity-40"
                      >
                        <span className="inline-flex items-center gap-1">
                          <Icon name="Sparkles" size={11} className="text-white" />
                          {aiRunning && aiFor === editTarget.q.id
                            ? "この判断の下の枝を考えています...（20秒ほど）"
                            : "この判断の下の枝をAIで仮生成"}
                        </span>
                      </button>
                      <p className="text-[10px] leading-snug text-[var(--color-fg-muted)]">
                        各選択肢の先に必要な従属質問・注意書き（足りない選択肢も）を下書きして左のツリーに反映します。
                        保存するまでファイルは変わりません
                      </p>
                      {aiNotes && aiFor === editTarget.q.id && (
                        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[10.5px] leading-relaxed space-y-0.5">
                          {aiNotes.map((n, i) => (
                            <p key={i} className={i === 0 ? "font-medium text-[var(--color-fg)]" : "text-[var(--color-fg-muted)]"}>
                              {i === 0 ? n : `・${n}`}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-1 border-t border-[var(--color-border)] pt-2">
                    <button
                      onClick={() => moveQuestion(editTarget.q.id, -1)}
                      className="rounded p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                      title="質問の順番を上へ"
                    >
                      <Icon name="ChevronUp" size={14} />
                    </button>
                    <button
                      onClick={() => moveQuestion(editTarget.q.id, 1)}
                      className="rounded p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                      title="質問の順番を下へ"
                    >
                      <Icon name="ChevronDown" size={14} />
                    </button>
                    <button
                      onClick={() => deleteQuestion(editTarget.q.id)}
                      className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[var(--color-fg-muted)] hover:bg-red-50 hover:text-red-600"
                    >
                      <Icon name="Trash2" size={12} />
                      質問を削除
                    </button>
                  </div>
                </div>
              )}

              {editTarget.kind === "g" && (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-[11px] text-[var(--color-fg-muted)]">注意書きの文言</label>
                    <textarea
                      value={editTarget.g.message}
                      onChange={(e) =>
                        mutate((j) => ({
                          ...j,
                          guards: (j.guards || []).map((x, i) => (i === editTarget.gi ? { ...x, message: e.target.value } : x)),
                        }))
                      }
                      rows={4}
                      className="w-full rounded border border-amber-200 bg-white px-1.5 py-1 text-[12px] leading-snug"
                    />
                  </div>
                  <div className="rounded-lg border border-dashed border-[var(--color-border)] p-2">
                    <CondEditor
                      when={editTarget.g.when}
                      questions={raw.questions}
                      onChange={(w) =>
                        mutate((j) => ({
                          ...j,
                          guards: (j.guards || []).map((x, i) => (i === editTarget.gi ? { ...x, when: w } : x)),
                        }))
                      }
                    />
                  </div>
                  <button
                    onClick={() => {
                      setEditing(null);
                      mutate((j) => ({ ...j, guards: (j.guards || []).filter((_, i) => i !== editTarget.gi) }));
                    }}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-amber-800 hover:bg-red-50 hover:text-red-600"
                  >
                    <Icon name="Trash2" size={12} />
                    注意書きを削除
                  </button>
                </div>
              )}
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
      <div
        onClick={() => editable && !isArray && setEditing(open ? null : key)}
        title={editable && !isArray ? "クリックで出所を編集" : undefined}
        className={`flex items-baseline gap-1.5 text-[11.5px] leading-snug ${
          editable && !isArray ? "cursor-pointer rounded hover:bg-[var(--color-hover)]" : ""
        }`}
      >
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
