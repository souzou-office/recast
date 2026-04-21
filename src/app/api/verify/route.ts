import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder, readFileContent } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";
import { mimeFromExtension } from "@/lib/file-parsers";
import { logTokenUsage } from "@/lib/token-logger";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx");

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

// 生成書類の base64 からテキストを抽出。ファイル名の拡張子で docx / xlsx を分岐。
// xlsx を mammoth に通すと空文字になり、チェック対象から漏れるので必ず拡張子判定が必要。
async function extractDocumentText(base64: string, fileName: string): Promise<string> {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  try {
    const buffer = Buffer.from(base64, "base64");
    if (ext === "xlsx" || ext === "xlsm" || ext === "xls") {
      const wb = XLSX.read(buffer, { type: "buffer" });
      const parts: string[] = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        // 値だけ取り出す（書式ではなく計算後の値）。空白行は除く。
        const csv: string = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        if (csv.trim()) {
          parts.push(`[シート: ${sheetName}]\n${csv}`);
        }
      }
      return parts.join("\n\n").trim();
    }
    // docx / docm / その他 → mammoth
    const result = await mammoth.extractRawText({ buffer });
    return result.value?.trim() || "";
  } catch {
    return "";
  }
}

// 案件整理の結果と生成書類を突合せ
export async function POST(request: NextRequest) {
  const { companyId, fileIds, caseRoomId, threadId, folderPath: caseFolderPath, disabledFiles: caseDisabledFiles } = await request.json() as {
    companyId: string;
    fileIds?: string[];
    caseRoomId?: string;
    threadId?: string;
    folderPath?: string;
    disabledFiles?: string[];
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return new Response(JSON.stringify({ error: "会社が見つかりません" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  // スレッドから生成書類・Q&A・テンプレートパスを取得
  let threadDocs: { templateName: string; docxBase64: string; previewHtml: string; fileName: string }[] = [];
  let threadQA: { question: string; answer: string }[] = [];
  let threadTemplatePath: string | undefined;
  if (threadId) {
    try {
      const fs = await import("fs/promises");
      const nodePath = await import("path");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const crypto = require("crypto");
      const companyHash = crypto.createHash("md5").update(companyId).digest("hex");
      const dataDir = nodePath.default.join(process.cwd(), "data", "chat-threads", companyHash);
      const threadFile = nodePath.default.join(dataDir, `${threadId}.json`);
      const raw = await fs.default.readFile(threadFile, "utf-8");
      const thread = JSON.parse(raw);
      if (thread.generatedDocuments) threadDocs = thread.generatedDocuments;
      // clarification カードから Q&A を収集
      type Q = { id: string; placeholder: string; question: string; selectedOptionId?: string; manualInput?: string; options: { id: string; label: string }[] };
      type Card = { type: string; questions?: Q[]; selectedPath?: string };
      for (const m of thread.messages || []) {
        for (const c of (m.cards || []) as Card[]) {
          if (c.type === "clarification" && c.questions) {
            for (const q of c.questions) {
              let ans = "";
              if (q.selectedOptionId === "_manual") ans = q.manualInput || "";
              else if (q.selectedOptionId) {
                const opt = q.options.find(o => o.id === q.selectedOptionId);
                ans = opt?.label || "";
              }
              if (ans) threadQA.push({ question: `【${q.placeholder}】${q.question}`, answer: ans });
            }
          }
          if (c.type === "template-select" && c.selectedPath) {
            threadTemplatePath = c.selectedPath;
          }
        }
      }
    } catch { /* ignore */ }
  }

  const caseRoom = caseRoomId ? company.caseRooms?.find(r => r.id === caseRoomId) : null;
  const masterSheet = caseRoom?.masterSheet || company.masterSheet;
  const profile = company.profile;
  const generatedDocuments = threadDocs.length > 0
    ? threadDocs
    : (caseRoom?.generatedDocuments || company.generatedDocuments || []);

  if (generatedDocuments.length === 0) {
    return new Response(JSON.stringify({ error: "生成済み書類がありません。先に書類を生成してください。" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // --- 1. 生成済み書類のテキスト抽出 ---
  const generatedTexts: string[] = [];
  for (const doc of generatedDocuments) {
    const text = await extractDocumentText(doc.docxBase64, doc.fileName);
    if (text) {
      generatedTexts.push(`【生成書類: ${doc.fileName}】\n${text}`);
    }
  }

  // --- 2. 原本ファイルの読み込み ---
  type ContentBlock =
    | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
    | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string; cache_control?: { type: "ephemeral" } }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: { type: "ephemeral" } };

  const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

  const contentBlocks: ContentBlock[] = [];
  const textParts: string[] = [];
  const sourceFiles: { id: string; name: string; mimeType: string }[] = [];

  const pushBase64File = (fc: { name: string; mimeType?: string; base64: string }, title: string) => {
    const mime = fc.mimeType || "application/pdf";
    if (mime === "application/pdf") {
      contentBlocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: fc.base64 },
        title,
      });
    } else if (IMAGE_MIMES.has(mime)) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: mime, data: fc.base64 },
      });
    }
  };

  if (fileIds && fileIds.length > 0) {
    for (const filePath of fileIds) {
      const fc = await readFileContent(filePath);
      if (!fc) continue;

      const ext = path.extname(fc.name).toLowerCase();
      const mime = mimeFromExtension(ext);
      sourceFiles.push({ id: fc.path, name: fc.name, mimeType: mime });

      if (fc.base64) {
        pushBase64File({ name: fc.name, mimeType: fc.mimeType, base64: fc.base64 }, `[原本] ${fc.name}`);
      } else {
        textParts.push(`【原本: ${fc.name}】\n${fc.content}`);
      }
    }
  } else {
    // 統一ヘルパーで共通+案件フォルダを読み込み（folderPath優先）
    const { readCaseFiles } = await import("@/lib/read-case-files");
    const caseFileSet = await readCaseFiles(company, {
      folderPath: caseFolderPath,
      disabledFiles: caseDisabledFiles,
    });

    if (caseFileSet.commonTexts.length > 0) {
      textParts.push("=== 原本: 共通フォルダ（定款・登記簿・株主名簿等の会社基本情報）===\n" + caseFileSet.commonTexts.join("\n\n"));
    }
    if (caseFileSet.caseTexts.length > 0) {
      textParts.push("=== 原本: 案件フォルダ（今回の手続き内容: 議事録・指示書・スケジュール等）===\n" + caseFileSet.caseTexts.join("\n\n"));
    }
    for (const pdf of caseFileSet.pdfBlocks) {
      contentBlocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
        title: `${pdf.tag} ${pdf.name}`,
      });
    }
  }

  // --- 3. 案件整理結果 ---
  const referenceData: Record<string, unknown> = {};
  if (profile?.structured) referenceData["基本情報"] = profile.structured;
  if (masterSheet?.structured) referenceData["案件整理結果"] = masterSheet.structured;
  if (masterSheet?.content) referenceData["案件整理テキスト"] = masterSheet.content;

  // テンプレート・共通ルールは渡さない（最終チェックは原本vs生成書類の突合せのみ）

  // --- 3c. これまでのQ&A（ユーザーが既に確定した内容） ---
  const qaBlock = threadQA.length > 0
    ? `\n## ユーザー確定済みの回答（チェック時の前提。これらの値は正しいものとして扱う）\n` +
      threadQA.map(qa => `- Q: ${qa.question}\n  A: ${qa.answer}`).join("\n") + "\n"
    : "";

  // --- 4. プロンプト構築 ---
  const prompt = `以下の「原本（元資料）」と「生成済み書類（recastが作成した書類）」を突合せチェックしてください。

## 重要な前提（必ず守ること）

recast は書類テンプレート内のマーカー（要入力箇所）に**値を埋める**処理だけを行います。テンプレートの固定文言（条文番号・見出し・箇条書き記号・条項構成など）は recast が一切触っていません。

したがって **verify のチェック対象は「recast が埋めた値」のみ** です。

### ✅ 指摘対象（値の正しさ）
- 日付・氏名・住所・会社名・金額・株数・持分比率などの**値**が、原本/基本情報/案件整理と不整合
- 値が \`（要確認）\` のまま残っている
- 書類間で同じ意味の値が不一致（書類Aの代表取締役氏名 ≠ 書類Bの代表取締役氏名 等）
- 必須の値が空欄

### ❌ 指摘してはいけないもの（recast が触っていない部分）
- **条文番号の体系**（第1条、第2条 等、①②③ 等、(1)(2)(3) 等）
- **箇条書き記号の揺れ**（①と 1. と ・ の混在など）
- **全角半角の違い**、空白・改行・句読点の差
- 見出し・定型文・章立て等、テンプレート由来の固定文言
- **Word の自動番号付け機能による番号の抽出漏れ**: 生成書類のテキスト抽出時に箇条書き番号が一部だけ取れないことがあるが、これはテキスト抽出ツールの限界で、実際のファイルには番号が正しく表示されている。「③だけある、他は無い」のような抽出結果でも **実体の問題ではないので絶対に指摘しないこと**

**判定の指針**: 「この不整合は recast が値を埋める際のミスか、それともテンプレ由来・抽出ツール由来か」を必ず自問し、後者なら issues に含めない。

${qaBlock}
## 案件整理結果
${JSON.stringify(referenceData, null, 2)}

## 原本（元資料）
${textParts.join("\n\n")}

## 生成済み書類（チェック対象）
${generatedTexts.join("\n\n")}

## チェック観点（重要度順）

### 1. 原本と生成書類の値の整合性（recastが埋めた値のみ）
- 原本（定款・登記簿・株主名簿・議事録・指示書等）に記載されている**値**と、生成書類に埋められた**値**が一致しているか
- 日付、金額、人名、住所、株数、持分比率などの転記ミス
- 計算結果の正しさ（株数の合計、議決権数など）
- **「ユーザー確定済みの回答」で明示的に確定した値は正しいものとして扱う**

### 2. 生成書類間の値の整合性
- 複数の生成書類で、同じ意味を持つ値（日付、人名、会社名等）が一致しているか
- **条文構成や見出しの違いは対象外**（テンプレの仕様差で、recast が触っていない）
- ある書類で記載した内容が、別の書類と矛盾していないか

### 3. 記載漏れ・形式
- 「（要確認）」が残っている箇所
- 必要な情報が空欄や未記入のまま

## 出力フォーマット
**書類ごと** に整理した JSON を返してください。フォーマットは以下のとおり:

\`\`\`json
{
  "summary": "3 書類で計 5 件の要確認が見つかりました",
  "documents": [
    {
      "docName": "1.取締役決定書",
      "status": "ok" | "warn" | "error",
      "issues": [
        {
          "severity": "error" | "warn" | "info",
          "aspect": "原本との整合性",
          "problem": "代表取締役の氏名が福田峻介になっているが、基本情報では三上春香",
          "expected": "三上春香"
        }
      ]
    },
    ...
  ]
}
\`\`\`

severity の基準:
- "error"（🔴重大）: 登記/法務上 影響があり、確実に修正が必要
- "warn" （🟡注意）: 表記揺れ・軽微な不整合で、確認の上で OK にできる可能性あり
- "info" （🔵軽微）: 表現の差程度、実害は薄い

ルール:
- **全ての生成書類を documents 配列に必ず含める**（問題なしなら status: "ok", issues: []）
- 問題があるものだけ issues を埋める
- docName は「生成済み書類」セクションで使っている書類名と完全一致させる
- JSON のみ返す（説明文は不要）`;

  // verify は 1 案件に 1 回しか呼ばれないので cache_control を付けない。
  // （cache_write は通常入力の 1.25 倍なので、2回目の読み込みが無ければ損になる）
  contentBlocks.push({ type: "text", text: prompt });

  // 生成書類のファイル名もsourceFilesに追加（リンク用）
  for (const doc of generatedDocuments) {
    sourceFiles.push({ id: `generated:${doc.fileName}`, name: `[生成] ${doc.fileName}`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ type: "meta", sourceFiles });

      try {
        const aiStream = client.messages.stream({
          model: MODEL,
          max_tokens: 8192,
          messages: [{ role: "user", content: contentBlocks as Anthropic.ContentBlockParam[] }],
        });

        for await (const event of aiStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            send({ type: "text", text: event.delta.text });
          }
        }

        try {
          const final = await aiStream.finalMessage();
          logTokenUsage("/api/verify", MODEL, final.usage);
        } catch { /* ignore */ }

        send({ type: "done" });
      } catch (e) {
        send({ type: "error", error: e instanceof Error ? e.message : "突合せに失敗" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
