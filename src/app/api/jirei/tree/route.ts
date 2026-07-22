// 事由の「木」を可視化用ツリーに変換する API。
//
//   GET /api/jirei/tree?id=<jireiId>
//     → { tree: TreeNode }  … 事由（抽象）→ 分岐 → 書類 → 穴＋出所（具体）
//
// AI なし。木 JSON + テンプレ実ファイルの走査だけで組み立てる決定論の処理。
// 穴の出所は色分け用に kind を付ける:
//   fact = 資料から自動 / answer = 質問で聞く / const = 固定値 /
//   list = 一覧の1件ごと（株主ごと等） / unknown = 出所不明（テンプレのまま残る）

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { loadJirei } from "@/lib/jirei/loader";
import { scanTemplateHoles } from "@/lib/event-filing/template-ops";
import { condQuestionIds } from "@/lib/event-filing/select";
import type { Jirei, JireiCondition, JireiDocument } from "@/types/jirei";
import PizZip from "pizzip";

const TEMPLATE_DIR = path.join(process.cwd(), "data", "jirei-templates");

export interface TreeNode {
  label: string;
  kind: "jirei" | "branch" | "choice" | "doc" | "hole";
  source?: "fact" | "answer" | "const" | "list" | "unknown";
  detail?: string; // 出所の説明（「資料: 会社名」「質問: 開催日は？」等）
  badge?: string;  // 「株主ごとに1枚」等
  cond?: string;   // 出る条件の日本語表記（主分岐レーンで表しきれない条件）
  children?: TreeNode[];
}

// 条件の日本語化（all=かつ / any=または / 基本形=回答の値）
function humanizeCond(when: JireiCondition | undefined): string {
  if (!when) return "";
  if ("all" in when) return when.all.map(humanizeCond).join(" かつ ");
  if ("any" in when) return `（${when.any.map(humanizeCond).join(" または ")}）`;
  return `「${when.anyOf.join("・")}」のとき`;
}

// when の中に「qid の回答が choice を含む」原子条件があるか（レーン割当て用）
function refersChoice(when: JireiCondition | undefined, qid: string, choice: string): boolean {
  if (!when) return false;
  if ("all" in when) return when.all.some((c) => refersChoice(c, qid, choice));
  if ("any" in when) return when.any.some((c) => refersChoice(c, qid, choice));
  return when.questionId === qid && when.anyOf.includes(choice);
}

const norm = (s: string) => s.replace(/[\s　]/g, "");

// xlsx の穴: 《…》セル + 黄色データ行の rowSlots キー
async function xlsxHoles(buf: Buffer): Promise<string[]> {
  try {
    const zip = new PizZip(buf);
    const ss = zip.file("xl/sharedStrings.xml")?.asText() || "";
    const out: string[] = [];
    const seen = new Set<string>();
    const re = /《([^《》]{1,40})》/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ss)) !== null) {
      const inner = m[1].trim();
      if (!seen.has(inner)) {
        seen.add(inner);
        out.push(inner);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// 穴ラベル → 出所ノード
function holeNode(jirei: Jirei, doc: JireiDocument, hole: string): TreeNode {
  const LIST_FIELDS = new Set([
    "氏名", "住所", "株式数", "議決権数", "議決権数全角", "議決権割合", "種別", "代表者名",
    "主たる事務所", "名称", "無限責任組合員", "組合員", "代表取締役",
    "役職", "就任日",
  ]);
  // placeholders / rowSlots の対応表（空白無視）で引く
  let mapped: string | undefined;
  for (const [ph, label] of Object.entries({ ...(doc.placeholders || {}), ...(doc.rowSlots || {}) })) {
    if (norm(ph) === norm(hole)) {
      mapped = label;
      break;
    }
  }
  const target = mapped ?? hole;

  // 一覧のフィールド（株主ごとの値）
  if (doc.repeatOverFactList && LIST_FIELDS.has(target)) {
    return {
      label: hole,
      kind: "hole",
      source: "list",
      detail: `${doc.repeatOverFactList}ごと: ${target}`,
    };
  }
  // 回答から作る一覧のフィールド（新任者ごと等: repeatOverAnswerList）
  if (doc.repeatOverAnswerList && doc.repeatOverAnswerList.fields.includes(target)) {
    const q = jirei.questions.find((x) => x.id === doc.repeatOverAnswerList!.questionId);
    return {
      label: hole,
      kind: "hole",
      source: "list",
      detail: `回答の1行ごと: ${target}（${q?.label || doc.repeatOverAnswerList.questionId}）`,
    };
  }
  // スロット（空白無視で照合）。配列 = 分岐で出所が変わる穴（表示は先頭 + 注記）
  const slotEntry = Object.entries(jirei.slots).find(([k]) => norm(k) === norm(target));
  if (slotEntry) {
    const raw = slotEntry[1];
    const binding = Array.isArray(raw) ? raw[0] : raw;
    const multi = Array.isArray(raw) && raw.length > 1 ? "（分岐で出所が変わる）" : "";
    if (binding.type === "fact") {
      return { label: hole, kind: "hole", source: "fact", detail: `資料: ${binding.key}${multi}` };
    }
    if (binding.type === "answer") {
      const q = jirei.questions.find((x) => x.id === binding.questionId);
      return { label: hole, kind: "hole", source: "answer", detail: `質問: ${q?.label || binding.questionId}${multi}` };
    }
    return { label: hole, kind: "hole", source: "const", detail: `固定: ${binding.value}${multi}` };
  }
  return { label: hole, kind: "hole", source: "unknown", detail: "出所なし（テンプレの文言のまま残る）" };
}

async function docNode(jirei: Jirei, doc: JireiDocument): Promise<TreeNode> {
  let holes: string[] = [];
  try {
    const buf = await fs.readFile(path.join(TEMPLATE_DIR, doc.templateFile));
    if (doc.kind === "docx") {
      const { brackets, yellow } = scanTemplateHoles(buf);
      // 黄色マーカーのランに【…】が含まれるものは、ブラケット走査側で既に穴として
      // 把握済み（同じ穴の二重報告 = 偽の「出所なし」になる）ので除外する。
      const bset = new Set(brackets.map(norm));
      const yellowOnly = yellow.filter((y) => !/【[^】]*】/.test(y) && !bset.has(norm(y)));
      holes = [...brackets, ...yellowOnly];
    } else {
      holes = await xlsxHoles(buf);
      // 黄色データ行（株主ごとの列）は rowSlots のキーで表す
      holes.push(...Object.keys(doc.rowSlots || {}));
    }
  } catch {
    /* テンプレ未配置 */
  }
  const children = holes.map((h) => holeNode(jirei, doc, h));
  let badge: string | undefined;
  if (doc.repeatOverFactList) {
    badge = `${doc.repeatOverFactList}ごとに1${doc.kind === "docx" ? "枚" : "行"}`;
    if (doc.itemFilter) badge += `（${doc.itemFilter.anyOf.join("・")}のみ）`;
  }
  return {
    label: doc.templateFile,
    kind: "doc",
    badge,
    children,
  };
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id は必須です" }, { status: 400 });
  const jirei = await loadJirei(id);
  if (!jirei) return NextResponse.json({ error: "事由が見つかりません" }, { status: 404 });

  // 聞くことの構造（レビュー用）。クライアントが分岐ツリー（判断→選択肢→従属質問）を組むため、
  // 質問は id・選択肢・when 込みの完全な形で、ガードもそのまま返す。
  const questions = jirei.questions;
  const guards = jirei.guards || [];

  // 主分岐 = documents の when が最も多く参照する choice 質問。
  // その選択肢でレーンを分け、主分岐以外の条件は書類カードの cond（日本語）で示す。
  // 多次元の分岐（定款変更 × 決定機関 × 方式 × 管轄）でもレーンが破綻しない表現。
  const refCount = new Map<string, number>();
  for (const d of jirei.documents) {
    for (const qid of condQuestionIds(d.when)) refCount.set(qid, (refCount.get(qid) || 0) + 1);
  }
  const branchQ = jirei.questions
    .filter((q) => q.kind === "choice" && (refCount.get(q.id) || 0) > 0)
    .sort((a, b) => (refCount.get(b.id) || 0) - (refCount.get(a.id) || 0))[0];

  const root: TreeNode = { label: jirei.name, kind: "jirei", children: [] };

  if (branchQ && branchQ.choices) {
    const branchNode: TreeNode = { label: branchQ.label, kind: "branch", children: [] };
    const assigned = new Set<JireiDocument>();
    for (const c of branchQ.choices) {
      const docs = jirei.documents.filter((d) => refersChoice(d.when, branchQ.id, c));
      const choiceNode: TreeNode = { label: c, kind: "choice", children: [] };
      for (const d of docs) {
        assigned.add(d);
        const node = await docNode(jirei, d);
        // 主分岐以外の条件も持つ書類は、その条件をカードに明記
        const otherQids = condQuestionIds(d.when).filter((x) => x !== branchQ.id);
        if (otherQids.length > 0) node.cond = humanizeCond(d.when);
        choiceNode.children!.push(node);
      }
      branchNode.children!.push(choiceNode);
    }
    root.children!.push(branchNode);
    const rest = jirei.documents.filter((d) => !assigned.has(d));
    if (rest.length > 0) {
      const commonNode: TreeNode = { label: "共通・その他の条件", kind: "choice", children: [] };
      for (const d of rest) {
        const node = await docNode(jirei, d);
        if (d.when) node.cond = humanizeCond(d.when);
        commonNode.children!.push(node);
      }
      root.children!.push(commonNode);
    }
  } else {
    for (const d of jirei.documents) {
      const node = await docNode(jirei, d);
      if (d.when) node.cond = humanizeCond(d.when);
      root.children!.push(node);
    }
  }

  return NextResponse.json({ tree: root, questions, guards, description: jirei.description || "" });
}
