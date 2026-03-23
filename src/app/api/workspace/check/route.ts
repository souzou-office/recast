import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { readFileById } from "@/lib/files-google";

const client = new Anthropic();

const CHECK_PROMPT = `あなたはバックオフィス業務を支援するAIです。
案件フォルダの指示書と会社の基本情報を照合して、確認事項を一覧にまとめてください。

以下のJSON形式で出力してください。他のテキストは一切不要です。JSONだけ出力してください。

{
  "caseType": "案件の種類（例: 役員就任、新株予約権発行、本店移転 等）",
  "summary": "案件の概要（1-2文）",
  "schedule": [
    { "event": "イベント名", "date": "日付", "note": "備考" }
  ],
  "checkItems": [
    {
      "category": "カテゴリ（例: 機関設計、役員、株主、スケジュール）",
      "item": "確認項目",
      "source": "確認元（例: 定款、登記簿、株主名簿、指示書）",
      "result": "確認結果（具体的に記載）",
      "note": "注意事項があれば"
    }
  ]
}

確認すべき項目は案件の種類に応じて自動判断してください。例えば:

【役員就任・退任の場合】
- 代表取締役の選定機関（定款）
- 現在の役員構成（登記簿）
- 各役員の任期満了時期（定款＋登記簿）
- 株主総会の開催日・決議事項（指示書）
- 株主の氏名・住所・持株数（株主名簿）→ 株主リスト作成用
- 新任役員の情報（指示書）
- 登記申請の期限

【新株予約権発行の場合】
- 発行可能株式総数と発行済株式総数（登記簿）
- 株式の譲渡制限（定款）
- 既存の新株予約権（登記簿）
- 発行条件（指示書）

上記は例です。指示書の内容から必要な確認項目を判断してください。`;

export async function POST(request: NextRequest) {
  const { companyId } = await request.json();

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // 案件フォルダ（active）のファイルを読む
  const jobFiles: { name: string; content: string }[] = [];
  for (const sub of company.subfolders) {
    if (sub.role === "job" && sub.active && sub.files) {
      for (const f of sub.files) {
        if (!f.enabled) continue;
        const content = await readFileById(f.id, f.name, f.mimeType);
        if (content && !content.base64) {
          jobFiles.push({ name: f.name, content: content.content });
        }
      }
    }
  }

  if (jobFiles.length === 0) {
    return NextResponse.json({ error: "案件フォルダにファイルがありません。案件フォルダを有効にしてファイルスキャンしてください。" }, { status: 400 });
  }

  // 基本情報サマリー
  const profileSummary = company.profile?.summary || "基本情報は未生成です。";

  // 共通フォルダのファイルも読む（詳細確認用）
  const commonTexts: { name: string; content: string }[] = [];
  for (const sub of company.subfolders) {
    if (sub.role === "common" && sub.files) {
      for (const f of sub.files) {
        if (!f.enabled) continue;
        const content = await readFileById(f.id, f.name, f.mimeType);
        if (content && !content.base64) {
          commonTexts.push({ name: f.name, content: content.content });
        }
      }
    }
  }

  // プロンプト組み立て
  let filesText = "--- 案件フォルダ（指示書等） ---\n";
  for (const f of jobFiles) {
    filesText += `\n【${f.name}】\n${f.content}\n`;
  }

  filesText += "\n--- 基本情報サマリー ---\n" + profileSummary + "\n";

  if (commonTexts.length > 0) {
    filesText += "\n--- 共通フォルダ（定款・登記簿等の原文） ---\n";
    for (const f of commonTexts) {
      filesText += `\n【${f.name}】\n${f.content}\n`;
    }
  }

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: `${CHECK_PROMPT}\n\n${filesText}`,
      }],
    });

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text : "")
      .join("");

    // JSONを抽出
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "確認事項の生成に失敗しました", raw: text }, { status: 500 });
    }

    const result = JSON.parse(jsonMatch[0]);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "生成に失敗しました" },
      { status: 500 }
    );
  }
}
