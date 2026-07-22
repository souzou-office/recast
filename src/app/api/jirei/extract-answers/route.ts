// 申請タブの「資料ドロップ → 質問の答えを抽出」API。
//
//   POST /api/jirei/extract-answers … { jireiId, files: [{ name, base64 }] }
//     → { answers: { [questionId]: value }, sources: { [questionId]: fileName }, notFound: [questionId] }
//
// AI の役割は「木が定義した質問に、ドロップされた案件資料から答える」ことだけ。
// 穴埋め・書類生成には一切関与しない（そこは従来どおり決定論）。
// 抽出結果は UI で質問欄にプレフィルされ、人が確認してから生成に進む。
//
// Web展開原則: ファイルはパスではなくコンテンツ (base64) で受ける。サーバー fs 読み込みなし。

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { loadJirei } from "@/lib/jirei/loader";
import { parseBuffer, mimeFromExtension, MAX_BINARY_SIZE } from "@/lib/file-parsers";
import { logTokenUsage } from "@/lib/token-logger";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";
const MAX_FILES = 8;

interface DroppedFile {
  name: string;
  base64: string;
}

type ImageMedia = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jireiId: string | undefined = body.jireiId;
    const files: DroppedFile[] = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : [];

    if (!jireiId) return NextResponse.json({ error: "jireiId は必須です" }, { status: 400 });
    if (files.length === 0) return NextResponse.json({ error: "files は必須です" }, { status: 400 });

    const jirei = await loadJirei(jireiId);
    if (!jirei) return NextResponse.json({ error: "事由が見つかりません" }, { status: 404 });
    if (jirei.questions.length === 0) {
      return NextResponse.json({ answers: {}, sources: {}, notFound: [] });
    }

    // --- ドロップされたファイルを Claude に渡せる形に変換 ---
    // テキスト抽出できるもの (docx/xlsx/pdf/txt...) はテキストで、
    // 画像とスキャン PDF は image / document block で渡す。
    const blocks: Anthropic.ContentBlockParam[] = [];
    const skipped: string[] = [];

    for (const f of files) {
      if (!f?.name || !f?.base64) continue;
      const buf = Buffer.from(f.base64, "base64");
      if (buf.length > MAX_BINARY_SIZE) {
        skipped.push(`${f.name}（サイズ超過）`);
        continue;
      }
      const mime = mimeFromExtension(path.extname(f.name));
      const parsed = await parseBuffer(buf, f.name, f.name, mime);
      if (!parsed) {
        skipped.push(`${f.name}（非対応の形式）`);
        continue;
      }
      if (parsed.base64 && parsed.mimeType?.startsWith("image/")) {
        blocks.push({ type: "text", text: `【資料: ${f.name}（画像）】` });
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: parsed.mimeType as ImageMedia, data: parsed.base64 },
        });
      } else if (parsed.base64 && parsed.mimeType === "application/pdf") {
        blocks.push({ type: "text", text: `【資料: ${f.name}（スキャンPDF）】` });
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: parsed.base64 },
        });
      } else {
        blocks.push({ type: "text", text: `【資料: ${f.name}】\n${parsed.content}` });
      }
    }

    if (blocks.length === 0) {
      return NextResponse.json(
        { error: `読み取れるファイルがありません${skipped.length ? `（${skipped.join("、")}）` : ""}` },
        { status: 400 }
      );
    }

    const questionList = jirei.questions
      .map((q) => {
        const choices = q.kind === "choice" && q.choices?.length
          ? `\n  選択肢（この中から完全一致で選ぶ。判断できなければ空文字）: ${q.choices.join(" / ")}`
          : "";
        return `- questionId: ${q.id}\n  質問: ${q.label}${choices}`;
      })
      .join("\n");

    const EXTRACT_TOOL: Anthropic.Tool = {
      name: "submit_extracted_answers",
      description: "資料から読み取った各質問への答えを提出する",
      input_schema: {
        type: "object",
        properties: {
          answers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                questionId: {
                  type: "string",
                  enum: jirei.questions.map((q) => q.id),
                },
                value: {
                  type: "string",
                  description: "資料から読み取った答え。資料に書かれていなければ空文字",
                },
                source: {
                  type: "string",
                  description: "根拠にしたファイル名（value が空なら空文字）",
                },
              },
              required: ["questionId", "value", "source"],
            },
          },
        },
        required: ["answers"],
      },
    };

    blocks.push({
      type: "text",
      text: `あなたは司法書士事務所の補助者です。上記の案件資料を読み、以下の質問に答えられる箇所を探してください。

【質問一覧】
${questionList}

【厳守ルール】
- 資料に実際に書かれている値だけを抽出する。推測・補完・創作は禁止
- 資料に無い質問は value を空文字 "" にする（無理に埋めない）
- 値は資料の記載をそのまま使う（要約しない）。複数行の値（事業目的の一覧等）は 1 行 1 項目で全文
- 日付は質問の例示形式（例: 令和8年6月20日）があればそれに合わせて和暦で
- 全 questionId について 1 件ずつ回答すること`,
    });

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      temperature: 0,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: "submit_extracted_answers" },
      messages: [{ role: "user", content: blocks }],
    });
    logTokenUsage("api/jirei/extract-answers", MODEL, resp.usage);

    const toolBlock = resp.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> =>
        b.type === "tool_use" && b.name === "submit_extracted_answers"
    );
    const raw = (toolBlock?.input as { answers?: { questionId: string; value: string; source: string }[] })?.answers || [];

    const answers: Record<string, string> = {};
    const sources: Record<string, string> = {};
    const notFound: string[] = [];
    for (const q of jirei.questions) {
      const hit = raw.find((a) => a.questionId === q.id && (a.value || "").trim());
      if (hit) {
        answers[q.id] = hit.value.trim();
        if (hit.source) sources[q.id] = hit.source;
      } else {
        notFound.push(q.id);
      }
    }

    return NextResponse.json({ answers, sources, notFound, skipped });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "抽出に失敗しました" },
      { status: 500 }
    );
  }
}
