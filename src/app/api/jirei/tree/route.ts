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
import type { Jirei, JireiDocument } from "@/types/jirei";
import PizZip from "pizzip";

const TEMPLATE_DIR = path.join(process.cwd(), "data", "jirei-templates");

export interface TreeNode {
  label: string;
  kind: "jirei" | "branch" | "choice" | "doc" | "hole";
  source?: "fact" | "answer" | "const" | "list" | "unknown";
  detail?: string; // 出所の説明（「資料: 会社名」「質問: 開催日は？」等）
  badge?: string;  // 「株主ごとに1枚」等
  children?: TreeNode[];
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
  const LIST_FIELDS = new Set(["氏名", "住所", "株式数", "議決権数", "議決権数全角", "議決権割合", "役職", "就任日"]);
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
  // スロット（空白無視で照合）
  const slotEntry = Object.entries(jirei.slots).find(([k]) => norm(k) === norm(target));
  if (slotEntry) {
    const binding = slotEntry[1];
    if (binding.type === "fact") {
      return { label: hole, kind: "hole", source: "fact", detail: `資料: ${binding.key}` };
    }
    if (binding.type === "answer") {
      const q = jirei.questions.find((x) => x.id === binding.questionId);
      return { label: hole, kind: "hole", source: "answer", detail: `質問: ${q?.label || binding.questionId}` };
    }
    return { label: hole, kind: "hole", source: "const", detail: `固定: ${binding.value}` };
  }
  return { label: hole, kind: "hole", source: "unknown", detail: "出所なし（テンプレの文言のまま残る）" };
}

async function docNode(jirei: Jirei, doc: JireiDocument): Promise<TreeNode> {
  let holes: string[] = [];
  try {
    const buf = await fs.readFile(path.join(TEMPLATE_DIR, doc.templateFile));
    if (doc.kind === "docx") {
      const { brackets, yellow } = scanTemplateHoles(buf);
      holes = [...brackets, ...yellow];
    } else {
      holes = await xlsxHoles(buf);
      // 黄色データ行（株主ごとの列）は rowSlots のキーで表す
      holes.push(...Object.keys(doc.rowSlots || {}));
    }
  } catch {
    /* テンプレ未配置 */
  }
  const children = holes.map((h) => holeNode(jirei, doc, h));
  return {
    label: doc.templateFile,
    kind: "doc",
    badge: doc.repeatOverFactList ? `${doc.repeatOverFactList}ごとに1${doc.kind === "docx" ? "枚" : "行"}` : undefined,
    children,
  };
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id は必須です" }, { status: 400 });
  const jirei = await loadJirei(id);
  if (!jirei) return NextResponse.json({ error: "事由が見つかりません" }, { status: 404 });

  // 分岐を決める choice 質問（documents の when が参照しているもの）
  const branchQ = jirei.questions.find(
    (q) => q.kind === "choice" && jirei.documents.some((d) => d.when?.questionId === q.id)
  );

  const commonDocs = jirei.documents.filter((d) => !d.when);
  const root: TreeNode = { label: jirei.name, kind: "jirei", children: [] };

  if (branchQ && branchQ.choices) {
    const branchNode: TreeNode = { label: branchQ.label, kind: "branch", children: [] };
    for (const c of branchQ.choices) {
      const docs = jirei.documents.filter(
        (d) => d.when && d.when.questionId === branchQ.id && d.when.anyOf.includes(c)
      );
      const choiceNode: TreeNode = { label: c, kind: "choice", children: [] };
      for (const d of docs) choiceNode.children!.push(await docNode(jirei, d));
      branchNode.children!.push(choiceNode);
    }
    root.children!.push(branchNode);
    if (commonDocs.length > 0) {
      const commonNode: TreeNode = { label: "共通（どの分岐でも）", kind: "choice", children: [] };
      for (const d of commonDocs) commonNode.children!.push(await docNode(jirei, d));
      root.children!.push(commonNode);
    }
  } else {
    for (const d of jirei.documents) root.children!.push(await docNode(jirei, d));
  }

  return NextResponse.json({ tree: root });
}
