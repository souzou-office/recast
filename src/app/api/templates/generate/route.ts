import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export async function POST(request: NextRequest) {
  const { caseType } = await request.json();

  if (!caseType) {
    return NextResponse.json({ error: "案件タイプを入力してください" }, { status: 400 });
  }

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `バックオフィス業務で「${caseType}」の案件を処理する際に確認すべき項目を一覧にしてください。

法務・登記・定款・株主名簿・指示書などから確認が必要な項目を網羅してください。

JSON配列のみ出力してください。各要素は確認項目名の文字列です。
例: ["代表取締役の選定機関", "現在の役員構成", "スケジュール"]

10〜15項目程度で、実務に必要な項目を漏れなく挙げてください。`,
      }],
    });

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text : "")
      .join("");

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return NextResponse.json({ error: "生成に失敗しました" }, { status: 500 });
    }

    const items = JSON.parse(match[0]);
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "生成に失敗しました" },
      { status: 500 }
    );
  }
}
