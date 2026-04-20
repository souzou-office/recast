import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { mimeFromExtension } from "@/lib/file-parsers";
import { isPathDisabled } from "@/lib/disabled-filter";

const client = new Anthropic();

export async function POST(request: NextRequest) {
  const { companyId, folderPath, disabledFiles, templateFolderPath } = await request.json() as {
    companyId: string;
    folderPath?: string;
    disabledFiles?: string[];
    templateFolderPath?: string;
  };

  const config = await getWorkspaceConfig();
  const company = companyId
    ? config.companies.find(c => c.id === companyId)
    : config.companies.find(c => c.id === config.selectedCompanyId);

  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // 全資料を収集
  const allTexts: string[] = [];
  const pdfFiles: { name: string; base64: string; mimeType: string }[] = [];
  const sourceFiles: { id: string; name: string; mimeType: string }[] = [];

  if (folderPath) {
    // チャットのフォルダ選択カードで指定されたパスを読む
    const files = await readAllFilesInFolder(folderPath);
    const disabled = disabledFiles || [];
    for (const content of files) {
      if (disabled.includes(content.path)) continue;
      const ext = path.extname(content.name).toLowerCase();
      const mime = mimeFromExtension(ext);
      sourceFiles.push({ id: content.path, name: content.name, mimeType: mime });
      if (content.base64) {
        pdfFiles.push({ name: content.name, base64: content.base64, mimeType: content.mimeType || "application/pdf" });
      } else {
        allTexts.push(`--- ${content.name} ---\n${content.content}`);
      }
    }
  } else {
    // フォールバック: sub.role === "job" && sub.active の案件フォルダ
    for (const sub of company.subfolders) {
      if (!(sub.role === "job" && sub.active)) continue;
      const files = await readAllFilesInFolder(sub.id);
      const disabled = sub.disabledFiles || [];
      for (const content of files) {
        if (isPathDisabled(content.path, disabled)) continue;
        const ext = path.extname(content.name).toLowerCase();
        const mime = mimeFromExtension(ext);
        sourceFiles.push({ id: content.path, name: content.name, mimeType: mime });
        if (content.base64) {
          pdfFiles.push({ name: content.name, base64: content.base64, mimeType: content.mimeType || "application/pdf" });
        } else {
          allTexts.push(`--- ${content.name} ---\n${content.content}`);
        }
      }
    }
  }

  if (allTexts.length === 0 && pdfFiles.length === 0) {
    return NextResponse.json({ error: "案件フォルダに読み取れるファイルがありません" }, { status: 400 });
  }

  // テンプレートから「必要な項目ラベル」を抽出して JSON キーとして AI に渡す。
  // テンプレ本文は送らない（AI はラベル一覧だけ見て、案件資料から値を拾う）。
  let templateContext = "";
  const requiredLabels = new Set<string>();
  if (templateFolderPath) {
    try {
      const templateFiles = await readAllFilesInFolder(templateFolderPath);

      for (const tf of templateFiles) {
        if (tf.base64) continue;
        const ext = tf.name.toLowerCase().split(".").pop() || "";
        if (!["docx", "doc", "xlsx", "xls"].includes(ext)) continue;

        // プレースホルダー方式: 【X】 / {{X}} の X をそのままラベルに
        const phPatterns = [/【([^】]+)】/g, /\{\{([^}]+)\}\}/g, /｛｛([^｝]+)｝｝/g];
        for (const re of phPatterns) {
          let m;
          while ((m = re.exec(tf.content)) !== null) {
            const name = m[1].trim();
            if (name.startsWith("#") || name.startsWith("/")) continue;
            requiredLabels.add(name);
          }
        }

        // ハイライト方式: 各フィールドの周辺文脈から「ラベル（型）」を作る
        if (ext === "docx") {
          try {
            const buf = await import("fs/promises").then(fs => fs.readFile(tf.path));
            const { extractMarkedFields } = await import("@/lib/docx-marker-parser");
            const fields = extractMarkedFields(buf);
            for (const f of fields) {
              if (f.comment) { requiredLabels.add(f.comment); continue; }
              const ctx = (f.context || "").replace(/\s+/g, " ").trim();
              const val = f.originalValue;
              const idx = ctx.indexOf(val);
              const before = idx >= 0 ? ctx.slice(Math.max(0, idx - 40), idx).trim() : "";
              const after  = idx >= 0 ? ctx.slice(idx + val.length, idx + val.length + 20).trim() : "";
              const m = before.match(/[一-龥ぁ-んァ-ヶA-Za-z0-9]+(?=[\s　:：の・]*$)/);
              let label = m ? m[0] : before.slice(-20);
              if (after.startsWith("円")) label = label + "（金額）";
              else if (after.startsWith("株")) label = label + "（株数）";
              else if (after.startsWith("名")) label = label + "（人数）";
              else if (/年|月|日/.test(val) && !/人名|氏名|住所/.test(label)) label = label + "（日付）";
              label = label.trim();
              if (label.length > 40) label = label.slice(-40);
              if (label) requiredLabels.add(label);
            }
          } catch { /* ignore */ }
        }
        // Excel の黄色セルは今はラベル抽出が難しいのでスキップ（プレースホルダーが優先）
      }

      if (requiredLabels.size > 0) {
        const labels = [...requiredLabels].sort();
        templateContext = `\n## 作成予定の書類に必要な項目（これだけ抽出すればよい）\n以下のラベルが全ての「可変箇所」です。これに対応する値を案件資料から取ってきてください。
${labels.map(l => `- ${l}`).join("\n")}

**出力方針**: 上記ラベルと同じキーを持つ JSON に近い表形式で整理してください。
`;
      }
    } catch { /* ignore */ }
  }

  const promptText = `以下の「案件資料」を確認し、**上記の「必要な項目」に限定して**値を抽出してください。
${templateContext}
ルール:
- **上記のラベル一覧にあるものだけ**を出力する。ラベルに無い情報は出さない（会社の基本情報は除外）
- 出力は **ラベル名をキーとした表** 形式で、**1ラベル=1行**。同じラベルに複数値あれば配列（[值1, 值2]）にする
- 日付・金額・人名は資料から**正確に転記**（勝手な変換・概算は禁止）
- 根拠ファイル名を右端カラムに必ず併記
- 資料に見つからない項目は値欄を **\`*要確認*\`** にする（省略しない）
- 矛盾があれば末尾に "## ⚠ 要確認" セクションを追加して列挙

## 出力形式例
\`\`\`
| 項目 | 値 | 根拠ファイル |
|------|-----|-------------|
| 募集株式の数（株数） | 5,263株 | 10.普通株投資契約書.docx |
| 募集株式の払込金額（金額） | 475円 | 10.普通株投資契約書.docx |
| 払込期日（日付） | 2025年1月30日 | 00.増資関連書類、スケジュール.xlsx |
\`\`\`

## 案件資料
${allTexts.join("\n\n")}`;

  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

  const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

  const contentBlocks: ContentBlock[] = [];
  for (const pdf of pdfFiles) {
    if (pdf.mimeType === "application/pdf") {
      contentBlocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
        title: pdf.name,
      });
    }
    // 画像は案件整理では送らない（テキスト+PDFで十分、壊れた画像でAPIエラーになるリスク回避）
  }
  contentBlocks.push({ type: "text", text: promptText });

  try {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "meta",
          sourceFiles,
        })}\n\n`));

        const aiStream = client.messages.stream({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          messages: [{ role: "user", content: contentBlocks as Anthropic.ContentBlockParam[] }],
        });

        for await (const event of aiStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: "text",
              text: event.delta.text,
            })}\n\n`));
          }
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "実行に失敗しました" },
      { status: 500 }
    );
  }
}
