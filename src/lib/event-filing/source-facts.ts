// 原本直付け方式の中核。
//
// 「要約（基本情報）を信じて書類を作る」のではなく、案件の頭で取り寄せた
// 定款・登記情報そのものを AI が読み、木が必要とする構造化データを
// ★根拠の原文引用付き★で抽出する。抽出結果はファイル内容のハッシュで
// キャッシュされるので、同じ原本なら2回目以降は AI を呼ばない（0円・決定論）。
//
//   findSourceFiles      : 共通フォルダから requiredSources に合うファイルを探す
//   extractFactsFromSources : AI 抽出（キャッシュ付き）→ StructuredProfile 互換 + 根拠
//
// AI が働くのは「原本を読む」ここだけ。穴埋め・生成は従来どおり決定論。

import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { listFiles } from "@/lib/files";
import { parseBuffer, mimeFromExtension } from "@/lib/file-parsers";
import { logTokenUsage } from "@/lib/token-logger";
import type { Company, StructuredProfile } from "@/types";
import type { JireiSource } from "@/types/jirei";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";
const CACHE_DIR = path.join(process.cwd(), "data", "fact-cache");
const CACHE_VERSION = "v1"; // 抽出スキーマを変えたら上げる（旧キャッシュを無効化）

export interface SourceFileInput {
  name: string;
  buffer: Buffer;
}

export interface ExtractedFacts {
  structured: Partial<StructuredProfile> & Record<string, unknown>;
  evidence: Record<string, string>; // 項目 → 根拠（原文引用＋出典ファイル）
  sourceNames: string[];
  cached: boolean;
}

// ---------------------------------------------------------------
// 原本の発見（共通フォルダをファイル名パターンで検索。深さ2まで）
// ---------------------------------------------------------------
export async function findSourceFiles(
  company: Company,
  sources: JireiSource[]
): Promise<{ found: { source: JireiSource; name: string; path: string }[]; missing: JireiSource[] }> {
  // 検索対象: 共通ロールのサブフォルダ（無ければ会社フォルダ直下）
  const roots = company.subfolders.filter((s) => s.role === "common" && s.active !== false).map((s) => s.id);
  if (roots.length === 0) roots.push(company.id);

  const candidates: { name: string; path: string }[] = [];
  for (const root of roots) {
    const top = await listFiles(root);
    for (const f of top) {
      if (f.isDirectory) {
        const sub = await listFiles(f.path);
        for (const g of sub) {
          if (!g.isDirectory) candidates.push({ name: g.name, path: g.path });
        }
      } else {
        candidates.push({ name: f.name, path: f.path });
      }
    }
  }

  const found: { source: JireiSource; name: string; path: string }[] = [];
  const missing: JireiSource[] = [];
  for (const src of sources) {
    const hits = candidates.filter((c) => src.patterns.some((p) => c.name.includes(p)));
    if (hits.length > 0) {
      // 日付プレフィックス付きで世代が並ぶ運用（20251015_履歴事項…）なので、
      // 名前の降順 = 最新 を選ぶ
      const newest = [...hits].sort((a, b) => b.name.localeCompare(a.name, "ja"))[0];
      found.push({ source: src, name: newest.name, path: newest.path });
    } else {
      missing.push(src);
    }
  }
  return { found, missing };
}

// ---------------------------------------------------------------
// AI 抽出（キャッシュ付き）
// ---------------------------------------------------------------

// ※ tool スキーマのプロパティ名は ASCII 制約があるため英字キーで受け、
//   下の KEY_MAP で日本語キー（StructuredProfile 互換）に変換する。
const EXTRACT_TOOL: Anthropic.Tool = {
  name: "submit_company_facts",
  description: "原本（定款・登記情報・株主名簿）から読み取った会社の構造化データを提出する",
  input_schema: {
    type: "object",
    properties: {
      shogo: { type: "string", description: "商号" },
      honten: { type: "string", description: "本店所在地" },
      hojin_bango: { type: "string", description: "会社法人等番号" },
      shihonkin: { type: "string", description: "資本金" },
      hakko_kano: { type: "string", description: "発行可能株式総数" },
      hakko_zumi: { type: "string", description: "発行済株式総数" },
      mokuteki: { type: "array", items: { type: "string" }, description: "事業目的（記載どおり全項目）" },
      kokoku: { type: "string", description: "公告方法" },
      board: { type: "string", enum: ["設置", "非設置"], description: "取締役会の設置有無" },
      rep_election: {
        type: "string",
        enum: ["株主総会", "取締役の互選", "取締役会"],
        description: "代表取締役の選定機関。定款の定めから判断。判断できなければ省略",
      },
      officers: {
        type: "array",
        description: "役員",
        items: {
          type: "object",
          properties: {
            role: { type: "string", description: "役職" },
            name: { type: "string", description: "氏名" },
            address: { type: "string", description: "住所" },
            appointed: { type: "string", description: "就任日" },
          },
          required: ["role", "name"],
        },
      },
      shareholders: {
        type: "array",
        description: "株主（名簿の全員）",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "氏名または名称" },
            address: { type: "string", description: "住所" },
            shares: { type: "string", description: "持株数" },
            ratio: { type: "string", description: "持株比率" },
          },
          required: ["name"],
        },
      },
      evidence: {
        type: "array",
        description: "解釈を含む項目（取締役会設置・選定機関など）の根拠。原文をそのまま引用し出典ファイル名を添える",
        items: {
          type: "object",
          properties: {
            item: { type: "string", description: "項目名（日本語。例: 代表取締役の選定機関）" },
            quote: { type: "string", description: "定款・登記の該当箇所をそのまま引用" },
            source: { type: "string", description: "出典ファイル名" },
          },
          required: ["item", "quote", "source"],
        },
      },
      missing: { type: "array", items: { type: "string" }, description: "読み取れなかった項目（日本語）" },
    },
    required: ["shogo"],
  },
};

// 英字キー → 日本語キー（StructuredProfile 互換）変換
function toStructured(input: Record<string, unknown>): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  const set = (jp: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") s[jp] = v;
  };
  set("商号", input.shogo);
  set("本店所在地", input.honten);
  set("会社法人等番号", input.hojin_bango);
  set("資本金", input.shihonkin);
  set("発行可能株式総数", input.hakko_kano);
  set("発行済株式総数", input.hakko_zumi);
  set("事業目的", input.mokuteki);
  set("公告方法", input.kokoku);
  set("取締役会設置", input.board);
  set("代表取締役の選定機関", input.rep_election);
  if (Array.isArray(input.officers)) {
    set(
      "役員",
      (input.officers as { role?: string; name?: string; address?: string; appointed?: string }[]).map((o) => ({
        役職: o.role || "",
        氏名: o.name || "",
        住所: o.address || "",
        就任日: o.appointed || "",
      }))
    );
  }
  if (Array.isArray(input.shareholders)) {
    set(
      "株主",
      (input.shareholders as { name?: string; address?: string; shares?: string; ratio?: string }[]).map((x) => ({
        氏名: x.name || "",
        住所: x.address || "",
        持株数: x.shares || "",
        持株比率: x.ratio || "",
      }))
    );
  }
  return s;
}

function cacheKey(files: SourceFileInput[]): string {
  const h = crypto.createHash("sha1");
  h.update(CACHE_VERSION);
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(f.name);
    h.update(crypto.createHash("sha1").update(f.buffer).digest("hex"));
  }
  return h.digest("hex");
}

export async function extractFactsFromSources(files: SourceFileInput[]): Promise<ExtractedFacts> {
  const key = cacheKey(files);
  const cachePath = path.join(CACHE_DIR, `${key}.json`);
  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    const cached = JSON.parse(raw);
    return { ...cached, cached: true };
  } catch {
    /* キャッシュなし → 抽出 */
  }

  // 原本を Claude に渡せる形へ（テキスト抽出 or 画像/スキャンPDFブロック）
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const f of files) {
    const parsed = await parseBuffer(f.buffer, f.name, f.name, mimeFromExtension(path.extname(f.name)));
    if (!parsed) continue;
    if (parsed.base64 && parsed.mimeType?.startsWith("image/")) {
      blocks.push({ type: "text", text: `【原本: ${f.name}（画像）】` });
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: parsed.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: parsed.base64,
        },
      });
    } else if (parsed.base64 && parsed.mimeType === "application/pdf") {
      blocks.push({ type: "text", text: `【原本: ${f.name}（スキャンPDF）】` });
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: parsed.base64 },
      });
    } else {
      blocks.push({ type: "text", text: `【原本: ${f.name}】\n${parsed.content}` });
    }
  }

  blocks.push({
    type: "text",
    text: `あなたは司法書士事務所の補助者です。上記の原本（定款・登記情報・株主名簿など）から、会社の構造化データを抽出してください。

【厳守ルール】
- 原本に書かれている値だけを抽出する。推測・補完は禁止。無い項目は省略し「読み取れなかった項目」に挙げる
- 値は原本の記載をそのまま（要約・言い換えをしない）。住所・氏名は一字一句正確に
- 解釈を含む項目（取締役会設置・代表取締役の選定機関）は、必ず「根拠」に定款の該当条文をそのまま引用し、出典ファイル名を添える
- 株主は名簿の全員。持株数は数値の記載どおり
- 事業目的は定款・登記の記載どおり全項目`,
  });

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    temperature: 0,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "submit_company_facts" },
    messages: [{ role: "user", content: blocks }],
  });
  logTokenUsage("api/jirei (原本直読み抽出)", MODEL, resp.usage);

  const block = resp.content.find(
    (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use" && b.name === "submit_company_facts"
  );
  if (!block) throw new Error("原本の読み取りに失敗しました（AI 応答を解釈できません）");

  const input = block.input as Record<string, unknown> & {
    evidence?: { item: string; quote: string; source: string }[];
  };
  const evidence: Record<string, string> = {};
  for (const e of input.evidence || []) {
    evidence[e.item] = `${e.quote}（${e.source}）`;
  }

  const result = {
    structured: toStructured(input) as ExtractedFacts["structured"],
    evidence,
    sourceNames: files.map((f) => f.name),
  };
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(result, null, 2), "utf-8");
  return { ...result, cached: false };
}
