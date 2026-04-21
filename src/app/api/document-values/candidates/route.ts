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

  const systemText = `あなたは司法書士書類の値候補を提示するアシスタントです。
各スロットについて、最大3件の候補値を返してください。

## 候補の出所
- **📇基本情報**: 会社の登記情報・株主構成・役員・定款などから
- **📋案件整理**: 今回の手続きに関する日付・金額・当事者などから
- **⚠verify指摘**: verify で検出された「原本の正しい値」(expected) があれば最優先

## 重要ルール
- 現在の値 (current) が明らかに正しければ、候補は current と同じ値を1件返すだけでも可
- current と違う値が基本情報・案件整理に見つかれば、それを候補として提示（current を否定する意図は無く、選択肢として見せる）
- フォーマットは format の指定があれば、それに合わせる（例: "令和○年○月○日" なら "令和8年1月21日" の形）
- データにない場合は空配列を返す（候補なし）

## 基本情報
${JSON.stringify(profile?.structured || {}, null, 2)}

${masterSheet?.content ? `## 案件整理テキスト\n${masterSheet.content}\n` : ""}
${body.verifyIssues?.length ? `\n## verify 指摘事項\n${JSON.stringify(body.verifyIssues, null, 2)}\n` : ""}

## 出力形式（JSONのみ）
{
  "0": [
    { "value": "三上春香", "source": "📇基本情報" }
  ],
  "1": [
    { "value": "広島県大竹市西栄二丁目8番9号", "source": "📇基本情報" }
  ],
  ...
}
キーは slotId の文字列。値は候補の配列。`;

  const userPrompt = `以下のスロットについて、候補値を JSON で返してください。

## スロット一覧
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
      const parsed = JSON.parse(match[0]) as Record<string, { value: string; source: string }[]>;
      // キーを数値に正規化（slotId の数値キーに統一）
      const candidates: Record<number, { value: string; source: string }[]> = {};
      for (const [k, v] of Object.entries(parsed)) {
        const id = parseInt(k);
        if (!isNaN(id) && Array.isArray(v)) candidates[id] = v.filter(c => c && typeof c.value === "string");
      }
      return NextResponse.json({ candidates });
    } catch {
      return NextResponse.json({ candidates: {} });
    }
  } catch (err) {
    return NextResponse.json({
      candidates: {},
      error: err instanceof Error ? err.message : "候補生成に失敗",
    });
  }
}
