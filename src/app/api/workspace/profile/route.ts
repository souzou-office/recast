import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";
import { readFileById } from "@/lib/files-google";
import type { CompanyProfile } from "@/types";

const client = new Anthropic();

const EXTRACT_PROMPT = `以下のファイルから会社の基本情報を抽出してください。
情報がないものは「不明」としてください。

出力ルール:
- 各項目は「項目名: 値」の形式。値が複数行になる場合、2行目以降は先頭にスペース2つを入れてください。
- セクション見出し（【】）やマークダウン記法は使わないでください。
- 必ず以下の項目名を使ってください。項目名を変えないでください。

会社法人等番号: （数字）
商号: （会社名）
本店所在地: （住所）
設立年月日: （日付）
事業目的:
  (1) ...
  (2) ...
資本金: （金額）
発行可能株式総数: （株数）
発行済株式総数: （株数）
株式の譲渡制限: （1行で。承認機関も記載）
役員:
  代表取締役 氏名 / 住所: ○○ / 就任: YYYY年MM月DD日 / 任期満了: YYYY年MM月（定時株主総会終結時）
  取締役 氏名 / 住所: ○○ / 就任: YYYY年MM月DD日 / 任期満了: YYYY年MM月（定時株主総会終結時）
  （代表取締役を最初に記載。住所は登記簿に記載があれば記載、なければ省略）
  （就任日が不明でも「不明」とせず、設立時取締役であれば設立年月日を就任日とすること）
  （※任期満了は必ず具体的な年月で算出すること。定款の文言をそのまま書かないこと。算出方法: 就任日+任期年数の日が属する事業年度の末日の翌日以降に開催される定時株主総会の時期。例: 就任2023年2月、任期10年、決算期9月末→2032年9月期が任期内最終事業年度→2032年12月頃の定時株主総会終結時）
新株予約権: （1行で簡潔に。なければ「なし」）
公告方法: （1行で）
決算期: （事業年度の開始月〜終了月）
役員の任期: （定款の規定をそのまま記載）
株主構成:
  氏名 / 住所 / 持株数 / 持株比率
  氏名 / 住所 / 持株数 / 持株比率
  （株主名簿や登記簿に住所の記載があれば記載）
備考: （あれば。なければ省略）`;

// 基本情報を生成
export async function POST(request: NextRequest) {
  const { companyId } = await request.json();

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // 共通フォルダのenabledファイルを読む（未スキャンなら自動スキャン）
  const commonSubs = company.subfolders.filter(s => s.role === "common");
  let configUpdated = false;

  for (const sub of commonSubs) {
    if (!sub.files || sub.files.length === 0) {
      // ファイル未スキャン → scan-files相当の処理
      const scanRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/workspace/scan-files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id, subfolderId: sub.id }),
      });
      if (scanRes.ok) {
        const { files } = await scanRes.json();
        sub.files = files;
        configUpdated = true;
      }
    }
  }

  if (configUpdated) {
    await saveWorkspaceConfig(config);
  }

  const textFiles: { id: string; name: string; content: string }[] = [];
  const pdfFiles: { id: string; name: string; base64: string; mimeType: string }[] = [];

  for (const sub of commonSubs) {
    if (!sub.files) continue;
    for (const f of sub.files) {
      if (!f.enabled) continue;
      const content = await readFileById(f.id, f.name, f.mimeType);
      if (!content) continue;
      if (content.base64) {
        pdfFiles.push({ id: f.id, name: f.name, base64: content.base64, mimeType: content.mimeType || "application/pdf" });
      } else {
        textFiles.push({ id: f.id, name: f.name, content: content.content });
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
  let filesText = EXTRACT_PROMPT + "\n\n--- ファイル内容 ---\n";
  for (const f of textFiles) {
    filesText += `\n【${f.name}】\n${f.content}\n`;
  }
  contentBlocks.push({ type: "text", text: filesText });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: contentBlocks as Anthropic.ContentBlockParam[],
      }],
    });

    const summary = response.content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text : "")
      .join("");

    const allFiles = [
      ...textFiles.map(f => ({ name: f.name, id: f.id })),
      ...pdfFiles.map(f => ({ name: f.name, id: f.id })),
    ];
    const profile: CompanyProfile = {
      summary,
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

// 差分更新（新しいファイルがあれば更新）
export async function PATCH(request: NextRequest) {
  const { companyId, newFiles } = await request.json() as {
    companyId: string;
    newFiles: { id: string; name: string; mimeType: string }[];
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company || !company.profile) {
    return NextResponse.json({ error: "基本情報がありません。先に生成してください" }, { status: 400 });
  }

  // 新しいファイルの内容を読む
  const newContents: { name: string; content: string }[] = [];
  for (const f of newFiles) {
    const content = await readFileById(f.id, f.name, f.mimeType);
    if (content && !content.base64) {
      newContents.push({ name: f.name, content: content.content });
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
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: `以下は会社の現在の基本情報です：

${company.profile.summary}

新しいファイルが追加されました。内容を確認し、基本情報に変更があれば更新してください。
変更がなければそのまま返してください。同じフォーマットで返してください。

--- 新しいファイル ---
${newFilesText}`,
      }],
    });

    const summary = response.content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text : "")
      .join("");

    company.profile.summary = summary;
    company.profile.updatedAt = new Date().toISOString();
    company.profile.sourceFiles = [
      ...company.profile.sourceFiles,
      ...newContents.map(f => f.name),
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
