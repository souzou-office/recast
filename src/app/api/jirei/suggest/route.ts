// 資料先行フローの入口: 事由の推定 + 資料の種別分類。
//
//   POST /api/jirei/suggest … { files: [{ name, base64 }] }
//     → { candidates, fileKinds, shogo, companyMatch, cached }
//
// AI 境界①「資料から読む」の拡張（読む対象が「値」から「事由」に広がったもの）。
// AI の仕事は「登録済みのどの事由に当たるか」という選択肢有限の分類問題に縛られる
// （extract-answers の questionId enum 縛りと同じ設計パターン）。
// 該当なしを構造的に言える（candidates は空配列可）。提案はすべて人が確定してから進む。
//
// 同時に各資料の種別（登記情報/定款/株主名簿/案件連絡/その他）も分類する。
// 客由来のファイル名（scan001.pdf 等）はパターン照合が効かないため、
// requiredSources への充当はこの中身ベースの分類を正とする。
//
// 資料一式の内容ハッシュでキャッシュ（同じ資料なら同じ提案・AI ゼロ・決定論）。

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { listJirei } from "@/lib/jirei/loader";
import { parseBuffer, mimeFromExtension, MAX_BINARY_SIZE } from "@/lib/file-parsers";
import { logTokenUsage } from "@/lib/token-logger";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";
const CACHE_DIR = path.join(process.cwd(), "data", "suggest-cache");
const CACHE_VERSION = "v1";
const MAX_TEXT_PER_FILE = 3500; // 分類には各資料の先頭で足りる（全文は fact 抽出が別途読む）

interface DroppedFile {
  name: string;
  base64: string;
}

interface SuggestOutput {
  candidates: {
    jireiId: string;
    name: string;
    description: string;
    reason: string;
    quote: string;
    caution: string;
    guards: string[];
    requiredSources: { key: string; label: string; optional?: boolean }[];
  }[];
  fileKinds: Record<string, string>; // ファイル名 → kind
  kindLabels: Record<string, string>; // kind → 表示名
  shogo: string;
  unreadable: string[];
}

function normalizeCompanyName(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人/g, "")
    .replace(/[\s　・.．,、_\-（）()「」]/g, "")
    .toLowerCase();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const files: DroppedFile[] = (Array.isArray(body.files) ? body.files : []).filter(
      (f: DroppedFile) => f?.name && f?.base64
    );
    if (files.length === 0) return NextResponse.json({ error: "files は必須です" }, { status: 400 });

    // --- 登録済み事由のカタログ（分類の選択肢はこれで縛る） ---
    const all = await listJirei();
    if (all.length === 0) return NextResponse.json({ error: "事由が登録されていません" }, { status: 400 });

    // 資料種別 = 全木の requiredSources キーの合併 + 案件連絡 + その他（登記固有ではなく木由来）
    const kindLabels: Record<string, string> = {};
    for (const j of all) {
      for (const src of j.requiredSources || []) {
        if (!kindLabels[src.key]) kindLabels[src.key] = src.label;
      }
    }
    kindLabels["renraku"] = "案件連絡（依頼の意図が書かれたメール・電話メモ・依頼書）";
    kindLabels["sonota"] = "その他（上のどれでもない資料）";
    const kindKeys = Object.keys(kindLabels);

    // --- キャッシュ（資料一式 + 事由カタログのハッシュ） ---
    const catalogSig = all.map((j) => `${j.id}:${j.name}:${j.description || ""}`).join("|");
    const fileSigs = files
      .map((f) => `${f.name}:${crypto.createHash("sha1").update(f.base64).digest("hex")}`)
      .sort();
    const cacheKey = crypto
      .createHash("sha1")
      .update(`${CACHE_VERSION}\n${catalogSig}\n${fileSigs.join("\n")}`)
      .digest("hex");
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    let output: SuggestOutput | null = null;
    try {
      output = JSON.parse(await fs.readFile(cachePath, "utf-8")) as SuggestOutput;
    } catch {
      /* キャッシュ無し */
    }

    if (!output) {
      // --- 資料を Claude に渡せる形に（テキストは先頭だけ。画像/スキャンPDF はそのまま） ---
      const blocks: Anthropic.ContentBlockParam[] = [];
      const unreadable: string[] = [];
      for (const f of files) {
        const buf = Buffer.from(f.base64, "base64");
        if (buf.length > MAX_BINARY_SIZE) {
          unreadable.push(`${f.name}（サイズ超過）`);
          continue;
        }
        const parsed = await parseBuffer(buf, f.name, f.name, mimeFromExtension(path.extname(f.name)));
        if (!parsed) {
          unreadable.push(`${f.name}（非対応の形式）`);
          continue;
        }
        if (parsed.base64 && parsed.mimeType?.startsWith("image/")) {
          blocks.push({ type: "text", text: `【資料: ${f.name}（画像）】` });
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: parsed.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: parsed.base64,
            },
          });
        } else if (parsed.base64 && parsed.mimeType === "application/pdf") {
          blocks.push({ type: "text", text: `【資料: ${f.name}（スキャンPDF）】` });
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: parsed.base64 },
          });
        } else {
          const head = (parsed.content || "").slice(0, MAX_TEXT_PER_FILE);
          blocks.push({ type: "text", text: `【資料: ${f.name}】\n${head}` });
        }
      }
      if (blocks.length === 0) {
        return NextResponse.json(
          { error: `読み取れる資料がありません（${unreadable.join("、")}）` },
          { status: 400 }
        );
      }

      const jireiCatalog = all
        .map((j) => `- id: ${j.id}\n  名前: ${j.name}\n  説明（前提を含む）: ${j.description || "（説明なし）"}`)
        .join("\n");
      const kindCatalog = kindKeys.map((k) => `- ${k}: ${kindLabels[k]}`).join("\n");
      const readableNames = files.filter((f) => !unreadable.some((u) => u.startsWith(f.name))).map((f) => f.name);

      const SUGGEST_TOOL: Anthropic.Tool = {
        name: "submit_jirei_suggestion",
        description: "案件資料から読み取った事由の候補と資料の種別分類を提出する",
        input_schema: {
          type: "object",
          properties: {
            candidates: {
              type: "array",
              description: "この案件に当たる事由の候補。複数可。どれにも当たらなければ空配列",
              items: {
                type: "object",
                properties: {
                  jireiId: { type: "string", enum: all.map((j) => j.id) },
                  reason: { type: "string", description: "なぜこの事由と読めるか（1〜2文）" },
                  quote: {
                    type: "string",
                    description: "根拠となる資料の記述をそのまま引用（出典ファイル名を先頭に）",
                  },
                  caution: {
                    type: "string",
                    description: "この事由の前提（説明文）と食い違うかもしれない点。無ければ空文字",
                  },
                },
                required: ["jireiId", "reason", "quote", "caution"],
              },
            },
            fileKinds: {
              type: "array",
              description: "各資料の種別分類（全資料について1件ずつ）",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", enum: readableNames.length > 0 ? readableNames : ["-"] },
                  kind: { type: "string", enum: kindKeys },
                },
                required: ["name", "kind"],
              },
            },
            shogo: { type: "string", description: "資料から読み取れた対象会社の商号。分からなければ空文字" },
          },
          required: ["candidates", "fileKinds", "shogo"],
        },
      };

      blocks.push({
        type: "text",
        text: `あなたは司法書士事務所の受付担当です。上記の案件資料を読み、次の3つを判定してください。

【登録済みの事由（candidates の選択肢はこれだけ）】
${jireiCatalog}

【資料の種別（fileKinds の kind）】
${kindCatalog}

【厳守ルール】
- 事由は「これから行う変更」。依頼の意思表示（メール・電話メモ＝案件連絡）を主根拠にすること。
  登記情報・定款は会社の★現状★であり、そこに載っている過去の変更履歴を今回の依頼と誤読しないこと。
  案件連絡が無く原本だけの場合、原則として candidates は空配列（現状からは依頼は分からない）
- ★近い事由に寄せない★。説明文の前提に合わなければ候補にしない。どれにも当たらなければ空配列で返す
- 複数の変更が依頼されていれば候補を複数返す（例: 役員変更と本店移転が同時）
- quote は資料の実際の記述をそのまま引用する（創作しない）
- 全資料について fileKinds を1件ずつ返す`,
      });

      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        temperature: 0,
        tools: [SUGGEST_TOOL],
        tool_choice: { type: "tool", name: "submit_jirei_suggestion" },
        messages: [{ role: "user", content: blocks }],
      });
      logTokenUsage("api/jirei/suggest", MODEL, resp.usage);

      const toolBlock = resp.content.find(
        (b): b is Extract<typeof b, { type: "tool_use" }> =>
          b.type === "tool_use" && b.name === "submit_jirei_suggestion"
      );
      const raw = (toolBlock?.input || {}) as {
        candidates?: { jireiId: string; reason: string; quote: string; caution: string }[];
        fileKinds?: { name: string; kind: string }[];
        shogo?: string;
      };

      const fileKinds: Record<string, string> = {};
      for (const fk of raw.fileKinds || []) {
        if (fk?.name && fk?.kind && kindKeys.includes(fk.kind)) fileKinds[fk.name] = fk.kind;
      }

      // 候補に木の前提情報（説明・無条件ガード・必要原本）を添える — 確定前に人が読む
      const seen = new Set<string>();
      const candidates: SuggestOutput["candidates"] = [];
      for (const c of raw.candidates || []) {
        const j = all.find((x) => x.id === c.jireiId);
        if (!j || seen.has(j.id)) continue;
        seen.add(j.id);
        candidates.push({
          jireiId: j.id,
          name: j.name,
          description: j.description || "",
          reason: c.reason || "",
          quote: c.quote || "",
          caution: c.caution || "",
          guards: (j.guards || []).filter((g) => !g.when).map((g) => g.message),
          requiredSources: (j.requiredSources || []).map((s) => ({
            key: s.key,
            label: s.label,
            optional: s.optional,
          })),
        });
      }

      output = { candidates, fileKinds, kindLabels, shogo: (raw.shogo || "").trim(), unreadable };
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(output), "utf-8");
    }

    // --- 会社の紐付け提案（商号の正規化照合。確定は人） ---
    let companyMatch: { id: string; name: string } | null = null;
    if (output.shogo) {
      const target = normalizeCompanyName(output.shogo);
      if (target) {
        const config = await getWorkspaceConfig();
        for (const c of config.companies) {
          const names = [c.name];
          const profShogo = (c.profile?.structured as Record<string, unknown> | undefined)?.["商号"];
          if (typeof profShogo === "string") names.push(profShogo);
          const hit = names.some((n) => {
            const nn = normalizeCompanyName(n);
            return nn && (nn.includes(target) || target.includes(nn));
          });
          if (hit) {
            companyMatch = { id: c.id, name: c.name };
            break;
          }
        }
      }
    }

    return NextResponse.json({ ...output, companyMatch });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "事由の推定に失敗しました" },
      { status: 500 }
    );
  }
}
