import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder, readFileContent } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";
import { logTokenUsage } from "@/lib/token-logger";
import type { CompanyProfile, StructuredProfile, ChangeHistoryEntry } from "@/types";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";
const PROFILE_TEMPLATE_PATH = path.join(process.cwd(), "data", "profile-template.json");

// 推奨キー名（下流の produce/verify 等が参照するため、AI にはこの名前を使うよう誘導する）
// 資料にある内容はすべて出す。これ以外のキーも資料の見出しに素直に合わせて追加してよい。
const SUGGESTED_KEYS = [
  "会社法人等番号", "商号", "本店所在地", "設立年月日", "事業目的",
  "資本金", "発行可能株式総数", "発行済株式総数", "株式の譲渡制限（承認機関も記載）",
  "役員（役職・氏名・住所・就任日・任期満了）",
  "新株予約権", "公告方法", "決算期", "役員の任期（定款の規定）",
  "株主構成（氏名・住所・持株数・持株比率）",
];

async function getSuggestedKeys(): Promise<string[]> {
  try {
    const raw = await fs.readFile(PROFILE_TEMPLATE_PATH, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data.items) && data.items.length > 0 ? data.items : SUGGESTED_KEYS;
  } catch {
    return SUGGESTED_KEYS;
  }
}

function buildExtractPrompt(suggestedKeys: string[]): string {
  const suggested = suggestedKeys.map(k => `  - ${k}`).join("\n");

  return `以下の「資料（登記簿・定款・株主名簿・許認可証等）」から、その会社に関する情報を**すべて**抽出して構造化してください。
固定のフォーマットに無理に当てはめず、**資料に書いてある内容をそのまま JSON として整える**のが目的です。

2つのブロックに分けて出力してください。

【ブロック1: 表示用テキスト】
- 「項目名: 値」形式で1行ずつ出力（複数行は2行目以降インデント2スペース）
- 一覧系（役員・株主など）は1人1行 "氏名 / 住所 / ..." 形式
- セクション見出し（【】）やマークダウン記法は使わない

【ブロック2: JSON】
\`\`\`json
{
  "structured": {
    "商号": "...",
    "役員（役職・氏名・住所・就任日・任期満了）": [ { ... }, ... ],
    "株主構成（氏名・住所・持株数・持株比率）": [ { ... }, ... ],
    ...資料にある項目を全て...
  },
  "変更履歴": [
    { "日付": "YYYY-MM-DD", "内容": "変更内容の概要", "根拠ファイル": "ファイル名" }
  ]
}
\`\`\`

## 抽出ルール
- **資料に書かれている情報はすべて出す**（メールアドレス・電話番号・支店・取引銀行口座・許認可番号等があれば **それらも含める**）
- **下記の推奨キー名は優先して使う**（下流の書類生成で参照される）。資料にあるが推奨リストに無い項目は、素直な日本語で追加してよい
- 一覧系（役員・株主など）の**配列の各要素は、資料に記載のあるプロパティをすべて含める**。氏名・住所以外にメールアドレス・電話・持株数・議決権数・持株比率・就任日等、資料に書かれていれば全部入れる
- 資料に記載がない項目は**キー自体を省略する**（「不明」や空文字で埋めない）。
- ただし **推奨キーのうち登記簿・定款の基本事項**（商号・本店所在地・役員・資本金 等）は、資料に無ければ値を "不明" とする
- 役員は代表取締役を最初に記載
- 任期満了は就任日+任期年数→該当事業年度末日後の定時株主総会
- 変更履歴は複数の資料（旧登記簿・旧定款等）を比較して時系列記録。無ければ空配列[]
- ブロック1とブロック2の内容は完全一致させる

## 推奨キー（この名前で出力することを優先）
${suggested}`;
}

// 鮮度チェック: 共通フォルダのファイルが基本情報生成時より新しい/追加/削除されたかを判定
export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId は必須です" }, { status: 400 });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  if (!company.profile) {
    return NextResponse.json({ isStale: true, reason: "not_generated" });
  }

  // 共通フォルダの現在のファイルmtimeを取得（profileSources指定があればそれに絞る）
  const commonSubs = company.subfolders.filter(s => s.role === "common");
  const profileSourcesSet = company.profileSources && company.profileSources.length > 0
    ? new Set(company.profileSources)
    : null;
  const currentFiles: { path: string; mtime: string }[] = [];
  for (const sub of commonSubs) {
    const allContents = await readAllFilesInFolder(sub.id);
    const disabled = sub.disabledFiles || [];
    for (const content of allContents) {
      if (isPathDisabled(content.path, disabled)) continue;
      if (profileSourcesSet && !profileSourcesSet.has(content.path)) continue;
      try {
        const st = await fs.stat(content.path);
        currentFiles.push({ path: content.path, mtime: st.mtime.toISOString() });
      } catch { /* ignore */ }
    }
  }

  // profile.sourceFiles とのmtime比較
  const recorded = new Map<string, string | undefined>();
  for (const f of company.profile.sourceFiles || []) {
    if (typeof f === "string") recorded.set(f, undefined);
    else recorded.set(f.id, f.mtime);
  }

  // ファイル追加
  for (const cur of currentFiles) {
    if (!recorded.has(cur.path)) {
      return NextResponse.json({ isStale: true, reason: "added", path: cur.path });
    }
    const prevMtime = recorded.get(cur.path);
    // mtimeが記録されていない(旧データ)or 変更あり → stale
    if (prevMtime === undefined || prevMtime !== cur.mtime) {
      return NextResponse.json({ isStale: true, reason: "modified", path: cur.path });
    }
  }
  // ファイル削除
  const currentSet = new Set(currentFiles.map(f => f.path));
  for (const [p] of recorded) {
    if (!currentSet.has(p)) {
      return NextResponse.json({ isStale: true, reason: "removed", path: p });
    }
  }

  return NextResponse.json({ isStale: false });
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
  const profileSourcesSet = company.profileSources && company.profileSources.length > 0
    ? new Set(company.profileSources)
    : null; // null = 未設定 → 全ファイル使用（既存動作）

  const textFiles: { path: string; name: string; content: string }[] = [];
  const pdfFiles: { path: string; name: string; base64: string; mimeType: string }[] = [];

  for (const sub of commonSubs) {
    const allContents = await readAllFilesInFolder(sub.id);
    const disabled = sub.disabledFiles || [];

    for (const content of allContents) {
      if (isPathDisabled(content.path, disabled)) continue;
      // profileSources が設定されていれば、そこに含まれるものだけ使う
      if (profileSourcesSet && !profileSourcesSet.has(content.path)) continue;

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
    | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

  const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  const contentBlocks: ContentBlock[] = [];

  // PDFは document、画像は image として添付
  for (const pdf of pdfFiles) {
    if (pdf.mimeType === "application/pdf") {
      contentBlocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
        title: pdf.name,
      });
    } else if (IMAGE_MIMES.has(pdf.mimeType)) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: pdf.mimeType, data: pdf.base64 },
      });
    }
  }

  // テキストファイル + プロンプト
  const suggestedKeys = await getSuggestedKeys();
  let filesText = buildExtractPrompt(suggestedKeys) + "\n\n--- ファイル内容 ---\n";
  for (const f of textFiles) {
    filesText += `\n【${f.name}】\n${f.content}\n`;
  }
  contentBlocks.push({ type: "text", text: filesText });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: [{
        role: "user",
        content: contentBlocks as Anthropic.ContentBlockParam[],
      }],
    });
    logTokenUsage("/api/workspace/profile", MODEL, response.usage);

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

    // テキスト部分を抽出（JSONブロック・ブロックヘッダーを除去）
    const summary = rawText
      .replace(/```json[\s\S]*?```/g, "")
      .replace(/\{[\s\S]*\}/g, "") // 残ったJSONオブジェクトも除去
      .replace(/【ブロック2[\s\S]*/g, "")
      .replace(/##\s*ブロック\s*2[\s\S]*/g, "")
      .replace(/【ブロック1[：:][^】]*】\s*/g, "")
      .replace(/##\s*ブロック\s*1[^\n]*\n?/g, "")
      .replace(/\*\*ブロック\s*1[^\n]*\n?/g, "")
      .replace(/\*\*ブロック\s*2[\s\S]*/g, "")
      .trim();

    const allPaths = [
      ...textFiles.map(f => ({ name: f.name, path: f.path })),
      ...pdfFiles.map(f => ({ name: f.name, path: f.path })),
    ];
    const allFiles = await Promise.all(allPaths.map(async f => {
      try {
        const st = await fs.stat(f.path);
        return { name: f.name, id: f.path, mtime: st.mtime.toISOString() };
      } catch {
        return { name: f.name, id: f.path };
      }
    }));
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
      model: MODEL,
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
    logTokenUsage("/api/workspace/profile#diff", MODEL, response.usage);

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
    const newSourceEntries = await Promise.all(newContents.map(async f => {
      try {
        const st = await fs.stat(f.path);
        return { name: f.name, id: f.path, mtime: st.mtime.toISOString() };
      } catch {
        return { name: f.name, id: f.path };
      }
    }));
    company.profile.sourceFiles = [
      ...company.profile.sourceFiles,
      ...newSourceEntries,
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
