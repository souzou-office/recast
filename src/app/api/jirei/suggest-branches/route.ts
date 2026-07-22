// 枝分かれの仮生成 — AI が「この手続きの判断の分かれ道」を下書きする。
//
//   POST /api/jirei/suggest-branches … { id, instruction? }
//     → { jirei: 提案を適用した木, notes: string[], warnings: string[] }
//
// AI が働くのは「木を育てる瞬間」（境界②）。★ファイルには書かない★ —
// 提案は編集バッファに載るだけで、専門家がツリーでレビューして保存するまで確定しない（仮生成）。
//
// テンプレからの逆算では書類に現れない判断（定款変更の要否・決定機関・方式…）が
// 木に載らない、という構造的盲点への一般解: 手続きの法律・実務知識から判断の層を
// AI に列挙させ、人がレビューする。
//
// 安全策:
//   - 既存質問の id / kind / choices はサーバー側で強制温存（スロットの when が参照しているため。
//     選択肢の文言が変わると分岐が全崩壊する — リネームは編集 UI のカスケード機能でやる）
//   - AI が既存質問を落としたら復元して警告
//   - 適用前に validateJirei。エラーが出たら1回だけ AI にエラーを見せて再生成させる

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import path from "path";
import { loadJirei } from "@/lib/jirei/loader";
import { validateJirei } from "@/lib/jirei/validate";
import { logTokenUsage } from "@/lib/token-logger";
import type { Jirei, JireiCondition, JireiQuestion } from "@/types/jirei";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

// when の tool スキーマ（再帰なし・深さ1: 原子 or all/any of 原子。実データの語彙と同じ）
const ATOM = {
  type: "object" as const,
  properties: {
    questionId: { type: "string" as const },
    anyOf: { type: "array" as const, items: { type: "string" as const } },
  },
  required: ["questionId", "anyOf"],
};
const WHEN_SCHEMA = {
  type: "object" as const,
  description:
    "出る条件。省略=常に。単一条件は {questionId, anyOf}、複合は {all:[原子…]}（かつ）か {any:[原子…]}（または）。入れ子は不可",
  properties: {
    questionId: { type: "string" as const },
    anyOf: { type: "array" as const, items: { type: "string" as const } },
    all: { type: "array" as const, items: ATOM },
    any: { type: "array" as const, items: ATOM },
  },
};

interface RawWhen {
  questionId?: string;
  anyOf?: string[];
  all?: { questionId: string; anyOf: string[] }[];
  any?: { questionId: string; anyOf: string[] }[];
}

// AI の返した when を JireiCondition に正規化（空・不正は undefined）
function normalizeWhen(w: RawWhen | undefined): JireiCondition | undefined {
  if (!w) return undefined;
  const atoms = (arr?: { questionId: string; anyOf: string[] }[]) =>
    (arr || []).filter((a) => a?.questionId && Array.isArray(a.anyOf) && a.anyOf.length > 0);
  if (w.questionId && Array.isArray(w.anyOf) && w.anyOf.length > 0) {
    return { questionId: w.questionId, anyOf: w.anyOf };
  }
  const all = atoms(w.all);
  if (all.length === 1) return all[0];
  if (all.length > 1) return { all };
  const any = atoms(w.any);
  if (any.length === 1) return any[0];
  if (any.length > 1) return { any };
  return undefined;
}

interface ProposalInput {
  questions?: {
    id: string;
    label: string;
    kind: string;
    choices?: string[];
    when?: RawWhen;
  }[];
  guards?: { when?: RawWhen; message: string }[];
  documentWhens?: { templateFile: string; when?: RawWhen }[];
  notes?: string[];
}

// AI の提案を現在の木にマージ（既存質問の id/kind/choices は強制温存）
function applyProposal(cur: Jirei, p: ProposalInput): { merged: Jirei; warnings: string[] } {
  const warnings: string[] = [];
  const curById = new Map(cur.questions.map((q) => [q.id, q]));

  const seen = new Set<string>();
  const questions: JireiQuestion[] = [];
  for (const aq of p.questions || []) {
    if (!aq?.id || seen.has(aq.id)) continue;
    seen.add(aq.id);
    const exist = curById.get(aq.id);
    if (exist) {
      // 既存: kind は温存。choices は既存を全部残した上で★追加だけ許可★
      // （既存値の削除・変更はスロットや分岐の when が壊れるため禁止。リネームは編集UIのカスケードで）
      let choices = exist.choices;
      if (exist.kind === "choice" && exist.choices) {
        const additions = (aq.choices || []).filter((c) => c?.trim() && !exist.choices!.includes(c));
        const removed = exist.choices.filter((c) => !(aq.choices || []).includes(c));
        choices = [...exist.choices, ...additions];
        if (removed.length > 0) {
          warnings.push(`質問「${exist.label.slice(0, 18)}…」の選択肢の削除・変更は無視しました（分岐が参照するため）`);
        }
      }
      questions.push({
        id: exist.id,
        label: aq.label?.trim() || exist.label,
        kind: exist.kind,
        ...(choices ? { choices } : {}),
        when: normalizeWhen(aq.when) ?? undefined,
      });
    } else {
      const kind = aq.kind === "choice" || aq.kind === "date" ? aq.kind : "text";
      const choices = kind === "choice" ? (aq.choices || []).filter((c) => c?.trim()) : undefined;
      if (kind === "choice" && (choices?.length || 0) < 2) {
        warnings.push(`提案された判断「${(aq.label || aq.id).slice(0, 18)}…」は選択肢が2つ未満のため除外しました`);
        continue;
      }
      questions.push({
        id: aq.id.replace(/[^a-z0-9_]/gi, "_").toLowerCase(),
        label: aq.label || "",
        kind,
        ...(choices ? { choices } : {}),
        when: normalizeWhen(aq.when),
      });
    }
  }
  // AI が落とした既存質問を復元（スロットが参照している可能性があるため削除は許さない）
  for (const q of cur.questions) {
    if (!seen.has(q.id)) {
      questions.push(q);
      warnings.push(`AI 提案から落ちていた既存の質問「${q.label.slice(0, 18)}…」を復元しました`);
    }
  }

  // ガードも既存を温存（質問と同じ方針: AI 提案からの削除は許さない。消すのは人が編集UIで）。
  // AI の新しいガードは重複（正規化した文言一致）でなければ追加。
  const normMsg = (s: string) => s.replace(/[\s　]/g, "");
  const aiGuards = (p.guards || [])
    .filter((g) => g?.message?.trim())
    .map((g) => ({ message: g.message.trim(), when: normalizeWhen(g.when) }));
  const guards = [...(cur.guards || [])];
  let restoredGuards = 0;
  for (const g of aiGuards) {
    if (!guards.some((x) => normMsg(x.message) === normMsg(g.message))) guards.push(g);
  }
  restoredGuards = (cur.guards || []).filter(
    (x) => !aiGuards.some((g) => normMsg(g.message) === normMsg(x.message))
  ).length;
  if (restoredGuards > 0) {
    warnings.push(`AI 提案から落ちていた既存の注意書き${restoredGuards}本を温存しました（消す場合は編集画面で）`);
  }

  const documents = cur.documents.map((d) => {
    const hit = (p.documentWhens || []).find((x) => x?.templateFile === d.templateFile);
    if (!hit) return d;
    return { ...d, when: normalizeWhen(hit.when) };
  });
  for (const x of p.documentWhens || []) {
    if (x?.templateFile && !cur.documents.some((d) => d.templateFile === x.templateFile)) {
      warnings.push(`存在しない書類への条件は無視しました: ${x.templateFile}`);
    }
  }

  return { merged: { ...cur, questions, guards, documents }, warnings };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const id: string | undefined = body.id;
    const instruction: string = (body.instruction || "").trim();
    // まとめ文章: 手続きの実務解説・事務所メモ等。あれば★分岐表の正★として一気に木へ落とす
    const sourceText: string = (body.sourceText || "").trim();
    // 重点対象の判断（指定があれば「この判断の下の枝」を重点的に育てる。無ければ木全体）
    const focusQuestionId: string | undefined = body.focusQuestionId;
    if (!id) return NextResponse.json({ error: "id は必須です" }, { status: 400 });
    const jirei = await loadJirei(id);
    if (!jirei) return NextResponse.json({ error: "事由が見つかりません" }, { status: 404 });
    const focusQ = focusQuestionId ? jirei.questions.find((q) => q.id === focusQuestionId) : undefined;
    if (focusQuestionId && !focusQ) {
      return NextResponse.json({ error: "focusQuestionId が見つかりません" }, { status: 404 });
    }

    // 事務所の統一ルール（あれば実務前提として渡す）
    let officeRules = "";
    try {
      officeRules = await fs.readFile(path.join(process.cwd(), "data", "jirei", "office-rules.txt"), "utf-8");
    } catch {
      /* 無ければスキップ */
    }

    const TOOL: Anthropic.Tool = {
      name: "submit_branch_proposal",
      description: "この手続きの判断の枝分かれ（質問・選択肢・条件・注意書き）の提案を提出する",
      input_schema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "質問の全一覧（既存を残しつつ、判断の分かれ道を追加。表示順に並べる）",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "既存の質問はその id をそのまま。新規は英小文字 snake_case（例: teikan_henko）",
                },
                label: { type: "string", description: "質問の文言（専門家の言葉で。例示があれば括弧で）" },
                kind: { type: "string", enum: ["choice", "date", "text"] },
                choices: { type: "array", items: { type: "string" }, description: "kind=choice のとき。短い専門家の言葉+必要なら括弧で補足" },
                when: WHEN_SCHEMA,
              },
              required: ["id", "label", "kind"],
            },
          },
          guards: {
            type: "array",
            description: "注意書き（雛形が無い枝の明示・法定の確認事項など）の全一覧",
            items: {
              type: "object",
              properties: { when: WHEN_SCHEMA, message: { type: "string" } },
              required: ["message"],
            },
          },
          documentWhens: {
            type: "array",
            description: "既存の書類に付ける出る条件（変更が必要なものだけ）",
            items: {
              type: "object",
              properties: { templateFile: { type: "string" }, when: WHEN_SCHEMA },
              required: ["templateFile"],
            },
          },
          notes: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            description: "提案の要点と、専門家が確認すべきこと（必ず2行以上）",
          },
        },
        required: ["questions", "guards", "notes"],
      },
    };

    const treeSummary = JSON.stringify(
      {
        name: jirei.name,
        description: jirei.description,
        questions: jirei.questions,
        guards: jirei.guards || [],
        documents: jirei.documents.map((d) => ({ templateFile: d.templateFile, when: d.when })),
        slots: Object.fromEntries(
          Object.entries(jirei.slots).map(([k, v]) => [
            k,
            (Array.isArray(v) ? v : [v]).map((b) => (b.type === "answer" ? `answer:${b.questionId}` : b.type)),
          ])
        ),
      },
      null,
      1
    );

    const basePrompt = `あなたは司法書士事務所の実務に詳しい専門家です。
下の「木」は、手続き（事由）ごとに 質問 → 分岐(when) → 書類 を定義するデータです。
- kind:"choice" の質問 = 専門家の判断（選択肢が枝になる）
- when = 出る条件。{questionId, anyOf} / {all:[…]}(かつ) / {any:[…]}(または)。従属質問は when で親の判断にぶら下げる
- guards = 注意書き（雛形が無い枝は「〜用の雛形が未登録です。このまま生成すると〜だけが出ます」と明示）

【現在の木】
${treeSummary}
${officeRules ? `\n【事務所の統一ルール（実務の前提）】\n${officeRules.slice(0, 2000)}\n` : ""}
${
      sourceText
        ? `【手続きのまとめ文章 — ★この内容が分岐表の正★】
${sourceText.slice(0, 8000)}

【仕事】
上のまとめ文章に書かれている判断の分かれ道・条件・注意点・書類の出る条件を、
★漏れなく★木の構造（判断 choice → 従属質問 → guards → documentWhens）に落としてください。
文章に書かれていない分岐を創作しないこと。文章と既存の木が食い違う場合は文章を優先し、
その旨を notes に書くこと。`
        : `【仕事】
この手続き（${jirei.name}）について、法律・実務上の判断の分かれ道を列挙し、
判断（choice 質問）→ 従属質問 → 注意書き の枝分かれ構造を提案してください。`
    }

【厳守】
- 既存の質問は id をそのまま使って全部残す（削除禁止。穴が参照している）。when の付与・並び替え・文言の改善は可
- 既存の choice 質問の選択肢の文言は変更しない
- 書類（documents）に無い枝 = 生成できない枝。その枝には guards で「雛形が未登録」を明示する
- 前提を無言で焼き込まない（テンプレ一式が暗黙に前提する方式・状況は判断として顕在化する）
- 選択肢は短い専門家の言葉（必要なら括弧で補足）。判断→従属質問の順に並べる
- ★資料から自動で分かることは質問にしない★。この木は 登記情報・定款・株主名簿 を自動で読む。
  つまり次は質問禁止: 取締役の人数・役員構成・監査役の有無・代表取締役が誰か・
  株主の構成や種別（個人/法人/組合。書式の出し分けも自動）・定款の定め・資本金・発行済株式数。
  質問してよいのは「人にしか決められないこと」（方式の選択・日付・新しく決める値）だけ
- notes には提案の要点と専門家の確認事項を必ず2行以上書く${
      focusQ
        ? `

【重点対象】
判断「${focusQ.label}」（id: ${focusQ.id}${focusQ.choices ? `、選択肢: ${focusQ.choices.join(" / ")}` : ""}）の
★下の枝分かれ★を重点的に充実させること:
- この判断の各選択肢について、その選択で必要になる従属質問（when でこの判断にぶら下げる）と、
  雛形が無い・法的に注意が要る枝のガードを提案する
- 選択肢が足りなければ追加してよい（既存の選択肢はそのまま残すこと）
- この判断に関係しない既存の構造は原則そのまま維持する`
        : ""
    }${instruction ? `\n\n【ユーザーの追加指示】\n${instruction}` : ""}`;

    // 生成 → 検証 → エラーがあれば1回だけエラーを見せて再生成
    let merged: Jirei | null = null;
    let notes: string[] = [];
    let mergeWarnings: string[] = [];
    let valWarnings: string[] = [];
    let lastErrors: string[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt =
        attempt === 0
          ? basePrompt
          : `${basePrompt}\n\n【前回の提案の検証エラー（直して再提出）】\n${lastErrors.join("\n")}`;
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        temperature: 0,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "submit_branch_proposal" },
        messages: [{ role: "user", content: prompt }],
      });
      logTokenUsage("api/jirei/suggest-branches", MODEL, resp.usage);

      const block = resp.content.find(
        (b): b is Extract<typeof b, { type: "tool_use" }> =>
          b.type === "tool_use" && b.name === "submit_branch_proposal"
      );
      const proposal = (block?.input || {}) as ProposalInput;
      const applied = applyProposal(jirei, proposal);
      const val = validateJirei(applied.merged);
      if (val.errors.length === 0) {
        merged = applied.merged;
        notes = (proposal.notes || []).filter((n) => n?.trim());
        mergeWarnings = applied.warnings;
        valWarnings = val.warnings;
        break;
      }
      lastErrors = val.errors;
    }

    if (!merged) {
      return NextResponse.json(
        { error: "検証を通る提案を作れませんでした", errors: lastErrors },
        { status: 422 }
      );
    }

    // ★ファイルには書かない★ — 仮生成。編集バッファに載せて人がレビュー→保存する
    return NextResponse.json({ jirei: merged, notes, warnings: [...mergeWarnings, ...valWarnings] });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "仮生成に失敗しました" },
      { status: 500 }
    );
  }
}
