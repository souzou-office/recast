import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { loadThread } from "@/lib/thread-store";
import { logTokenUsage } from "@/lib/token-logger";

const client = new Anthropic();
const MODEL = "claude-haiku-4-5-20251001";

// 書類の値編集 UI で使う候補を Haiku に提案させる。
// 入力:
//   - filledSlots: 現在の埋め値（label, value, format, sourceHint）
//   - companyId / threadId: コンテキスト（基本情報・案件整理を読むため）
//   - verifyIssues?: verify で検出した問題（expected を候補として活用）
//
// 出力:
//   { candidates: { [slotId: number]: { value: string; source: string }[] } }
//
// 各スロットについて 1-3 件の候補を返す。常に「手動入力」はフロント側で追加するので
// ここでは候補値だけ。
export async function POST(request: NextRequest) {
  const body = await request.json() as {
    companyId: string;
    threadId?: string;
    filledSlots: { slotId: number; label: string; value: string; format?: string; sourceHint?: string }[];
    verifyIssues?: { docName: string; issues: { aspect: string; problem: string; expected?: string }[] }[];
  };

  if (!body.companyId || !Array.isArray(body.filledSlots) || body.filledSlots.length === 0) {
    return NextResponse.json({ error: "companyId と filledSlots が必須" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === body.companyId);
  if (!company) return NextResponse.json({ candidates: {} });

  const thread = body.threadId ? await loadThread(company.id, body.threadId) : null;
  const profile = company.profile;
  const masterSheet = thread?.masterSheet;

  const systemText = `あなたは司法書士書類の値候補提示アシスタントです。
各項目（slotId）について、候補値と、verify の指摘が該当するかを返してください。

## 候補の出所
- **📇基本情報**: 会社の登記情報・株主構成・役員・定款などから
- **📋案件整理**: 今回の手続きに関する日付・金額・当事者などから
- **⚠verify指摘**: verify で検出された「原本の正しい値」(expected) があれば最優先

## 重要ルール
- 現在の値 (current) が明らかに正しければ、候補は current と同じ値を1件返すだけでも可
- current と違う値が基本情報・案件整理に見つかれば、それを候補として提示
- データにない場合は空配列を返す（候補なし）

## verify 指摘の項目マッチング（厳格ルール）
- **各 issue は最大 1 つの項目だけに紐付ける**（同じ issue を複数項目に重複してセットしない）
- 意味的にもっとも具体的に対応する **1 項目だけ** を選ぶ
- どの項目にも一対一で対応しない「書類全体に関わる指摘」「複数項目に跨る指摘」は **紐付けない**（空のまま、上部の「未分類」に回す）
  - 例: 「株主リスト全体で合計が合わない」「総議決権数と個別値の不整合」等
- 自信が持てない指摘も紐付けない（issueIndex 配列に入れない）
- 例: 指摘「代表取締役の氏名が福田峻介になっているが、基本情報では三上春香」
  → ラベル「代表取締役氏名」の **1 項目だけ** にマッチ
- 例: 指摘「岩下歌武輝の持株数が5000で株単位なし」
  → ラベル「第2株主の持株数」など **具体的な1項目** だけにマッチ、株主関連の他項目には紐付けない

## 基本情報
${JSON.stringify(profile?.structured || {}, null, 2)}

${masterSheet?.content ? `## 案件整理テキスト\n${masterSheet.content}\n` : ""}

## 出力形式（JSONのみ）
{
  "candidates": {
    "0": [{ "value": "三上春香", "source": "📇基本情報" }],
    "1": [{ "value": "広島県大竹市西栄二丁目8番9号", "source": "📇基本情報" }]
  },
  "slotIssues": {
    "0": [0],
    "3": [1, 2]
  }
}

- candidates のキー: slotId の文字列、値は候補配列
- slotIssues のキー: slotId、値は **指摘事項の index 配列**（下記「verify 指摘事項」の 0 始まりの index）
- slotIssues に現れない項目は問題なし（ハイライトしない）`;

  // verify 指摘を index 付きでフラット化（意味マッチング用）
  const flatIssues = (body.verifyIssues || []).flatMap(vi => vi.issues);
  const issuesBlock = flatIssues.length > 0
    ? `\n## verify 指摘事項（index 付き）\n${flatIssues.map((iss, i) => `[${i}] ${iss.problem}${iss.expected ? ` → 正: ${iss.expected}` : ""}`).join("\n")}\n`
    : "";

  const userPrompt = `以下の項目について、候補値と指摘マッチングを JSON で返してください。
${issuesBlock}
## 項目一覧
${body.filledSlots.map(s => `- slot ${s.slotId}: ${s.label} (現在値: "${s.value}"${s.format ? `, 形式: ${s.format}` : ""}${s.sourceHint ? `, 出典: ${s.sourceHint}` : ""})`).join("\n")}

JSONのみ返してください。`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userPrompt }],
    });
    logTokenUsage("/api/document-values/candidates", MODEL, response.usage);

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return NextResponse.json({ candidates: {} });

    try {
      const parsed = JSON.parse(match[0]) as {
        candidates?: Record<string, { value: string; source: string }[]>;
        slotIssues?: Record<string, number[]>;
      };

      const candidates: Record<number, { value: string; source: string }[]> = {};
      for (const [k, v] of Object.entries(parsed.candidates || {})) {
        const id = parseInt(k);
        if (!isNaN(id) && Array.isArray(v)) candidates[id] = v.filter(c => c && typeof c.value === "string");
      }

      // slotIssues: slotId → 該当 issue の実体を埋めて返す。
      // ただし、同じ issueIndex が複数 slotId に紐付けられていた場合は最初の 1 つだけ採用
      // （Haiku が過剰マッチしても自動で 1 対 1 に正規化）。
      const usedIssueIndices = new Set<number>();
      const slotIssues: Record<number, { problem: string; expected?: string; aspect?: string; severity?: string }[]> = {};
      // 先に slotId をソートして決定的に
      const entries = Object.entries(parsed.slotIssues || {}).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
      for (const [k, indices] of entries) {
        const id = parseInt(k);
        if (isNaN(id) || !Array.isArray(indices)) continue;
        const kept: typeof flatIssues = [];
        for (const i of indices) {
          if (typeof i !== "number" || usedIssueIndices.has(i)) continue;
          const iss = flatIssues[i];
          if (!iss) continue;
          usedIssueIndices.add(i);
          kept.push(iss);
        }
        if (kept.length > 0) slotIssues[id] = kept;
      }

      return NextResponse.json({ candidates, slotIssues });
    } catch {
      return NextResponse.json({ candidates: {}, slotIssues: {} });
    }
  } catch (err) {
    return NextResponse.json({
      candidates: {},
      error: err instanceof Error ? err.message : "候補生成に失敗",
    });
  }
}
