import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder, readFileContent } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";
import type { CompanyProfile, StructuredProfile, ChangeHistoryEntry } from "@/types";

const client = new Anthropic();
const PROFILE_TEMPLATE_PATH = path.join(process.cwd(), "data", "profile-template.json");

const DEFAULT_ITEMS = [
  "会社法人等番号", "商号", "本店所在地", "設立年月日", "事業目的",
  "資本金", "発行可能株式総数", "発行済株式総数", "株式の譲渡制限（承認機関も記載）",
  "役員（役職・氏名・住所・就任日・任期満了）", "新株予約権", "公告方法", "決算期",
  "役員の任期（定款の規定）", "株主構成（氏名・住所・持株数・持株比率）", "備考",
];

async function getProfileItems(): Promise<string[]> {
  try {
    const raw = await fs.readFile(PROFILE_TEMPLATE_PATH, "utf-8");
    const data = JSON.parse(raw);
    return data.items || DEFAULT_ITEMS;
  } catch {
    return DEFAULT_ITEMS;
  }
}

function buildExtractPrompt(items: string[]): string {
  const itemList = items.map((item, i) => `${i + 1}. ${item}`).join("\n");
  const jsonFields = items.map(item => `    "${item}": "..."`).join(",\n");

  return `以下のファイルから会社の基本情報を抽出してください。
情報がないものは「不明」としてください。

2つのブロックに分けて出力してください:

【ブロック1: 表示用テキスト】
以下の項目について「項目名: 値」の形式で出力。値が複数行になる場合、2行目以降は先頭にスペース2つ。
セクション見出し（【】）やマークダウン記法は使わないでください。
一覧系（役員・株主など）は「氏名 / 住所 / ...」の形式で1人1行。

抽出項目:
${itemList}

【ブロック2: JSON】
\`\`\`json
{
  "structured": {
${jsonFields}
  },
  "変更履歴": [
    { "日付": "YYYY-MM-DD", "内容": "変更内容の概要", "根拠ファイル": "ファイル名" }
  ]
}
\`\`\`

ルール:
- 役員は代表取締役を最初に記載。住所は登記簿に記載があれば記載、なければ省略
- 就任日が不明でも設立時取締役であれば設立年月日を就任日とすること
- 任期満了は必ず具体的な年月で算出すること（就任日+任期年数→該当事業年度末日後の定時株主総会）
- 一覧系の項目はJSON内では配列で返すこと
- 変更履歴は複数のファイル（旧登記簿・旧定款等）を比較して時系列で記録
- 変更履歴がない場合は空配列[]で返す
- ブロック1とブロック2の内容は完全に一致させること`;
}

// 基本情報を生成
export async function POST(request: NextRequest) {
  const { companyId } = await request.json();

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // 共通フォルダのファイルをローカルファイルシステムから読む
  const commonSubs = company.subfolders.filter(s => s.role === "common");

  const textFiles: { path: string; name: string; content: string }[] = [];
  const pdfFiles: { path: string; name: string; base64: string; mimeType: string }[] = [];

  for (const sub of commonSubs) {
    const allContents = await readAllFilesInFolder(sub.id);
    const disabled = sub.disabledFiles || [];

    for (const content of allContents) {
      if (isPathDisabled(content.path, disabled)) continue;

      if (content.base64) {
        pdfFiles.push({
          path: content.path,
          name: content.name,
          base64: content.base64,
          mimeType: content.mimeType || "application/pdf",
        });
      } else {
        textFiles.push({
          path: content.path,
          name: content.name,
          content: content.content,
        });
      }
    }
  }

  if (textFiles.length === 0 && pdfFiles.length === 0) {
    return NextResponse.json({ error: "共通フォルダに読み取り可能なファイルがありません" }, { status: 400 });
  }

  // メッセージ組み立て
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string };

  const contentBlocks: ContentBlock[] = [];

  // PDFをドキュメントとして添付
  for (const pdf of pdfFiles) {
    contentBlocks.push({
      type: "document",
      source: { type: "base64", media_type: pdf.mimeType, data: pdf.base64 },
      title: pdf.name,
    });
  }

  // テキストファイル + プロンプト
  const profileItems = await getProfileItems();
  let filesText = buildExtractPrompt(profileItems) + "\n\n--- ファイル内容 ---\n";
  for (const f of textFiles) {
    filesText += `\n【${f.name}】\n${f.content}\n`;
  }
  contentBlocks.push({ type: "text", text: filesText });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{
        role: "user",
        content: contentBlocks as Anthropic.ContentBlockParam[],
      }],
    });

    const rawText = response.content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text : "")
      .join("");

    // JSONブロックを抽出
    const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/) || rawText.match(/(\{[\s\S]*\})/);
    let structured: StructuredProfile | undefined;
    let changeHistory: ChangeHistoryEntry[] = [];

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        structured = parsed.structured;
        changeHistory = parsed.変更履歴 || [];
      } catch { /* パース失敗時はテキストのみ保存 */ }
    }

    // テキスト部分を抽出（JSONブロックを除去）
    const summary = rawText
      .replace(/```json[\s\S]*?```/g, "")
      .replace(/【ブロック2[\s\S]*/g, "")
      .replace(/【ブロック1[：:]\s*表示用テキスト】\s*/g, "")
      .trim();

    const allFiles = [
      ...textFiles.map(f => ({ name: f.name, id: f.path })),
      ...pdfFiles.map(f => ({ name: f.name, id: f.path })),
    ];
    const profile: CompanyProfile = {
      summary,
      structured,
      変更履歴: changeHistory,
      updatedAt: new Date().toISOString(),
      sourceFiles: allFiles,
    };

    company.profile = profile;
    await saveWorkspaceConfig(config);

    return NextResponse.json({ profile });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "生成に失敗しました" },
      { status: 500 }
    );
  }
}

// 差分更新（共通フォルダを再読み取りして既存sourceFilesとの差分を検出）
export async function PATCH(request: NextRequest) {
  const { companyId } = await request.json();

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company || !company.profile) {
    return NextResponse.json({ error: "基本情報がありません。先に生成してください" }, { status: 400 });
  }

  // 共通フォルダからファイルを再読み取り
  const commonSubs = company.subfolders.filter(s => s.role === "common");
  const existingPaths = new Set(
    (company.profile.sourceFiles || []).map(f => typeof f === "string" ? f : f.id)
  );

  const newContents: { name: string; path: string; content: string }[] = [];

  for (const sub of commonSubs) {
    const allContents = await readAllFilesInFolder(sub.id);
    const disabled = sub.disabledFiles || [];

    for (const content of allContents) {
      if (isPathDisabled(content.path, disabled)) continue;
      // 既にsourceFilesに含まれているファイルはスキップ
      if (existingPaths.has(content.path)) continue;
      // base64（PDF等）はテキスト差分更新には使えないのでスキップ
      if (content.base64) continue;

      newContents.push({ name: content.name, path: content.path, content: content.content });
    }
  }

  if (newContents.length === 0) {
    return NextResponse.json({ profile: company.profile, updated: false });
  }

  let newFilesText = "";
  for (const f of newContents) {
    newFilesText += `\n【${f.name}】\n${f.content}\n`;
  }

  try {
    const currentJson = company.profile.structured
      ? JSON.stringify({ structured: company.profile.structured, 変更履歴: company.profile.変更履歴 || [] }, null, 2)
      : company.profile.summary || "{}";

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: `以下は会社の現在の基本情報（JSON）です：

${currentJson}

新しいファイルが追加されました。内容を確認し、基本情報に変更があれば更新してください。
変更がなければそのまま返してください。同じJSON形式で返してください。
変更があれば変更履歴にも追記してください。

--- 新しいファイル ---
${newFilesText}`,
      }],
    });

    const rawText = response.content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text : "")
      .join("");

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.structured) {
          company.profile.structured = parsed.structured;
          company.profile.変更履歴 = parsed.変更履歴 || company.profile.変更履歴 || [];
        }
      } catch { /* パース失敗時は更新しない */ }
    }

    company.profile.updatedAt = new Date().toISOString();
    company.profile.sourceFiles = [
      ...company.profile.sourceFiles,
      ...newContents.map(f => ({ name: f.name, id: f.path })),
    ];

    await saveWorkspaceConfig(config);
    return NextResponse.json({ profile: company.profile, updated: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "更新に失敗しました" },
      { status: 500 }
    );
  }
}
