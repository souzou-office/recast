// 生成書類の AI チェック（原本突合せ）。
//
//   POST /api/jirei/verify … { companyId, jireiId, documents: [{fileName, base64}], sources?: [{name, base64}] }
//     → { issues: [{document, location, problem, correct, severity}], ok }
//
// できあがった書類一式を、AI が★原本（定款・登記情報・株主名簿）を直接読んで★照合する。
// 中間層（抽出結果）に誤りがあっても、原本 vs 最終成果物の間の矛盾として検出される
// = 要約を信頼の根っこにしない、の実装。AI は指摘だけして書類は書き換えない。

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { loadJirei } from "@/lib/jirei/loader";
import { findSourceFiles, SourceFileInput } from "@/lib/event-filing/source-facts";
import { parseBuffer, mimeFromExtension } from "@/lib/file-parsers";
import { logTokenUsage } from "@/lib/token-logger";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

const VERIFY_TOOL: Anthropic.Tool = {
  name: "submit_check_result",
  description: "生成書類と原本の突合せ結果を提出する",
  input_schema: {
    type: "object",
    properties: {
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            document: { type: "string", description: "問題のある書類のファイル名" },
            location: { type: "string", description: "書類内のどこか（例: 出席状況の議決権数）" },
            problem: { type: "string", description: "何が問題か" },
            correct: { type: "string", description: "原本に基づく正しい値・記載（分かる場合）" },
            severity: { type: "string", enum: ["高", "中", "低"] },
          },
          required: ["document", "location", "problem", "severity"],
        },
      },
    },
    required: ["issues"],
  },
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const companyId: string | undefined = body.companyId;
    const jireiId: string | undefined = body.jireiId;
    const documents: { fileName: string; base64: string }[] = body.documents || [];
    // 依頼内容（案件連絡: メール・電話メモ）。あれば「事由レベルの当否」も観点に加える。
    // 誤分類は下流の書類が綺麗に出てしまい原本突合せでは捕まらないため、ここが最後の網。
    const intent: { name: string; base64: string }[] = (body.intent || []).filter(
      (s: { name?: string; base64?: string }) => s?.name && s?.base64
    );
    if (!jireiId) return NextResponse.json({ error: "jireiId は必須です" }, { status: 400 });
    if (documents.length === 0) return NextResponse.json({ error: "documents は必須です" }, { status: 400 });

    // 会社レス運用対応: 会社未選択でも、ドロップされた原本があれば突合せできる
    const config = await getWorkspaceConfig();
    const company = companyId ? config.companies.find((c) => c.id === companyId) : null;
    if (companyId && !company) return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
    const jirei = await loadJirei(jireiId);
    if (!jirei) return NextResponse.json({ error: "事由が見つかりません" }, { status: 404 });

    // --- 原本を集める（生成時と同じ解決: ドロップ優先 + 共通フォルダ自動発見） ---
    const dropped: SourceFileInput[] = (body.sources || [])
      .filter((s: { name?: string; base64?: string }) => s?.name && s?.base64)
      .map((s: { name: string; base64: string }) => ({ name: s.name, buffer: Buffer.from(s.base64, "base64") }));
    const sources: SourceFileInput[] = [...dropped];
    if (company && jirei.requiredSources && jirei.requiredSources.length > 0) {
      const { found } = await findSourceFiles(company, jirei.requiredSources);
      for (const f of found) {
        if (sources.some((x) => x.name === f.name)) continue;
        sources.push({ name: f.name, buffer: await fs.readFile(f.path) });
      }
    }
    if (sources.length === 0) {
      return NextResponse.json({ error: "突合せに使う原本が見つかりません" }, { status: 400 });
    }

    // --- Claude へ渡すブロックを組む ---
    const blocks: Anthropic.ContentBlockParam[] = [];
    blocks.push({ type: "text", text: "■ 原本（信頼の根っこ。この内容が正）" });
    for (const s of sources) {
      const parsed = await parseBuffer(s.buffer, s.name, s.name, mimeFromExtension(path.extname(s.name)));
      if (!parsed) continue;
      if (parsed.base64 && parsed.mimeType?.startsWith("image/")) {
        blocks.push({ type: "text", text: `【原本: ${s.name}（画像）】` });
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: parsed.base64,
          },
        });
      } else if (parsed.base64 && parsed.mimeType === "application/pdf") {
        blocks.push({ type: "text", text: `【原本: ${s.name}（スキャンPDF）】` });
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: parsed.base64 } });
      } else {
        blocks.push({ type: "text", text: `【原本: ${s.name}】\n${parsed.content}` });
      }
    }

    // 依頼内容（あれば）— 生成一式が「頼まれたこと」と合っているかの照合材料
    if (intent.length > 0) {
      blocks.push({ type: "text", text: "■ 依頼内容（この案件で何を頼まれたか。メール・電話メモ）" });
      for (const s of intent) {
        const buf = Buffer.from(s.base64, "base64");
        const parsed = await parseBuffer(buf, s.name, s.name, mimeFromExtension(path.extname(s.name)));
        if (parsed?.content) {
          blocks.push({ type: "text", text: `【依頼: ${s.name}】\n${parsed.content}` });
        }
      }
    }

    blocks.push({ type: "text", text: "■ 生成された書類（チェック対象）" });
    for (const d of documents) {
      const buf = Buffer.from(d.base64, "base64");
      const parsed = await parseBuffer(buf, d.fileName, d.fileName, mimeFromExtension(path.extname(d.fileName)));
      blocks.push({
        type: "text",
        text: `【生成書類: ${d.fileName}】\n${parsed?.content || "(読めませんでした)"}`,
      });
    }

    // 事務所の統一ルール（あれば観点に加える）
    try {
      const rules = await fs.readFile(path.join(process.cwd(), "data", "jirei", "office-rules.txt"), "utf-8");
      blocks.push({ type: "text", text: `■ 事務所の統一ルール（書式の決まり。これに反する記載も指摘対象）\n${rules}` });
    } catch {
      /* 無ければスキップ */
    }

    blocks.push({
      type: "text",
      text: `あなたは司法書士事務所のベテラン校正者です。生成された書類を、原本と突き合わせてチェックしてください。

【チェック観点】
- 原本との不一致: 会社名・本店・氏名・住所・株式数・議決権数・目的の文言が原本と一字一句合っているか
- 書類間の不整合: 同じ値（日付・氏名・数値）が書類によって食い違っていないか
- 日付の前後関係: 決定日 ≦ 提案日 ≦ 同意日 ≦ みなし決議日 ≦ 申請日 のような順序が破綻していないか
- 明らかな置換漏れ: 【…】やテンプレの文言がそのまま残っていないか${intent.length > 0 ? `
- 依頼内容との整合（事由の当否）: 生成一式が依頼内容と合っているか。頼まれた変更が漏れていないか・依頼に無い変更が入っていないか・人物や役職の取り違えがないか` : ""}

【指摘しないこと】
- 文体・体裁の好み
- 原本の発行日の違いにより、どちらも正しい可能性がある差（例: 移転前後の住所の使い分け）
- Excel の数式セルのキャッシュ値（開けば再計算される）

問題が無ければ issues は空配列。指摘は必ず根拠（原本のどの記載と食い違うか）が説明できるものだけ。`,
    });

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      temperature: 0,
      tools: [VERIFY_TOOL],
      tool_choice: { type: "tool", name: "submit_check_result" },
      messages: [{ role: "user", content: blocks }],
    });
    logTokenUsage("api/jirei/verify", MODEL, resp.usage);

    const block = resp.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use" && b.name === "submit_check_result"
    );
    const issues = (block?.input as { issues?: unknown[] })?.issues || [];
    return NextResponse.json({ issues, ok: issues.length === 0, sources: sources.map((s) => s.name) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "チェックに失敗しました" },
      { status: 500 }
    );
  }
}
