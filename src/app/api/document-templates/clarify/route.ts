import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import type { ClarificationQuestion } from "@/types";

const client = new Anthropic();

// テンプレートのプレースホルダーに対する確認質問を生成
export async function POST(request: NextRequest) {
  const { companyId, templateFolderPath } = await request.json();

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ questions: [] });
  }

  // テンプレートファイルを読み込み
  const templateFiles = await readAllFilesInFolder(templateFolderPath);

  // プレースホルダーを抽出
  const allPlaceholders = new Set<string>();
  const patterns = [
    /【([^】]+)】/g,
    /\{\{([^}]+)\}\}/g,
    /｛｛([^｝]+)｝｝/g,
  ];
  for (const tf of templateFiles) {
    if (tf.base64) continue;
    for (const p of patterns) {
      let m;
      const regex = new RegExp(p.source, p.flags);
      while ((m = regex.exec(tf.content)) !== null) {
        allPlaceholders.add(m[1].trim());
      }
    }
  }

  if (allPlaceholders.size === 0) {
    return NextResponse.json({ questions: [] });
  }

  // マスターシートとプロファイル
  const caseRoom = company.caseRooms?.find(r => r.masterSheet);
  const masterSheet = caseRoom?.masterSheet || company.masterSheet;
  const profile = company.profile;

  const dataContext = JSON.stringify({
    基本情報: profile?.structured || {},
    案件情報: masterSheet?.structured || {},
  }, null, 2);

  const placeholderList = Array.from(allPlaceholders).join(", ");

  // AIにデータ矛盾・不明項目を検出させる
  const prompt = `以下の会社データとプレースホルダー一覧を比較して、確認が必要な項目だけをJSON配列で返してください。

## 会社データ
${dataContext}
${masterSheet?.content ? `\n## 案件整理テキスト\n${masterSheet.content}\n` : ""}

## プレースホルダー一覧
${placeholderList}

## 重要な前提
- **共通フォルダ（定款・登記簿・株主名簿等）の情報は基本情報として確定済み**。ここに記載の日付・住所等は正しい前提で扱う
- **案件フォルダ（議事録・スケジュール・指示書等）の情報が今回の手続き内容**。スケジュール表に記載された日付はそのまま使う
- 共通フォルダと案件フォルダの情報が異なっても、それは矛盾ではなく「変更手続き」である

## ルール
- データから明確に値が1つに決まるものは質問不要（確信度が高い）
- スケジュール表や議事録に記載された日付はそのまま使う（質問しない）
- 以下の場合のみ質問を生成:
  1. 案件フォルダ内の複数資料間で値が矛盾している
  2. テンプレートのプレースホルダーに対応するデータがどこにもない
  3. 複数の解釈が可能（例: 役員が複数いてどの人か不明）
- 質問が0件なら空配列[]を返す

## 出力形式（JSONのみ）
[
  {
    "id": "q1",
    "placeholder": "プレースホルダー名",
    "question": "質問文",
    "options": [
      { "id": "a1", "label": "選択肢の値", "source": "出典（登記簿 2024/03等）" },
      { "id": "a2", "label": "別の選択肢", "source": "出典" }
    ]
  }
]`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return NextResponse.json({ questions: [] });
    }

    const questions: ClarificationQuestion[] = JSON.parse(match[0]);
    return NextResponse.json({ questions });
  } catch {
    return NextResponse.json({ questions: [] });
  }
}
