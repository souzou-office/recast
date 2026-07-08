// 事由コンパイラ。テンプレフォルダ（実物 docx + メモ）を AI が読んで、
// 「木（jirei JSON）」と「実テンプレの値→【…】化 ops」を生成する。
//
//   GET  /api/jirei/compile            … 事由化できるテンプレフォルダの一覧
//   POST /api/jirei/compile            … { folder, instruction? }
//     1. フォルダ内の docx/txt を読んでテキスト化（メモ・統一ルールも）
//     2. AI が木 + ops を提案（tool use 強制・temperature 0）
//     3. ops を applyTemplateOps で機械適用 → data/jirei-templates/ に書き出し
//     4. 木を data/jirei/<id>.json に保存
//     5. 置換 0 件の op などの警告を返す
//
// ★AI が働くのはこの「事由を覚える瞬間」1回だけ。以後の案件処理は決定論のまま。★
// 生成された木は人がレビュー・修正できる（JSON とテンプレの形で固定される）。

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { parseBuffer, mimeFromExtension } from "@/lib/file-parsers";
import { applyTemplateOps, TemplateOp } from "@/lib/event-filing/template-ops";
import { logTokenUsage } from "@/lib/token-logger";
import type { Jirei } from "@/types/jirei";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";
const JIREI_DIR = path.join(process.cwd(), "data", "jirei");
const TEMPLATE_DIR = path.join(process.cwd(), "data", "jirei-templates");

// 事実キーの一覧（プロンプトに渡す。facts.ts の profileToFacts / factList と一致させる）
const FACT_KEYS = `
単一の事実 (slots の { "type": "fact", "key": ... } で使える):
  会社名 / 本店所在地 / 会社法人等番号 / 発行済株式総数 / 資本金 / 現在の事業目的 / 代表取締役氏名
  取締役総数 / 出席取締役数 / 取締役総数（全角） / 出席取締役数（全角）
  株主総数 / 議決権株主数 / 議決権株主数（全角） / 総議決権数 / 総議決権数（全角）
  株主株式数合計 / 株主議決権数合計 / 株主議決権割合合計
一覧の事実 (documents の repeatOverFactList で使える):
  株主 … 各要素のフィールド: 氏名 / 住所 / 株式数 / 議決権数 / 議決権数全角 / 議決権割合 / 種別（"個人"|"法人" 自動判定）
  役員 … 各要素のフィールド: 役職 / 氏名 / 住所 / 就任日`;

async function templateBase(): Promise<string | null> {
  const config = await getWorkspaceConfig();
  return config.templateBasePath || null;
}

export async function GET() {
  const base = await templateBase();
  if (!base) return NextResponse.json({ folders: [] });
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    const folders = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const files = await fs.readdir(path.join(base, e.name));
      const docs = files.filter((f) => /\.(docx|xlsx|txt)$/i.test(f) && !f.includes(".labels."));
      folders.push({ name: e.name, fileCount: docs.length });
    }
    return NextResponse.json({ folders });
  } catch {
    return NextResponse.json({ folders: [] });
  }
}

const COMPILE_TOOL: Anthropic.Tool = {
  name: "submit_jirei",
  description: "テンプレフォルダから読み取った事由の定義（木）とテンプレ変換 ops を提出する",
  input_schema: {
    type: "object",
    properties: {
      jirei: {
        type: "object",
        description: "事由の木。data/jirei/<id>.json にそのまま保存される",
        properties: {
          id: { type: "string", description: "kebab-case の事由ID (例: daihyo-henkou)" },
          name: { type: "string", description: "事由名 (例: 代表取締役の変更)" },
          description: { type: "string" },
          requiredSources: {
            type: "array",
            description: "この事由の fact を読むのに必要な原本。通常は 登記情報・定款・株主名簿",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                label: { type: "string" },
                patterns: { type: "array", items: { type: "string" }, description: "ファイル名に含まれる文字列" },
                optional: { type: "boolean" },
              },
              required: ["key", "label", "patterns"],
            },
          },
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                kind: { type: "string", enum: ["text", "date", "choice"] },
                choices: { type: "array", items: { type: "string" } },
                when: {
                  type: "object",
                  properties: {
                    questionId: { type: "string" },
                    anyOf: { type: "array", items: { type: "string" } },
                  },
                  required: ["questionId", "anyOf"],
                },
              },
              required: ["id", "label"],
            },
          },
          documents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                templateFile: { type: "string", description: "出力テンプレ名 (templateOps の out と一致させる)" },
                kind: { type: "string", enum: ["docx", "xlsx"] },
                repeatOverFactList: { type: "string", description: "1件=1ファイルで展開する一覧名 (例: 株主)" },
                itemFilter: {
                  type: "object",
                  description: "一覧の絞り込み。個人用/法人用テンプレの出し分けは field: 種別, anyOf: [個人] / [法人]",
                  properties: {
                    field: { type: "string" },
                    anyOf: { type: "array", items: { type: "string" } },
                  },
                  required: ["field", "anyOf"],
                },
                placeholders: {
                  type: "object",
                  description: "【文言】→ スロット名 or 一覧フィールド名。【文言】がスロット名そのものなら不要",
                  additionalProperties: { type: "string" },
                },
                rowSlots: { type: "object", additionalProperties: { type: "string" } },
                when: {
                  type: "object",
                  properties: {
                    questionId: { type: "string" },
                    anyOf: { type: "array", items: { type: "string" } },
                  },
                  required: ["questionId", "anyOf"],
                },
              },
              required: ["templateFile", "kind"],
            },
          },
          slots: {
            type: "object",
            description: "スロット名 → 値の出所。{type:'fact',key} | {type:'answer',questionId} | {type:'const',value}。when も付けられる",
            additionalProperties: { type: "object" },
          },
          guards: {
            type: "array",
            description: "分岐に応じてユーザーへ出す注意書き（雛形未登録の枝、法定の確認事項など）",
            items: {
              type: "object",
              properties: {
                when: {
                  type: "object",
                  properties: {
                    questionId: { type: "string" },
                    anyOf: { type: "array", items: { type: "string" } },
                  },
                  required: ["questionId", "anyOf"],
                },
                message: { type: "string" },
              },
              required: ["message"],
            },
          },
        },
        required: ["id", "name", "questions", "documents", "slots"],
      },
      templateOps: {
        type: "array",
        description: "実テンプレの値→【…】化。docx ごとに 1 エントリ",
        items: {
          type: "object",
          properties: {
            srcFile: { type: "string", description: "フォルダ内の元ファイル名（そのまま）" },
            outFile: { type: "string", description: "出力テンプレ名 (documents の templateFile と一致)" },
            ops: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  find: { type: "string", description: "テンプレ内の実値。提示テキストから一字一句そのままコピー" },
                  replace: { type: "string", description: "【スロット名】。削除は空文字" },
                  all: { type: "boolean" },
                  anchor: { type: "string", description: "同じ値が複数の意味で出るとき、対象段落を特定する文言" },
                },
                required: ["find", "replace"],
              },
            },
          },
          required: ["srcFile", "outFile", "ops"],
        },
      },
      warnings: {
        type: "array",
        items: { type: "string" },
        description: "人が確認すべきこと（対応できなかった書類・前提・割り切り）",
      },
    },
    required: ["jirei", "templateOps", "warnings"],
  },
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const folder: string | undefined = body.folder;
    const instruction: string = body.instruction || "";
    if (!folder) return NextResponse.json({ error: "folder は必須です" }, { status: 400 });

    const base = await templateBase();
    if (!base) return NextResponse.json({ error: "テンプレートフォルダが未設定です" }, { status: 400 });
    const dir = path.join(base, folder);

    // --- フォルダ内のファイルをテキスト化 ---
    const files = await fs.readdir(dir);
    const docxFiles: string[] = [];
    const sections: string[] = [];
    for (const f of files.sort()) {
      if (f.includes(".labels.")) continue;
      const full = path.join(dir, f);
      if (/\.txt$/i.test(f)) {
        sections.push(`【メモ: ${f}】\n${await fs.readFile(full, "utf-8")}`);
      } else if (/\.docx$/i.test(f)) {
        docxFiles.push(f);
        const buf = await fs.readFile(full);
        const parsed = await parseBuffer(buf, f, full, mimeFromExtension(".docx"));
        sections.push(`【テンプレ(docx): ${f}】\n${parsed?.content || "(読めませんでした)"}`);
      } else if (/\.xlsx$/i.test(f)) {
        const buf = await fs.readFile(full);
        const parsed = await parseBuffer(buf, f, full, mimeFromExtension(".xlsx"));
        sections.push(`【テンプレ(xlsx): ${f}】※xlsx の自動変換は未対応。株主リストなら既製の 株主リスト.xlsx を documents に使うこと\n${(parsed?.content || "").slice(0, 1500)}`);
      }
    }
    if (docxFiles.length === 0) {
      return NextResponse.json({ error: "フォルダに docx がありません" }, { status: 400 });
    }

    // 事務所の統一ルール（正はアプリ内 data/jirei/office-rules.txt。無ければ H: の共通ルールを fallback）
    try {
      const rules = await fs.readFile(path.join(process.cwd(), "data", "jirei", "office-rules.txt"), "utf-8");
      sections.push(`【事務所の統一ルール】\n${rules}`);
    } catch {
      try {
        const rules = await fs.readFile(path.join(base, "共通ルール", "統一ルール.txt"), "utf-8");
        sections.push(`【事務所の統一ルール】\n${rules}`);
      } catch {
        /* 無ければスキップ */
      }
    }

    // 既存の木を few-shot として1つ添付（形式の実例）
    let example = "";
    try {
      example = await fs.readFile(path.join(JIREI_DIR, "honten-iten.json"), "utf-8");
    } catch {
      /* ignore */
    }

    const prompt = `あなたは司法書士事務所の書類テンプレートを recast の「事由（木）」に変換する専門家です。

上記はテンプレフォルダ「${folder}」の中身です。テンプレには前案件の実際の値（会社名・氏名・日付・住所・数値）がそのまま入っています。

やること:
1. 各テンプレのどの文字列が「案件ごとに変わる値」かを判断し、templateOps で 【スロット名】 に置き換える指示を出す
2. 各値の出所を決める: 会社の登記情報にあるもの = fact / 案件ごとに人に聞くもの = answer（questions に追加）/ 毎回同じ固定文 = テンプレに残す
3. 事由の木 (jirei) を組み立てる

利用できる事実キー:
${FACT_KEYS}

守ること:
- ops の find は提示テキストから一字一句そのままコピー（1つの段落＝1行の中に収まる連続文字列で。行をまたぐ場合は行ごとに分ける）
- 同じ文字列が複数意味で出る場合は anchor に「その値の近くにある固定文言」を指定（同じ段落でなくても前後の段落でよい）。同じ意味で複数回出る場合は all: true
- 建物名など値の2行目は、1行目の【スロット】に改行込みで入れる前提で、2行目の実値は空文字置換（削除）にする
- 数値は統一ルールに従い docx は全角カンマ（例: fact の 総議決権数（全角） や 株主一覧の 議決権数全角 を使う）
- 「株主ごとに1枚」の書類（提案書兼同意書など）は repeatOverFactList: "株主" とし、per-item の穴は placeholders で 【株主氏名】→氏名 のように一覧フィールドへマップする
- 提案書兼同意書に「個人用」「法人用」の2テンプレがある場合は両方 documents に登録し、
  itemFilter: { field: "種別", anyOf: ["個人"] } / ["法人"] で出し分ける（法人用の穴は 本店→住所, 商号→氏名 にマップ。代表取締役名は一覧に無いため 【…】のまま残してよい旨を warnings に書く）
- 管轄法務局・登記申請日のような「書類に現れない値」「導出できる値」は質問にしない。
  委任状の日付は案件の基準日（総会日・効力発生日など）のスロットを充てる
- ★テンプレ一式が暗黙に前提している手続き方式（例: 書面決議 vs 株主総会の実開催）を見抜き、
  最初の choice 質問として顕在化させること★。一式が属する方式の書類・質問・スロットに when を付け、
  雛形が無い方の枝には guards（{ when, message } の配列。jirei 直下）で
  「〜用の雛形が未登録」と明示する。前提を無言で質問に焼き込んではならない
- 委任状の代理人（事務所の住所・氏名）は固定文なので触らない
- 日付は questions で聞く（例示形式「令和8年6月20日」を label に入れる）
- questions の id は snake_case、jirei.id は kebab-case
- requiredSources には fact の読み取りに必要な原本を宣言する。標準は
  登記情報 { key: "touki", patterns: ["履歴", "現在事項", "登記情報", "登記簿"] } /
  定款 { key: "teikan", patterns: ["定款"] } / 株主名簿 { key: "kabunushi", patterns: ["株主名簿"] }。
  株主の値を使わない事由なら株主名簿は不要
- 出力テンプレ名 (outFile) は「元の書類名_${folder.replace(/[（(].*$/, "")}.docx」風の短い名前（数字プレフィックスは外す）
- 対応できない書類・不確かな前提は warnings に日本語で書く（無理に対応しない）

${instruction ? `ユーザーからの追加指示:\n${instruction}\n` : ""}
${example ? `参考: 既存の事由 JSON の実例（本店移転）:\n${example}` : ""}`;

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 16384,
      temperature: 0,
      tools: [COMPILE_TOOL],
      tool_choice: { type: "tool", name: "submit_jirei" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: sections.join("\n\n---\n\n") },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
    logTokenUsage("api/jirei/compile", MODEL, resp.usage);

    const block = resp.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use" && b.name === "submit_jirei"
    );
    if (!block) return NextResponse.json({ error: "AI の応答を解釈できませんでした" }, { status: 500 });

    const input = block.input as {
      jirei: Jirei;
      templateOps: { srcFile: string; outFile: string; ops: TemplateOp[] }[];
      warnings: string[];
    };
    const jirei = input.jirei;
    const warnings: string[] = [...(input.warnings || [])];

    // --- ops を適用してテンプレを書き出し ---
    const opReport: { file: string; ok: number; missed: string[] }[] = [];
    for (const t of input.templateOps || []) {
      let srcBuf: Buffer;
      try {
        srcBuf = await fs.readFile(path.join(dir, t.srcFile));
      } catch {
        warnings.push(`元ファイルが見つかりません: ${t.srcFile}`);
        continue;
      }
      const safeOut = t.outFile.replace(/[\\/:*?"<>|]/g, "");
      const { buf, counts } = applyTemplateOps(srcBuf, t.ops || []);
      const missed = (t.ops || []).filter((_, i) => counts[i] === 0).map((op) => op.find.slice(0, 30));
      if (missed.length > 0) {
        warnings.push(`${safeOut}: 置換できなかった値があります → ${missed.join(" / ")}`);
      }
      await fs.writeFile(path.join(TEMPLATE_DIR, safeOut), buf);
      opReport.push({ file: safeOut, ok: counts.filter((c) => c > 0).length, missed });
    }

    // --- 木を保存 ---
    const id = (jirei.id || folder).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    jirei.id = id;
    await fs.writeFile(path.join(JIREI_DIR, `${id}.json`), JSON.stringify(jirei, null, 2), "utf-8");

    return NextResponse.json({
      jirei,
      opReport,
      templateOps: input.templateOps, // デバッグ・レビュー用（AI が出した変換指示の生データ）
      warnings,
      savedTo: `data/jirei/${id}.json`,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "事由化に失敗しました" },
      { status: 500 }
    );
  }
}
