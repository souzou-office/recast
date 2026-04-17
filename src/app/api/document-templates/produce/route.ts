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
// 条件分岐マーカー（#flag / /flag で始まるもの）は除外
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
      // 条件分岐マーカーは除外（例: #出資者は法人, /出資者は法人）
      if (name.startsWith("#") || name.startsWith("/")) continue;
      if (!found.has(name)) {
        found.set(name, { raw: m[0], name, delimiters: [p.start, p.end] });
      }
    }
  }
  return Array.from(found.values());
}

// 条件分岐フラグを抽出（{{#flag}}...{{/flag}} のflag部分）
function extractConditionFlags(text: string): string[] {
  const flags = new Set<string>();
  // {{}}, ｛｛｝｝ の両形式で #flag を検出
  const patterns = [
    /\{\{#([^}\/]+)\}\}/g,
    /｛｛#([^｝\/]+)｝｝/g,
    /【#([^】\/]+)】/g,
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      flags.add(m[1].trim());
    }
  }
  return Array.from(flags);
}

// 半角英数字→全角変換
function toFullWidth(str: string): string {
  return str.replace(/[A-Za-z0-9]/g, (c) => {
    return String.fromCharCode(c.charCodeAt(0) + 0xFEE0);
  });
}

// 全角英数字・記号→半角変換（Excel用: 数値・数式が壊れないように）
// 最終値が「純数値」「日付」でなければ、英数字を全角に戻して見た目を整える
function toHalfWidth(str: string): string {
  let result = str
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, ".").replace(/，/g, ",").replace(/－/g, "-").replace(/＋/g, "+")
    .replace(/（/g, "(").replace(/）/g, ")").replace(/％/g, "%").replace(/＆/g, "&")
    .replace(/　/g, " ");
  const isPureNumber = /^-?[\d,]+(\.\d+)?$/.test(result.trim());
  const isDate = /年/.test(result) || (/月/.test(result) && /日/.test(result));
  if (isDate) {
    // 日付は数字を全角に
    result = result.replace(/[0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
  } else if (!isPureNumber) {
    // テキスト扱いの値（会社名・住所・氏名等）は英数字を全角に戻す
    result = result.replace(/[A-Za-z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
  }
  return result;
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
  const { companyId, templateFolderPath, mode, caseRoomId, masterContent: directMasterContent, confirmedAnswers, folderPath: caseFolderPath, disabledFiles: caseDisabledFiles } = await request.json() as {
    companyId: string;
    templateFolderPath: string;
    mode?: "fill" | "generate";
    caseRoomId?: string;
    masterContent?: string;
    confirmedAnswers?: Record<string, string>;
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

  // テンプレートフォルダ内のファイルを読み込み
  const templateFiles = await readAllFilesInFolder(templateFolderPath);
  if (templateFiles.length === 0) {
    return new Response(JSON.stringify({ error: "テンプレートフォルダにファイルがありません" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // 共通ルールフォルダの再帰読み込み（templateBasePath配下の全ファイル、テンプレフォルダ自体は除外）
  const { loadGlobalRules } = await import("@/lib/global-rules");
  const globalMemo = await loadGlobalRules(config.templateBasePath, templateFolderPath);

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
      // ハイライト方式のテンプレートかもしれないので、docxファイルにハイライトがあるかチェック
      const { extractMarkedFields } = await import("@/lib/docx-marker-parser");
      let hasHighlights = false;
      for (const df of docxFiles) {
        const ext = df.name.toLowerCase().split(".").pop() || "";
        if (ext === "xlsx" || ext === "xls") continue;
        try {
          const buf = await fs.readFile(df.path);
          if (extractMarkedFields(buf).length > 0) { hasHighlights = true; break; }
        } catch { /* ignore */ }
      }
      if (!hasHighlights) {
        return new Response(JSON.stringify({ error: "テンプレートにプレースホルダーもハイライトも見つかりません。【】や{{}}で囲むか、可変部分に黄色ハイライトを引いてください" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      // ハイライトあり → プレースホルダー用AI呼び出しをスキップして直接ファイル処理へ
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mammothHL = require("mammoth");
      const documentsHL: { name: string; docxBase64: string; previewHtml: string; fileName: string }[] = [];

      // 生ファイルは送らない。抽出済みデータ（基本情報+案件整理+clarify回答）だけ使う。
      // 足りない情報はclarifyが事前に聞いているはず。
      const hlSourceTexts: string[] = []; // 後方互換用（Excel処理で参照）

      docxFiles.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
      for (const df of docxFiles) {
        try {
          const ext = df.name.toLowerCase().split(".").pop() || "";
          const rawBuffer = await fs.readFile(df.path);
          const baseName = df.name.replace(/\.[^.]+$/, "");
          if (ext === "xlsx" || ext === "xls") {
            // Excel: まずプレースホルダーをチェック、なければ黄色セル検出
            const xlPlaceholders = extractPlaceholders(df.content);
            console.log(`[produce/excel] ${df.name}: placeholders=${xlPlaceholders.length}`);

            if (xlPlaceholders.length === 0) {
              // プレースホルダーなし → 黄色セル方式
              try {
                const { extractXlsxMarkedCells, replaceXlsxMarkedCells, getXlsxMarkedTextWithSlots, expandYellowRowBlock } = await import("@/lib/xlsx-marker-parser");

                // 基本情報の配列（株主構成・役員等）から件数を推定し、黄色行リストが不足していれば複製
                // ※「繰り返し入力フォーム」（3セル以上×2行以上）のブロックのみ拡張対象
                const structured = (company.profile?.structured || {}) as Record<string, unknown>;
                const arrayCounts: number[] = [];
                for (const v of Object.values(structured)) {
                  if (Array.isArray(v) && v.length >= 2) arrayCounts.push(v.length);
                }
                const desiredRows = arrayCounts.length > 0 ? Math.max(...arrayCounts) : 0;
                let workingBuffer: Buffer = rawBuffer;
                if (desiredRows > 0) {
                  const expanded = expandYellowRowBlock(rawBuffer, desiredRows);
                  if (expanded !== rawBuffer) {
                    console.log(`[produce/excel] ${df.name}: expanded yellow row block to fit ${desiredRows} entries`);
                    workingBuffer = expanded;
                  }
                }

                const markedCells = extractXlsxMarkedCells(workingBuffer);
                console.log(`[produce/excel] ${df.name}: yellow cells=${markedCells.length}`);
                if (markedCells.length === 0) { console.log(`[produce/excel] ${df.name}: no placeholders or yellow cells, skipping`); continue; }

                const { text: xlMarkedText, slots: xlSlots } = getXlsxMarkedTextWithSlots(workingBuffer);
                const xlMarkerPrompt = `あなたは司法書士事務所の書類作成担当です。
以下はExcelの書類テンプレートです。［要入力_N《前案件:○○》］と書かれた部分が「可変箇所」です。

**絶対ルール**:
- 《前案件:...》 の中身は過去の別案件の値。型判定のみに使い、必ず今回の案件データの値に置き換える
- 《前案件:○○》とまったく同じ文字列を返答することは禁止

## Excelテンプレート
${xlMarkedText}

## 今回の案件データ
${dataContext}
${directMasterContent ? `\n### 案件整理テキスト\n${directMasterContent}\n` : ""}
${globalMemo ? `\n### 共通ルール\n${globalMemo}\n` : ""}

## 回答形式
**JSONのみ返してください。** キーは "要入力_N"、バリューは埋める値（文字列）。
例: {"要入力_0": "三上春香", "要入力_1": "広島県大竹市西栄二丁目8番9号"}

重要:
- **［要入力_N］ の全ての N について値を返すこと。省略なし**
- **hint（前案件の値）は型判定のみ。必ず今回の案件データで差し替える**
- **人名**: hint が人名（例:「福田峻介」）→ 基本情報の役員リストや株主構成から該当氏名
- **会社名**: hint が会社名 → 基本情報の商号
- **株主表の行**: hint が株主氏名/住所/持株数/メール → 基本情報の株主構成の n 番目を列ごとに展開
- **数値セル**（持株数・議決権数・割合）は数字のまま返す（全角変換はシステム側）
  - 割合は小数（0.05 等）ではなく「5.00%」のようなパーセント文字列で返す
- **日付セル**（シリアル値ではない「令和...」）→ 和暦全角文字列
- 基本情報・案件整理テキストに見つからない値だけ "（要確認）"`;

                const xlResponse = await client.messages.create({
                  model: "claude-sonnet-4-6",
                  max_tokens: 4096,
                  messages: [{ role: "user", content: xlMarkerPrompt }],
                });
                const xlText = xlResponse.content[0].type === "text" ? xlResponse.content[0].text : "";
                const xlJsonMatch = xlText.match(/\{[\s\S]*\}/);
                if (xlJsonMatch) {
                  let xlParsed: Record<string, unknown> = {};
                  try { xlParsed = JSON.parse(xlJsonMatch[0]); } catch {
                    const lb = xlJsonMatch[0].lastIndexOf("}");
                    if (lb > 0) try { xlParsed = JSON.parse(xlJsonMatch[0].substring(0, lb + 1)); } catch { /* give up */ }
                  }
                  // AI応答の "要入力_N" キーを xlSlots で元の値に変換し、
                  // replaceXlsxMarkedCells が期待する { origValue: newValue } 形式に。
                  const xlReplacements: Record<string, string> = {};
                  for (const [k, v] of Object.entries(xlParsed)) {
                    if (typeof v !== "string") continue;
                    const idMatch = k.match(/要入力_(\d+)/);
                    if (!idMatch) continue;
                    const id = parseInt(idMatch[1]);
                    const origValue = xlSlots.get(id);
                    if (!origValue) continue;
                    xlReplacements[origValue] = toHalfWidth(v);
                  }
                  console.log(`[produce/excel] ${df.name}: replacements=${Object.keys(xlReplacements).length}, slots=${xlSlots.size}`);
                  const xlOutBuf = replaceXlsxMarkedCells(workingBuffer, xlReplacements);
                  const xlOutName = `${company.name}_${baseName}.xlsx`;
                  documentsHL.push({ name: baseName, docxBase64: xlOutBuf.toString("base64"), previewHtml: "", fileName: xlOutName });
                }
              } catch (xlErr) {
                console.error(`[produce/excel/highlight] ${df.name}:`, xlErr instanceof Error ? xlErr.message : xlErr);
              }
              continue;
            }

            // Excel用のAI値生成（簡易版：ハイライトで既に収集した原本データを使用）
            const xlPlaceholderList = xlPlaceholders.map(p => `- ${p.name}`).join("\n");
            const xlPrompt = `以下の会社データから、Excelテンプレートのプレースホルダーに入る値をJSON形式で返してください。

## 会社データ
${dataContext}
${directMasterContent ? `\n## 案件整理テキスト\n${directMasterContent}\n` : masterSheet?.content ? `\n## 案件整理テキスト\n${masterSheet.content}\n` : ""}
${globalMemo ? `\n## 共通ルール\n${globalMemo}\n` : ""}

## プレースホルダー一覧
${xlPlaceholderList}

JSONのみ返してください。データにない情報は "（要確認）" としてください。`;

            try {
              const xlResponse = await client.messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 4096,
                messages: [{ role: "user", content: xlPrompt }],
              });
              const xlText = xlResponse.content[0].type === "text" ? xlResponse.content[0].text : "";
              const xlJsonMatch = xlText.match(/\{[\s\S]*\}/);
              if (xlJsonMatch) {
                const xlValues: Record<string, string | string[]> = JSON.parse(xlJsonMatch[0]);

                // Excel用の値をtoHalfWidthで処理
                const rawData: Record<string, string> = {};
                for (const [key, value] of Object.entries(xlValues)) {
                  if (typeof value === "boolean") continue;
                  const v = Array.isArray(value) ? value[0] || "（要確認）" : value;
                  rawData[key] = toHalfWidth(stripDuplicatedUnit(v, key, df.content));
                }

                // PizZipで既存のExcel処理を実行
                const xlZip = new PizZip(rawBuffer);
                const ssPath = "xl/sharedStrings.xml";

                // 文字列置換
                const xlXmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                for (const fileName of Object.keys(xlZip.files)) {
                  if (fileName.endsWith(".xml") || fileName.endsWith(".xml.rels")) {
                    let content = xlZip.file(fileName)?.asText();
                    if (content) {
                      let changed = false;
                      for (const [key, replacement] of Object.entries(rawData)) {
                        const patterns = [`【${key}】`, `{{${key}}}`, `｛｛${key}｝｝`];
                        const escaped = xlXmlEscape(replacement);
                        for (const pat of patterns) {
                          if (content.includes(pat)) {
                            content = content.split(pat).join(escaped);
                            changed = true;
                          }
                        }
                      }
                      if (changed) xlZip.file(fileName, content);
                    }
                  }
                }

                const xlOutputBuffer = xlZip.generate({ type: "nodebuffer" });
                const xlOutputName = `${company.name}_${baseName}.xlsx`;
                documentsHL.push({ name: baseName, docxBase64: xlOutputBuffer.toString("base64"), previewHtml: "", fileName: xlOutputName });
              }
            } catch (xlErr) {
              console.error(`[produce/highlight] Excel skipped ${df.name}:`, xlErr instanceof Error ? xlErr.message : xlErr);
            }
            continue;
          }
          let wordBuffer = rawBuffer;
          const isOldDoc = ext === "doc" || ext === "docm";
          if (isOldDoc) {
            const docxPath = df.path.replace(/\.(doc|docm)$/i, ".docx");
            const fsSync = require("fs");
            if (fsSync.existsSync(docxPath)) wordBuffer = fsSync.readFileSync(docxPath);
            else continue;
          }
          const { extractMarkedFields: emf, replaceMarkedFields, getMarkedDocumentTextWithSlots } = await import("@/lib/docx-marker-parser");
          const markedFields = emf(wordBuffer);
          if (markedFields.length === 0) continue;

          // 文書全体を ［要入力_N］ 付きで取得（★の中身=前案件の値はAIに見せない）
          const { text: markedDocText, slots: docSlots } = getMarkedDocumentTextWithSlots(wordBuffer);

          // コメント付きフィールドがあれば対応する slot 番号をつけてヒントとして渡す
          const slotValueToId = new Map<string, number>();
          for (const [id, val] of docSlots) {
            if (!slotValueToId.has(val)) slotValueToId.set(val, id);
          }
          const commentList = markedFields
            .filter(f => f.comment)
            .map(f => {
              const id = slotValueToId.get(f.originalValue);
              return id !== undefined ? `- ［要入力_${id}］ → ${f.comment}` : null;
            })
            .filter(Boolean)
            .join("\n");

          const markerPrompt = `あなたは司法書士事務所の書類作成担当です。
以下は書類テンプレートです。［要入力_N《前案件:○○》］ と書かれた部分が「可変箇所」です。

**絶対ルール**:
- 《前案件:...》 の中身は **過去の別案件** の値。型（日付/人名/会社名/金額等）を判断する参考にのみ使い、**今回の案件データから得られる新しい値で必ず置き換える**
- 《前案件:○○》 と**まったく同じ文字列**を返答することは禁止。必ず今回の案件データから引いた値にする
- 「同姓同名のはず」等の憶測で前案件の値を維持してはいけない。基本情報・案件整理テキストに書かれた値を使うこと

## 書類テンプレート
${markedDocText}
${commentList ? `\n## コメント補足（［要入力_N］の意味のヒント）\n${commentList}\n` : ""}

## 今回の案件データ
### 基本情報（会社の登記情報等）
${dataContext}
${directMasterContent ? `\n### 案件整理テキスト（今回の手続き内容）\n${directMasterContent}\n` : masterSheet?.content ? `\n### 案件整理テキスト\n${masterSheet.content}\n` : ""}
${globalMemo ? `\n### 共通ルール\n${globalMemo}\n` : ""}
${memoText ? `\n### テンプレート注意事項\n${memoText}\n` : ""}
${confirmedAnswers && Object.keys(confirmedAnswers).length > 0 ? `\n### ユーザー確定済みの値\n${Object.entries(confirmedAnswers).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n` : ""}

## 回答形式
**JSONのみ返してください。説明文やコメントは一切不要です。**

### 通常（1通の場合）
キーは "要入力_N"（N は番号）、バリューはそこに入る値（文字列）。
例: {"要入力_0": "三上春香", "要入力_1": "広島県大竹市西栄二丁目8番9号", "要入力_2": "令和８年１月２８日"}

### 複数通が必要な場合（共通ルールで「株主毎に1枚」等の指示がある場合）
配列で返す。各要素が1通分の置換マップ。共通の値も各要素に含める。
例: [{"要入力_0": "山田太郎", "要入力_1": "東京都..."}, {"要入力_0": "鈴木花子", "要入力_1": "大阪府..."}]

重要:
- **［要入力_N］ の全ての N について値を返すこと。省略なし**
- **《前案件:○○》と完全一致する返答は禁止**（必ず今回の案件データから差し替え）
- **人名・役職**: 《前案件:人名》→ 基本情報の役員/株主から今回の氏名へ置換。《前案件:代表取締役　人名》のような役職+氏名セット → 役職は案件データで変更有無を判断、氏名は今回の代表取締役氏名で置換（絶対に前案件の人名は残さない）
- **会社名**: 《前案件:会社名》→ 基本情報の商号で置換
- **株主の情報**: 《前案件:株主氏名・住所・持株数》→ 基本情報の株主構成（氏名・住所・持株数・持株比率）のn番目から引く
- **日付**: 《前案件:令和×年×月×日》→ 案件整理テキストの該当日付を和暦全角数字で返す（令和７年１月２１日 など。数字は全角 ０-９）
- **金額・株数**: 《前案件:数字》→ 案件整理テキストから正しい値、全角カンマ区切り
- **共通ルールに「株主毎に1枚」等の指示があれば、配列形式で株主数分返す**
- 原本・基本情報・案件整理テキストに書いてある情報は必ず使い、「要確認」にしない
- どこにも見つからない情報だけ "（要確認）"`;

          // 抽出済みデータだけ送る（生ファイルは送らない＝コスト削減）
          console.log(`[produce/highlight] ${df.name}: dataContext length=${dataContext.length}, masterContent length=${(directMasterContent || "").length}, prompt length=${markerPrompt.length}`);
          if (df.name.includes("同意書") || df.name.includes("株主")) {
            // 株主関連のテンプレで、株主データが含まれているか確認
            console.log(`[produce/highlight] ${df.name}: 株主構成 in dataContext: ${dataContext.includes("株主構成") ? "YES" : "NO"}`);
            console.log(`[produce/highlight] ${df.name}: 94500 in dataContext: ${dataContext.includes("94500") ? "YES" : "NO"}`);
          }
          const markerResponse = await client.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            messages: [{ role: "user", content: markerPrompt }],
          });
          const markerText = markerResponse.content[0].type === "text" ? markerResponse.content[0].text : "";

          // JSON パース（オブジェクトまたは配列）
          const jsonMatch = markerText.match(/[\[{][\s\S]*[\]}]/);
          if (!jsonMatch) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(jsonMatch[0]);
          } catch {
            const raw = jsonMatch[0];
            const lastBrace = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
            if (lastBrace > 0) {
              try { parsed = JSON.parse(raw.substring(0, lastBrace + 1)); } catch { continue; }
            } else { continue; }
          }

          // 配列 → 複数通、オブジェクト → 1通
          // AI応答は { "要入力_N": "new_value" } 形式。docSlots で N → originalValue に変換し、
          // 最終的に replaceMarkedFields が期待する { originalValue: newValue } 形式にする。
          const replacementSets: Record<string, string>[] = [];
          const parseOneSet = (obj: unknown): Record<string, string> => {
            const result: Record<string, string> = {};
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
              for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
                if (typeof v !== "string") continue;
                // "要入力_5" or "要入力_5" キーから N を抽出
                const idMatch = k.match(/要入力_(\d+)/);
                if (!idMatch) continue;
                const id = parseInt(idMatch[1]);
                const origValue = docSlots.get(id);
                if (!origValue) continue;
                result[origValue] = toFullWidth(v);
              }
            }
            return result;
          };

          if (Array.isArray(parsed)) {
            for (const item of parsed) replacementSets.push(parseOneSet(item));
          } else {
            replacementSets.push(parseOneSet(parsed));
          }

          console.log(`[produce/highlight] ${df.name}: ${replacementSets.length} copies, fields: ${markedFields.length}, slots: ${docSlots.size}`);

          // 各セットで書類生成
          for (let ci = 0; ci < replacementSets.length; ci++) {
            const replacements = replacementSets[ci];
            const outputBuffer = replaceMarkedFields(wordBuffer, replacements);
            const suffix = replacementSets.length > 1 ? `_${ci + 1}` : "";
            const outputName = `${company.name}_${baseName}${suffix}.docx`;
            let previewHtml = "";
            try { previewHtml = (await mammothHL.convertToHtml({ buffer: outputBuffer })).value; } catch { /* ignore */ }
            documentsHL.push({
              name: replacementSets.length > 1 ? `${baseName}_${ci + 1}` : baseName,
              docxBase64: outputBuffer.toString("base64"),
              previewHtml,
              fileName: outputName,
            });
          }
        } catch (err) {
          console.error(`[produce/highlight] skipped ${df.name}:`, err instanceof Error ? err.message : err);
        }
      }
      return new Response(JSON.stringify({ documents: documentsHL }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // AIにプレースホルダーの値を一括生成させる
    const placeholderEntries = Array.from(allPlaceholders.values());
    const placeholderList = placeholderEntries.map(p => `- ${p.name}`).join("\n");

    // 条件分岐フラグを全docxから収集
    const allConditionFlags = new Set<string>();
    for (const df of docxFiles) {
      for (const f of extractConditionFlags(df.content)) allConditionFlags.add(f);
    }
    const conditionFlagList = Array.from(allConditionFlags);

    // テンプレートの内容を渡す（プレースホルダーの前後の文脈をAIが理解するため）
    const templateContents = docxFiles
      .filter(f => f.content && !f.base64)
      .map(f => `【${f.name}】\n${f.content}`)
      .join("\n\n");

    // ユーザーが確定した値（clarifyで回答済み）
    const confirmedBlock = confirmedAnswers && Object.keys(confirmedAnswers).length > 0
      ? `\n## ユーザー確定済みの値（これらは絶対にこの値を使う。再解釈しない）\n` +
        Object.entries(confirmedAnswers).map(([k, v]) => `- 【${k}】: ${v}`).join("\n") + "\n"
      : "";

    const prompt = `以下の会社データから、テンプレートのプレースホルダーに入る値をJSON形式で返してください。

## 会社データ
${dataContext}
${directMasterContent ? `\n## 案件整理テキスト（最新）\n${directMasterContent}\n` : masterSheet?.content ? `\n## 案件整理テキスト\n${masterSheet.content}\n` : ""}
${globalMemo ? `\n## 共通ルール\n${globalMemo}\n` : ""}
${memoText ? `\n## テンプレート注意事項\n${memoText}\n` : ""}
${confirmedBlock}
## テンプレート内容（プレースホルダーの前後の文脈を参照してください）
${templateContents}

## プレースホルダー一覧
${placeholderList}
${conditionFlagList.length > 0 ? `\n## 条件分岐フラグ一覧（真偽値 true/false で返すこと）\n${conditionFlagList.map(f => `- ${f}`).join("\n")}\n\n条件分岐: テンプレート内の {{#フラグ名}}...{{/フラグ名}} はフラグが true のときだけ中身が残る。文脈から判断して true/false を決めて返すこと。例: 出資者が法人なら \`"出資者は法人": true, "出資者は個人": false\`\n` : ""}

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

データにない情報は "（要確認）" としてください。ただし上の「ユーザー確定済みの値」に該当するプレースホルダーは必ずその値を使うこと。`;

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

      const values: Record<string, string | string[] | boolean> = JSON.parse(jsonMatch[0]);

      // 文字列で "true"/"false" が返ってきた場合は boolean に変換
      // ただし「conditionFlagList に含まれる名前」だけ対象（通常の値で "true" 等を持つ可能性を考慮）
      const conditionFlagSet = new Set(conditionFlagList);
      for (const [key, value] of Object.entries(values)) {
        if (conditionFlagSet.has(key) && typeof value === "string") {
          const v = value.toLowerCase().trim();
          if (v === "true" || v === "1" || v === "はい" || v === "yes") values[key] = true;
          else if (v === "false" || v === "0" || v === "いいえ" || v === "no") values[key] = false;
        }
      }

      // 条件フラグ（boolean値）を分離
      const conditionFlags: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === "boolean") conditionFlags[key] = value;
      }
      console.log("[produce] condition flags:", conditionFlags);

      // 配列のキーを特定
      const arrayKeys = new Set<string>();
      let maxCopies = 1;
      for (const [key, value] of Object.entries(values)) {
        if (Array.isArray(value) && value.length > 1) {
          arrayKeys.add(key);
          if (value.length > maxCopies) maxCopies = value.length;
        }
      }

      // 1通分の共通データ（配列は最初の値を使用、booleanはそのまま）
      const singleData: Record<string, string | boolean> = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === "boolean") {
          singleData[key] = value;
        } else {
          singleData[key] = toFullWidth(Array.isArray(value) ? value[0] || "（要確認）" : value);
        }
      }

      // ファイルごとに通数を判断する関数
      function getDataSetsForFile(fileContent: string): Record<string, string | boolean>[] {
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
        const sets: Record<string, string | boolean>[] = [];
        for (let c = 0; c < maxCopies; c++) {
          const data: Record<string, string | boolean> = {};
          for (const [key, value] of Object.entries(values)) {
            if (typeof value === "boolean") {
              data[key] = value;
            } else if (Array.isArray(value)) {
              data[key] = toFullWidth(value[c] || "（要確認）");
            } else {
              data[key] = toFullWidth(value);
            }
          }
          sets.push(data);
        }
        return sets;
      }

      // 後方互換用ダミー（条件フラグは含めない - Excel用）
      const templateDataSets = [singleData]; // デフォルト（Excel用等）
      for (let c = 0; c < 1; c++) {
        const data: Record<string, string> = {};
        for (const [key, value] of Object.entries(values)) {
          if (typeof value === "boolean") continue;
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
            // Excel: 全角→半角統一（数値・数式が正しく動くように）
            const rawData: Record<string, string> = {};
            for (const [key, value] of Object.entries(values)) {
              if (typeof value === "boolean") continue; // 条件フラグはExcelでは使わない
              const v = Array.isArray(value) ? value[0] || "（要確認）" : value;
              rawData[key] = toHalfWidth(stripDuplicatedUnit(v, key, df.content));
            }
            const zip = new PizZip(rawBuffer);
            const ssPath = "xl/sharedStrings.xml";

            // <si>内の本文<t>テキストを結合して返す（<rPh>=ふりがなと<phoneticPr>内の<t>は除外）
            const extractSiText = (siInner: string): string => {
              const stripped = siInner
                .replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")
                .replace(/<phoneticPr\b[^>]*\/>/g, "");
              const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
              let text = "";
              let tm: RegExpExecArray | null;
              while ((tm = tRegex.exec(stripped)) !== null) text += tm[1];
              return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
            };

            // 1) 文字列置換（XMLエスケープ付き）
            const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const replacedKeys = new Set<string>();
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
                        replacedKeys.add(escaped);
                      }
                    }
                  }
                  if (changed) zip.file(fileName, content);
                }
              }
            }

            // 1b) sharedStrings.xml からルビ（rPh/phoneticPr）を全削除
            //     置換によるオフセット不整合でExcelが修復警告を出すのを根絶するため、
            //     条件判定せず無条件に潰す。ふりがなは出力書類で不要。
            {
              const ssContent = zip.file(ssPath)?.asText();
              if (ssContent) {
                const cleaned = ssContent
                  .replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "")
                  .replace(/<phoneticPr\b[^>]*\/>/g, "")
                  .replace(/<phoneticPr\b[^>]*>[\s\S]*?<\/phoneticPr>/g, "");
                if (cleaned !== ssContent) zip.file(ssPath, cleaned);
              }
            }

            // 2) 全共有文字列をスキャンし、純数値のものを検出
            const numericSiIndexes = new Map<number, string>();
            let currentSsXml = zip.file(ssPath)?.asText();
            if (currentSsXml) {
              const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
              let m: RegExpExecArray | null;
              let i = 0;
              while ((m = siRegex.exec(currentSsXml)) !== null) {
                const decoded = extractSiText(m[1]);
                const cleaned = decoded.replace(/,/g, "").trim();
                if (cleaned !== "" && /^-?\d+(\.\d+)?$/.test(cleaned)) {
                  numericSiIndexes.set(i, cleaned);
                }
                i++;
              }
            }

            // 3) 全シートを走査してセル型を正規化
            //    - t="s" で純数値の共有文字列を参照 → 数値型
            //    - t="inlineStr" で純数値 → 数値型
            //    - t無し (デフォルト) で <v> が純数値 → そのまま（Excel的に既に数値）
            const isNumericStr = (s: string): string | null => {
              const cleaned = s.replace(/,/g, "").trim();
              if (cleaned === "") return null;
              return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
            };
            for (const fileName of Object.keys(zip.files)) {
              if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fileName)) continue;
              let sheetXml = zip.file(fileName)?.asText();
              if (!sheetXml) continue;
              let sheetChanged = false;

              // t="s" セル → 数値型へ
              if (numericSiIndexes.size > 0) {
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
              }

              // t="inlineStr" セル → 純数値なら数値型へ
              sheetXml = sheetXml.replace(
                /<c\b([^>]*\bt="inlineStr"[^>]*)>\s*<is>([\s\S]*?)<\/is>\s*<\/c>/g,
                (whole: string, attrs: string, isInner: string) => {
                  const text = extractSiText(isInner);
                  const num = isNumericStr(text);
                  if (num === null) return whole;
                  sheetChanged = true;
                  const newAttrs = attrs.replace(/\s*\bt="inlineStr"/, "");
                  return `<c${newAttrs}><v>${num}</v></c>`;
                }
              );

              // 数式キャッシュのクリア
              sheetXml = sheetXml.replace(
                /<c\b([^>]*)>(\s*<f\b[^>]*(?:\/>|>[\s\S]*?<\/f>))\s*<v>[^<]*<\/v>\s*<\/c>/g,
                (_whole: string, attrs: string, fEl: string) => {
                  sheetChanged = true;
                  const newAttrs = attrs.replace(/\s*\bt="[^"]*"/, "");
                  return `<c${newAttrs}>${fEl}</c>`;
                }
              );

              if (sheetChanged) zip.file(fileName, sheetXml);
            }

            // 4) sharedStrings.xmlのcount属性を実際のt="s"参照数に合わせて更新
            currentSsXml = zip.file(ssPath)?.asText();
            if (currentSsXml) {
              let totalStringRefs = 0;
              for (const fileName of Object.keys(zip.files)) {
                if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fileName)) continue;
                const sheetXml = zip.file(fileName)?.asText();
                if (sheetXml) {
                  totalStringRefs += (sheetXml.match(/<c\b[^>]*\bt="s"[^>]*>/g) || []).length;
                }
              }
              const updatedSsXml = currentSsXml.replace(
                /<sst\b[^>]*>/,
                (tag: string) => tag.replace(/\bcount="[^"]*"/, `count="${totalStringRefs}"`)
              );
              if (updatedSsXml !== currentSsXml) zip.file(ssPath, updatedSsXml);
            }

            // 5) calcChain.xml を削除（式や参照を変更したため古い計算チェーンは不整合になる）
            //    これが残っているとExcelが「修復が必要」警告を出す。削除すればExcelが開いたとき再生成する。
            if (zip.file("xl/calcChain.xml")) {
              zip.remove("xl/calcChain.xml");
              // workbook.xml.rels から calcChain への参照も削除
              const relsPath = "xl/_rels/workbook.xml.rels";
              const relsXml = zip.file(relsPath)?.asText();
              if (relsXml) {
                const cleanedRels = relsXml.replace(
                  /<Relationship\b[^>]*\bTarget="calcChain\.xml"[^>]*\/>/g,
                  ""
                );
                if (cleanedRels !== relsXml) zip.file(relsPath, cleanedRels);
              }
              // [Content_Types].xml から calcChain の宣言も削除
              const ctPath = "[Content_Types].xml";
              const ctXml = zip.file(ctPath)?.asText();
              if (ctXml) {
                const cleanedCt = ctXml.replace(
                  /<Override\b[^>]*\bPartName="\/xl\/calcChain\.xml"[^>]*\/>/g,
                  ""
                );
                if (cleanedCt !== ctXml) zip.file(ctPath, cleanedCt);
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

            // ハイライト方式の検出
            const { extractMarkedFields, replaceMarkedFields } = await import("@/lib/docx-marker-parser");
            const markedFields = extractMarkedFields(wordBuffer);

            if (markedFields.length > 0) {
              // === 新方式: ハイライトベース ===
              // ハイライトされた可変部分をAIに渡して新しい値を生成
              const fieldList = markedFields.map((f, i) =>
                `${i + 1}. 元の値: "${f.originalValue}"${f.comment ? ` (説明: ${f.comment})` : ""}\n   文脈: ${f.context}`
              ).join("\n");

              const markerPrompt = `この書類は過去案件の完成書類をテンプレートとして使っています。
ハイライトされた部分が「可変箇所」です。ハイライトの値は前案件のものであり、今回の案件とは無関係です。

今回のデータに基づいて、各可変箇所に入れるべき値をJSONで返してください。

## 今回の会社データ
${dataContext}
${directMasterContent ? `\n## 案件整理テキスト（最新）\n${directMasterContent}\n` : masterSheet?.content ? `\n## 案件整理テキスト\n${masterSheet.content}\n` : ""}
${globalMemo ? `\n## 共通ルール\n${globalMemo}\n` : ""}
${memoText ? `\n## テンプレート注意事項\n${memoText}\n` : ""}
${confirmedAnswers && Object.keys(confirmedAnswers).length > 0 ? `\n## ユーザー確定済みの値\n${Object.entries(confirmedAnswers).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n` : ""}

## 可変箇所（ハイライト部分）
${fieldList}

## 回答形式
元の値をキー、新しい値をバリューとするJSONで返してください。
同じ元の値が複数箇所に出現する場合、全て同じ新しい値に置換されます。
例: {"株式会社HIBARI": "株式会社Aicurion", "佐藤 羽瑠": "石橋賢人", "静岡県御殿場市川島田989番地の5": "東京都目黒区東が丘2丁目7番7号"}

重要:
- 元の値の「型」（日付の書式、数値の桁区切り、敬称の有無等）を維持すること
- 今回のデータにない情報は "（要確認）" とすること
- ユーザー確定済みの値は必ずそのまま使うこと`;

              const markerResponse = await client.messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 4096,
                messages: [{ role: "user", content: markerPrompt }],
              });

              const markerText = markerResponse.content[0].type === "text" ? markerResponse.content[0].text : "";
              const markerJsonMatch = markerText.match(/\{[\s\S]*\}/);
              if (markerJsonMatch) {
                const replacements: Record<string, string> = JSON.parse(markerJsonMatch[0]);
                // 全角変換（Word用）
                const fullWidthReplacements: Record<string, string> = {};
                for (const [key, val] of Object.entries(replacements)) {
                  if (typeof val !== "string") continue;
                  fullWidthReplacements[key] = toFullWidth(val);
                }
                const outputBuffer = replaceMarkedFields(wordBuffer, fullWidthReplacements);
                const outputName = `${company.name}_${baseName}.docx`;

                let previewHtml = "";
                try {
                  const result = await mammoth.convertToHtml({ buffer: outputBuffer });
                  previewHtml = result.value;
                } catch { /* ignore */ }

                documents.push({
                  name: baseName,
                  docxBase64: outputBuffer.toString("base64"),
                  previewHtml,
                  fileName: outputName,
                });
              }
            } else {
              // === 従来方式: プレースホルダーベース ===
              const filePlaceholders = extractPlaceholders(df.content);
              void filePlaceholders;
              const delims: [string, string] = ["{{", "}}"];

              const fileSets = getDataSetsForFile(df.content);
              for (let c = 0; c < fileSets.length; c++) {
                const templateData: Record<string, string | boolean> = {};
                for (const [key, val] of Object.entries(fileSets[c])) {
                  if (typeof val === "boolean") {
                    templateData[key] = val;
                  } else {
                    templateData[key] = stripDuplicatedUnit(val, key, df.content);
                  }
                }
                const zip = new PizZip(wordBuffer);
                for (const fileName of Object.keys(zip.files)) {
                  if (!fileName.endsWith(".xml") && !fileName.endsWith(".xml.rels")) continue;
                  const content = zip.file(fileName)?.asText();
                  if (!content) continue;
                  const normalized = content
                    .replace(/｛｛/g, "{{")
                    .replace(/｝｝/g, "}}")
                    .replace(/【/g, "{{")
                    .replace(/】/g, "}}");
                  if (normalized !== content) zip.file(fileName, normalized);
                }
                const doc = new Docxtemplater(zip, {
                  delimiters: { start: delims[0], end: delims[1] },
                  paragraphLoop: true,
                  linebreaks: true,
                  nullGetter: () => "（要確認）",
                });
                doc.render(templateData);
                const outputBuffer = doc.getZip().generate({ type: "nodebuffer" });

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
          }
        } catch (err) {
          console.error(`[produce] skipped template ${df.name}:`, err instanceof Error ? err.message : err);
          if (err instanceof Error && "properties" in err) {
            console.error(`[produce] docxtemplater properties:`, JSON.stringify((err as { properties: unknown }).properties, null, 2));
          }
        }
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
