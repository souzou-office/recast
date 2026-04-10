import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder, readFileContent } from "@/lib/files";
import fs from "fs/promises";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Docxtemplater = require("docxtemplater");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require("pizzip");

const client = new Anthropic();

// テンプレートからプレースホルダーを抽出（【】{{}} ＜＞ ［］ {} <> [] 全対応）
function extractPlaceholders(text: string): { raw: string; name: string; delimiters: [string, string] }[] {
  const patterns = [
    { regex: /【([^】]+)】/g, start: "【", end: "】" },
    { regex: /\{\{([^}]+)\}\}/g, start: "{{", end: "}}" },
    { regex: /｛｛([^｝]+)｝｝/g, start: "｛｛", end: "｝｝" },
    { regex: /＜([^＞]+)＞/g, start: "＜", end: "＞" },
    { regex: /［([^\］]+)］/g, start: "［", end: "］" },
  ];
  const found = new Map<string, { raw: string; name: string; delimiters: [string, string] }>();
  for (const p of patterns) {
    let m;
    while ((m = p.regex.exec(text)) !== null) {
      const name = m[1].trim();
      if (!found.has(name)) {
        found.set(name, { raw: m[0], name, delimiters: [p.start, p.end] });
      }
    }
  }
  return Array.from(found.values());
}

// 半角英数字→全角変換
function toFullWidth(str: string): string {
  return str.replace(/[A-Za-z0-9]/g, (c) => {
    return String.fromCharCode(c.charCodeAt(0) + 0xFEE0);
  });
}

// プレースホルダー直後にある単位（テンプレ側に既に書かれている単位）を検出して、値末尾の重複を除去
const TRAILING_UNIT_RE = /[個日月年円様殿株名通時分秒歳枚件回点本冊行]/;
function stripDuplicatedUnit(value: string, key: string, templateContent: string): string {
  if (!value) return value;
  const placeholders = [`【${key}】`, `{{${key}}}`, `｛｛${key}｝｝`];
  let trailingUnit: string | null = null;
  let consistent = true;
  for (const ph of placeholders) {
    let pos = templateContent.indexOf(ph);
    while (pos !== -1) {
      const next = templateContent[pos + ph.length];
      if (next && TRAILING_UNIT_RE.test(next)) {
        if (trailingUnit === null) trailingUnit = next;
        else if (trailingUnit !== next) { consistent = false; break; }
      }
      pos = templateContent.indexOf(ph, pos + 1);
    }
    if (!consistent) break;
  }
  if (consistent && trailingUnit && value.endsWith(trailingUnit)) {
    return value.slice(0, -trailingUnit.length);
  }
  return value;
}

// テンプレートフォルダ + マスターシート → 書類生成
export async function POST(request: NextRequest) {
  const { companyId, templateFolderPath, mode, caseRoomId, masterContent: directMasterContent } = await request.json() as {
    companyId: string;
    templateFolderPath: string;
    mode?: "fill" | "generate";
    caseRoomId?: string;
    masterContent?: string;
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return new Response(JSON.stringify({ error: "会社が見つかりません" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  // テンプレートフォルダ内のファイルを読み込み
  const templateFiles = await readAllFilesInFolder(templateFolderPath);
  if (templateFiles.length === 0) {
    return new Response(JSON.stringify({ error: "テンプレートフォルダにファイルがありません" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // 共通メモ（テンプレートフォルダの親=templateBasePath直下のテキストファイル）
  let globalMemo = "";
  if (config.templateBasePath) {
    try {
      const { listFiles: listLocalFiles } = await import("@/lib/files");
      const parentFiles = await listLocalFiles(config.templateBasePath);
      for (const f of parentFiles) {
        if (!f.isDirectory && (f.name.endsWith(".txt") || f.name.endsWith(".md"))) {
          const { readFileContent: readLocal } = await import("@/lib/files");
          const content = await readLocal(f.path);
          if (content) globalMemo += `【共通ルール: ${f.name}】\n${content.content}\n\n`;
        }
      }
    } catch { /* ignore */ }
  }

  // マスターシートとプロファイル（caseRoom優先）
  const caseRoom = caseRoomId ? company.caseRooms?.find(r => r.id === caseRoomId) : null;
  const masterSheet = caseRoom?.masterSheet || company.masterSheet;
  const profile = company.profile;

  const dataContext = JSON.stringify({
    基本情報: profile?.structured || {},
    案件情報: masterSheet?.structured || {},
  }, null, 2);

  // テンプレートファイルを全部探す（docx/docm/xlsx/xls）
  const templateExts = [".docx", ".doc", ".docm", ".xlsx", ".xls"];
  const docxFiles = templateFiles.filter(f => {
    return templateExts.some(e => f.name.toLowerCase().endsWith(e));
  });

  // テキストファイルは全てメモ（ルール・注意事項）として扱う
  const memoFiles = templateFiles.filter(f => {
    const ext = f.name.toLowerCase().split(".").pop() || "";
    return (ext === "txt" || ext === "md") && !f.base64;
  });
  const memoText = memoFiles.map(f => `【${f.name}】\n${f.content}`).join("\n\n");

  // docxテンプレートがある場合 → プレースホルダー置換モード
  if (docxFiles.length > 0 && mode !== "generate") {
    // 全docxからプレースホルダーを抽出
    const allPlaceholders = new Map<string, { raw: string; name: string; delimiters: [string, string] }>();
    for (const df of docxFiles) {
      for (const p of extractPlaceholders(df.content)) {
        if (!allPlaceholders.has(p.name)) allPlaceholders.set(p.name, p);
      }
    }

    if (allPlaceholders.size === 0) {
      return new Response(JSON.stringify({ error: "テンプレートにプレースホルダーが見つかりません。【】や{{}}で囲んだプレースホルダーを入れてください" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    // AIにプレースホルダーの値を一括生成させる
    const placeholderEntries = Array.from(allPlaceholders.values());
    const placeholderList = placeholderEntries.map(p => `- ${p.name}`).join("\n");
    // テンプレートの内容を渡す（プレースホルダーの前後の文脈をAIが理解するため）
    const templateContents = docxFiles
      .filter(f => f.content && !f.base64)
      .map(f => `【${f.name}】\n${f.content}`)
      .join("\n\n");

    const prompt = `以下の会社データから、テンプレートのプレースホルダーに入る値をJSON形式で返してください。

## 会社データ
${dataContext}
${directMasterContent ? `\n## 案件整理テキスト（最新）\n${directMasterContent}\n` : masterSheet?.content ? `\n## 案件整理テキスト\n${masterSheet.content}\n` : ""}
${globalMemo ? `\n## 共通ルール\n${globalMemo}\n` : ""}
${memoText ? `\n## テンプレート注意事項\n${memoText}\n` : ""}

## テンプレート内容（プレースホルダーの前後の文脈を参照してください）
${templateContents}

## プレースホルダー一覧
${placeholderList}

## 回答形式
JSONで返してください。基本は全て文字列値です。

重要:
- **プレースホルダーの直前・直後にある単位や接尾辞は、テンプレート側に既に書かれている文字なので、絶対に値に含めない**
  - 例: テンプレに「【株数】個」とある → 値は \`"100"\` を返す（\`"100個"\` は二重になるのでNG）
  - 例: テンプレに「【月】月【日】日」とある → \`{"月":"4","日":"1"}\` を返す（\`"4月"\`, \`"1日"\` はNG）
  - 例: テンプレに「【代表者】様」とある → \`"山田太郎"\` を返す（\`"山田太郎様"\` はNG）
  - 例: テンプレに「金【金額】円」とある → \`"1000000"\` を返す（\`"1000000円"\` はNG）
- プレースホルダー前後に単位がない場合は、必要な単位込みで返してよい（例: 「届出日: 【届出日】」→ \`"令和６年４月１日"\`）
- 共通ルールやテンプレート注意事項の書式指示に必ず従う
- 例: {"会社名": "株式会社ABC", "代表取締役": "山田太郎", "届出日": "（要確認）"}

### 重要: 人数分作成が必要な場合のみ配列を使う
ルールや注意事項に「各株主に1通ずつ」「役員1人につき1通」等の**明示的な指示がある場合のみ**、その人ごとに変わるプレースホルダーだけを配列にしてください。

- 会社名、届出日など**全通共通の値は絶対に配列にしない**（文字列のまま）
- 氏名、住所など**人ごとに異なる値だけ**を配列にする
- 明示的な指示がなければ全て文字列（配列にしない）

例（「各株主に1通ずつ」の指示がある場合のみ）:
{
  "会社名": "株式会社ABC",
  "届出日": "令和６年４月１日",
  "株主の氏名": ["山田太郎", "鈴木花子"],
  "株主の住所": ["東京都...", "大阪府..."]
}

データにない情報は "（要確認）" としてください。`;

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return new Response(JSON.stringify({ error: "AIの応答をパースできませんでした" }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }

      const values: Record<string, string | string[]> = JSON.parse(jsonMatch[0]);

      // 配列のキーを特定
      const arrayKeys = new Set<string>();
      let maxCopies = 1;
      for (const [key, value] of Object.entries(values)) {
        if (Array.isArray(value) && value.length > 1) {
          arrayKeys.add(key);
          if (value.length > maxCopies) maxCopies = value.length;
        }
      }

      // 1通分の共通データ（配列は最初の値を使用）
      const singleData: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        singleData[key] = toFullWidth(Array.isArray(value) ? value[0] || "（要確認）" : value);
      }

      // ファイルごとに通数を判断する関数
      function getDataSetsForFile(fileContent: string): Record<string, string>[] {
        if (arrayKeys.size === 0) return [singleData];
        // このファイルに配列キーのプレースホルダーが含まれるか
        let hasArrayPlaceholder = false;
        for (const key of arrayKeys) {
          const pats = [`【${key}】`, `{{${key}}}`, `｛｛${key}｝｝`];
          if (pats.some(p => fileContent.includes(p))) {
            hasArrayPlaceholder = true;
            break;
          }
        }
        if (!hasArrayPlaceholder) return [singleData]; // 配列プレースホルダーなし→1通

        // 配列プレースホルダーあり→人数分
        const sets: Record<string, string>[] = [];
        for (let c = 0; c < maxCopies; c++) {
          const data: Record<string, string> = {};
          for (const [key, value] of Object.entries(values)) {
            if (Array.isArray(value)) {
              data[key] = toFullWidth(value[c] || "（要確認）");
            } else {
              data[key] = toFullWidth(value);
            }
          }
          sets.push(data);
        }
        return sets;
      }

      // 後方互換用ダミー
      const templateDataSets = [singleData]; // デフォルト（Excel用等）
      for (let c = 0; c < 1; c++) {
        const data: Record<string, string> = {};
        for (const [key, value] of Object.entries(values)) {
          data[key] = toFullWidth(Array.isArray(value) ? value[0] || "（要確認）" : value);
        }
        templateDataSets.push(data);
      }

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mammoth = require("mammoth");

      // 各docxを処理
      const documents: { name: string; docxBase64: string; previewHtml: string; fileName: string }[] = [];

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const XLSX = require("xlsx");

      // ファイル名順（番号順=手続き順）でソート
      docxFiles.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));

      for (const df of docxFiles) {
        try {
          const ext = df.name.toLowerCase().split(".").pop() || "";
          const rawBuffer = await fs.readFile(df.path);
          const baseName = df.name.replace(/\.[^.]+$/, "");

          if (ext === "xlsx" || ext === "xls") {
            // Excel: 全角変換しない（数式・数値はそのまま半角で）
            const rawData: Record<string, string> = {};
            for (const [key, value] of Object.entries(values)) {
              const v = Array.isArray(value) ? value[0] || "（要確認）" : value;
              rawData[key] = stripDuplicatedUnit(v, key, df.content);
            }
            const zip = new PizZip(rawBuffer);

            // 1) 置換前にプレースホルダーを含む共有文字列<si>のインデックスを記録
            //    （数値判定で「もとから数字に見えただけ」のセルを書き換えないため）
            const placeholderSiIndexes = new Set<number>();
            const ssPath = "xl/sharedStrings.xml";
            let ssXml = zip.file(ssPath)?.asText();
            const extractSiText = (siInner: string): string => {
              const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
              let text = "";
              let tm: RegExpExecArray | null;
              while ((tm = tRegex.exec(siInner)) !== null) text += tm[1];
              return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
            };
            if (ssXml) {
              const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
              let m: RegExpExecArray | null;
              let i = 0;
              while ((m = siRegex.exec(ssXml)) !== null) {
                const decoded = extractSiText(m[1]);
                for (const key of Object.keys(rawData)) {
                  if (decoded.includes(`【${key}】`) || decoded.includes(`{{${key}}}`) || decoded.includes(`｛｛${key}｝｝`)) {
                    placeholderSiIndexes.add(i);
                    break;
                  }
                }
                i++;
              }
            }

            // 2) 既存の文字列置換（XMLエスケープ付き）
            const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            for (const fileName of Object.keys(zip.files)) {
              if (fileName.endsWith(".xml") || fileName.endsWith(".xml.rels")) {
                let content = zip.file(fileName)?.asText();
                if (content) {
                  let changed = false;
                  for (const [key, replacement] of Object.entries(rawData)) {
                    const patterns = [`【${key}】`, `{{${key}}}`, `｛｛${key}｝｝`];
                    const escaped = xmlEscape(replacement);
                    for (const pat of patterns) {
                      if (content.includes(pat)) {
                        content = content.split(pat).join(escaped);
                        changed = true;
                      }
                    }
                  }
                  if (changed) zip.file(fileName, content);
                }
              }
            }

            // 3) 置換後のsharedStringsから数値化された<si>を検出
            const numericSiIndexes = new Map<number, string>(); // si index → 数値文字列
            ssXml = zip.file(ssPath)?.asText();
            if (ssXml && placeholderSiIndexes.size > 0) {
              const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
              let m: RegExpExecArray | null;
              let i = 0;
              while ((m = siRegex.exec(ssXml)) !== null) {
                if (placeholderSiIndexes.has(i)) {
                  const decoded = extractSiText(m[1]);
                  const cleaned = decoded.replace(/,/g, "").trim();
                  if (cleaned !== "" && /^-?\d+(\.\d+)?$/.test(cleaned)) {
                    numericSiIndexes.set(i, cleaned);
                  }
                }
                i++;
              }
            }

            // 4) 数値化したsiを参照するt="s"セルを数値型セルへ書き換え
            if (numericSiIndexes.size > 0) {
              for (const fileName of Object.keys(zip.files)) {
                if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fileName)) continue;
                let sheetXml = zip.file(fileName)?.asText();
                if (!sheetXml) continue;
                let sheetChanged = false;
                sheetXml = sheetXml.replace(
                  /<c\b([^>]*\bt="s"[^>]*)>\s*<v>(\d+)<\/v>\s*<\/c>/g,
                  (whole: string, attrs: string, idxStr: string) => {
                    const num = numericSiIndexes.get(parseInt(idxStr, 10));
                    if (num === undefined) return whole;
                    sheetChanged = true;
                    const newAttrs = attrs.replace(/\s*\bt="s"/, "");
                    return `<c${newAttrs}><v>${num}</v></c>`;
                  }
                );
                if (sheetChanged) zip.file(fileName, sheetXml);
              }
            }

            const outputBuffer = zip.generate({ type: "nodebuffer" });
            const outputName = `${company.name}_${baseName}.xlsx`;

            documents.push({
              name: baseName,
              docxBase64: outputBuffer.toString("base64"),
              previewHtml: "",
              fileName: outputName,
            });
          } else {
            // Word処理
            let wordBuffer = rawBuffer;
            const isOldDoc = ext === "doc" || ext === "docm";

            if (isOldDoc) {
              const docxPath = df.path.replace(/\.(doc|docm)$/i, ".docx");
              const fsSync = require("fs");
              if (fsSync.existsSync(docxPath)) {
                wordBuffer = fsSync.readFileSync(docxPath);
              } else {
                continue;
              }
            }

            const filePlaceholders = extractPlaceholders(df.content);
            const delims = filePlaceholders.length > 0 ? filePlaceholders[0].delimiters : ["【", "】"];

            // ファイルごとに通数を判断して個別生成
            const fileSets = getDataSetsForFile(df.content);
            for (let c = 0; c < fileSets.length; c++) {
              // テンプレ側に既にある単位をAI値が重複させていたら除去
              const templateData: Record<string, string> = {};
              for (const [key, val] of Object.entries(fileSets[c])) {
                templateData[key] = stripDuplicatedUnit(val, key, df.content);
              }
              const zip = new PizZip(wordBuffer);
              const doc = new Docxtemplater(zip, {
                delimiters: { start: delims[0], end: delims[1] },
                paragraphLoop: true,
                linebreaks: true,
                nullGetter: () => "（要確認）",
              });
              doc.render(templateData);
              const outputBuffer = doc.getZip().generate({ type: "nodebuffer" });

              // ファイル名: 元のファイル名を維持、複数通のみ枝番
              const suffix = fileSets.length > 1 ? `_${c + 1}` : "";
              const outputName = `${company.name}_${baseName}${suffix}.docx`;

              let previewHtml = "";
              try {
                const result = await mammoth.convertToHtml({ buffer: outputBuffer });
                previewHtml = result.value;
              } catch { /* ignore */ }

              documents.push({
                name: fileSets.length > 1 ? `${baseName}_${c + 1}` : baseName,
                docxBase64: outputBuffer.toString("base64"),
                previewHtml,
                fileName: outputName,
              });
            }
          }
        } catch { /* skip failed template */ }
      }

      return new Response(JSON.stringify({ documents }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "生成に失敗しました" }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  // docxテンプレートがない or generate mode → AI全文生成（ストリーミング）
  const templates: string[] = [];
  for (const f of templateFiles) {
    if (f.base64) continue;
    const isNote = f.name.toLowerCase().includes("メモ") || f.name.toLowerCase().includes("memo");
    if (!isNote) templates.push(`【テンプレート: ${f.name}】\n${f.content}`);
  }

  const prompt = `以下の会社データとテンプレートを使って、書類を生成してください。

## 会社データ
${dataContext}
${directMasterContent ? `\n## 案件整理テキスト（最新）\n${directMasterContent}\n` : masterSheet?.content ? `\n## 案件整理テキスト\n${masterSheet.content}\n` : ""}
## テンプレート
${templates.join("\n\n")}
${memoText ? `\n## 注意事項\n${memoText}` : ""}

ルール:
- テンプレートの【プレースホルダー】を会社データで埋めてください
- データにない情報は【要確認: 項目名】としてください
- 書式・文言はテンプレートを忠実に再現してください`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const aiStream = client.messages.stream({
          model: "claude-sonnet-4-6",
          max_tokens: 8192,
          messages: [{ role: "user", content: prompt }],
        });
        for await (const event of aiStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text", text: event.delta.text })}\n\n`));
          }
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
      } catch (e) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: e instanceof Error ? e.message : "生成に失敗" })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
