import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { mimeFromExtension } from "@/lib/file-parsers";
import { isPathDisabled } from "@/lib/disabled-filter";
import { logTokenUsage } from "@/lib/token-logger";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

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

  // テンプレートごとに「意味ラベル付きのスロット一覧」を準備する。
  // 初回は Haiku で解析してキャッシュ（.labels.json）、以降はキャッシュから即返し。
  // これで案件整理 AI は各スロットの意味（例: "取締役決定書の作成日"）＋記載形式
  // （例: "令和○年○月○日"）＋推定出典（"案件スケジュール表"）が分かる。
  let templateContext = "";
  type FlatLabel = { docName: string; label: string; format: string; sourceHint?: string };
  const allLabels: FlatLabel[] = [];
  if (templateFolderPath) {
    try {
      const templateFiles = await readAllFilesInFolder(templateFolderPath);
      const { ensureDocxLabels, ensureXlsxLabels } = await import("@/lib/template-labels");

      // プレースホルダー方式 ({{X}} / 【X】): その名前自体が意味ラベルなのでそのまま使う
      const placeholderExists = new Set<string>();
      for (const tf of templateFiles) {
        if (tf.base64) continue;
        const phPatterns = [/【([^】]+)】/g, /\{\{([^}]+)\}\}/g, /｛｛([^｝]+)｝｝/g];
        for (const re of phPatterns) {
          let m;
          while ((m = re.exec(tf.content)) !== null) {
            const name = m[1].trim();
            if (name.startsWith("#") || name.startsWith("/")) continue;
            if (!placeholderExists.has(name)) {
              allLabels.push({ docName: tf.name, label: name, format: "" });
              placeholderExists.add(name);
            }
          }
        }
      }

      // ハイライト方式: キャッシュ利用のラベル解析
      for (const tf of templateFiles) {
        if (tf.base64) continue;
        const ext = tf.name.toLowerCase().split(".").pop() || "";
        const baseName = tf.name.replace(/\.[^.]+$/, "");
        let labels;
        if (ext === "docx" || ext === "docm") {
          labels = await ensureDocxLabels(tf.path);
        } else if (ext === "xlsx" || ext === "xlsm" || ext === "xls") {
          labels = await ensureXlsxLabels(tf.path);
        }
        if (!labels) continue;
        // 同一 label が重複する場合は排除（ハイライトが複数あっても同じ意味ラベルなら1行）
        const seen = new Set<string>();
        for (const s of labels.slots) {
          const labelKey = s.label;
          if (!labelKey || labelKey === "不明" || seen.has(labelKey)) continue;
          seen.add(labelKey);
          allLabels.push({
            docName: baseName,
            label: s.label,
            format: s.format,
            sourceHint: s.sourceHint,
          });
        }
      }

      if (allLabels.length > 0) {
        // 書類別にグループ化して AI に渡す
        const byDoc: Record<string, FlatLabel[]> = {};
        for (const l of allLabels) {
          if (!byDoc[l.docName]) byDoc[l.docName] = [];
          byDoc[l.docName].push(l);
        }
        const lines: string[] = [];
        for (const [doc, labels] of Object.entries(byDoc)) {
          lines.push(`### ${doc}`);
          for (const l of labels) {
            const parts = [`- **${l.label}**`];
            if (l.format) parts.push(`形式: \`${l.format}\``);
            if (l.sourceHint) parts.push(`出典候補: ${l.sourceHint}`);
            lines.push(parts.join(" | "));
          }
          lines.push("");
        }
        templateContext = `\n## 作成予定の書類に必要な項目（これだけ抽出すればよい）\n各書類ごとに、必要な項目・記載形式・推定出典を示します。
これに対応する値を案件資料から取ってきてください。

${lines.join("\n")}
**出力方針**: 上記ラベルと同じ項目名を使って表形式で整理してください。値は format の記載形式に揃えてください。
`;
      }
    } catch { /* ignore */ }
  }

  // 会社の基本情報（profile.structured）も参考データとして添付する。
  // 案件資料に書かれていない値が基本情報にあれば、そこから採用してよい（根拠は「基本情報」と表示）。
  const profileBlock = company.profile?.structured
    ? `\n## 会社の基本情報（参照データ）\n\`\`\`json\n${JSON.stringify(company.profile.structured, null, 2)}\n\`\`\`\n`
    : "";

  const promptText = `以下の「案件資料」を確認し、**上記の「必要な項目」だけ**を抽出・整理してください。

${templateContext}
${profileBlock}

## 出力の作り方（ユーザーが読む内容）

見出しでグループ化し、項目ごとに短いコメントを添えて、**人が読みやすい** 形で整理してください。

- **意味のまとまりごと** に \`## 見出し\` を置く（例: 日程 / 金銭条件 / 当事者 / 引受先 / その他）
- 各グループ内は **表形式** で \`| 項目 | 値 | 根拠 |\`
- 項目名は上記ラベルと対応するが、**読みやすさ優先**で自然な日本語に整える（例: 「払込期日（日付）」→「払込期日」）
- 値は **正確に転記**（勝手な変換・四捨五入・補完は禁止）
- **根拠欄**の書き方:
  - 案件資料のファイルから取った → 📄<ファイル名>
  - 会社の基本情報（上の「参照データ」JSON）から取った → **📇基本情報**
  - 両方に載っていれば 📇基本情報 を先に
- 資料にも基本情報にも見つからない項目は値欄を **\`*要確認*\`** にし、省略しない

### 株主関連ラベルの解釈ガイド（重要）
株主関連の項目は、基本情報の \`株主構成\` 配列（各要素が氏名・住所・持株数・持株比率を持つ）から必ず算出・抽出すること。要確認にしない。

- **「議決権を行使することができる株主の数」** = 株主構成の要素数（全株主数）
- **「議決権を行使することができる株主の議決権の数」** = 株主構成の持株数の合計
- **「大量保有株主の氏名又は名称/住所/保有株式数」** = 株主構成の中で最大保有者（持株数が最多の1名）の値
- **「大量保有株主の議決権数の割合」** = その株主の持株比率（％、小数点以下2桁）
- **「上位株主の合計議決権数」「上位株主の合計議決権数の割合」** = 上位N名（通常は過半数に達するまで or 契約書指定数）の合計。指定がなければ全株主合計でよい
- **「第N株主の氏名/住所/メールアドレス」** = 株主構成の N 番目（持株数降順）の値。メールは基本情報に無ければ 📄案件資料から探す
- **「株主の氏名 / 住所（提案書兼同意書等の署名欄）」**= 株主全員分。値欄には「（株主構成全員分）」と書き、根拠は **📇基本情報：株主構成** とする（具体名列挙は不要、produce 段階で展開）
- **「株主全員の連絡先」** など名前だけ一覧が必要な場合も同様に、**📇基本情報：株主構成** を根拠に書く（要確認にしない）
- 矛盾・表記揺れ・要確認事項は最後に **\`## ⚠ 要確認事項\`** として箇条書き
- 本文の頭に 1 文の「今回の手続き要約」を書いてよい（例: 「Deep30 投資事業有限責任組合を引受人とする第三者割当増資」）
- **上記ラベルに無い情報は出さない**

## 出力例（形式の参考）

\`\`\`
今回の手続き: Deep30投資事業有限責任組合を引受人とする第三者割当増資。

## 当事者

| 項目 | 値 | 根拠 |
|------|-----|------|
| 発行会社 | 株式会社JINGS | 📇基本情報 |
| 代表取締役 | 三上春香 | 📇基本情報 |
| 取締役総数 | 2名 | 📇基本情報 |
| 引受人 | Deep30投資事業有限責任組合 | 📄10.普通株投資契約書.docx |

## 日程

| 項目 | 値 | 根拠 |
|------|-----|------|
| 取締役決定日 | 2025年1月21日 | 📄00.増資関連書類、スケジュール.xlsx |
| 払込期日 | 2025年1月30日 | 📄10.普通株投資契約書.docx |

## 金銭条件

| 項目 | 値 | 根拠 |
|------|-----|------|
| 募集株式の数 | 5,263株（普通株式） | 📄10.普通株投資契約書.docx |
| 1株払込金額 | 475円 | 📄10.普通株投資契約書.docx |
| 増加する資本金 | 1,249,963円 | 📄10.普通株投資契約書.docx |
| 増加する資本準備金 | 1,249,962円 | 📄10.普通株投資契約書.docx |

## ⚠ 要確認事項
- 発行会社の商号が「株式会社JING」と「株式会社JINGS」で混在
\`\`\`

## 案件資料
${allTexts.join("\n\n")}`;

  type ContentBlock =
    | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
    | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string; cache_control?: { type: "ephemeral" } }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: { type: "ephemeral" } };

  // 画像は案件整理では送らない（テキスト+PDFで十分、壊れた画像でAPIエラーになるリスク回避）
  const contentBlocks: ContentBlock[] = [];
  for (const pdf of pdfFiles) {
    if (pdf.mimeType === "application/pdf") {
      contentBlocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
        title: pdf.name,
      });
    }
  }
  // 案件整理は 1 案件に 1 回しか呼ばれないので cache_control を付けない。
  // （cache_write は通常入力の 1.25 倍なので、2回目の読み込みが無ければ損になる）
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
          model: MODEL,
          max_tokens: 8192,
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

        try {
          const final = await aiStream.finalMessage();
          logTokenUsage("/api/templates/execute", MODEL, final.usage);
        } catch { /* ignore */ }

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
