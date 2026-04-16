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
  const { companyId, templateFolderPath, mode, caseRoomId, masterContent: directMasterContent, confirmedAnswers } = await request.json() as {
    companyId: string;
    templateFolderPath: string;
    mode?: "fill" | "generate";
    caseRoomId?: string;
    masterContent?: string;
    confirmedAnswers?: Record<string, string>;
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
      docxFiles.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
      for (const df of docxFiles) {
        try {
          const ext = df.name.toLowerCase().split(".").pop() || "";
          const rawBuffer = await fs.readFile(df.path);
          const baseName = df.name.replace(/\.[^.]+$/, "");
          if (ext === "xlsx" || ext === "xls") continue; // Excel はハイライト方式非対応
          let wordBuffer = rawBuffer;
          const isOldDoc = ext === "doc" || ext === "docm";
          if (isOldDoc) {
            const docxPath = df.path.replace(/\.(doc|docm)$/i, ".docx");
            const fsSync = require("fs");
            if (fsSync.existsSync(docxPath)) wordBuffer = fsSync.readFileSync(docxPath);
            else continue;
          }
          const { extractMarkedFields: emf, replaceMarkedFields, getMarkedDocumentText } = await import("@/lib/docx-marker-parser");
          const markedFields = emf(wordBuffer);
          if (markedFields.length === 0) continue;

          // 文書全体を★マーク付きで取得（AIが文脈を見ながら判断できるように）
          const markedDocText = getMarkedDocumentText(wordBuffer);

          // コメント付きフィールドのリスト（補足情報として）
          const commentList = markedFields
            .filter(f => f.comment)
            .map(f => `- ★${f.originalValue}★ → ${f.comment}`)
            .join("\n");

          // 共通・案件フォルダの原本ファイルを content blocks で送る
          type HLContentBlock =
            | { type: "text"; text: string }
            | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string }
            | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
          const IMAGE_MIMES_HL = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
          const hlContentBlocks: HLContentBlock[] = [];
          const hlSourceTexts: string[] = [];

          for (const sub of company.subfolders) {
            const isActive = sub.role === "common" || (sub.role === "job" && sub.active);
            if (!isActive) continue;
            const disabled = sub.disabledFiles || [];
            const { isPathDisabled } = await import("@/lib/disabled-filter");
            const subFiles = await readAllFilesInFolder(sub.id);
            for (const fc of subFiles) {
              if (isPathDisabled(fc.path, disabled)) continue;
              const roleTag = sub.role === "common" ? "[共通]" : "[案件]";
              if (fc.base64) {
                const mime = fc.mimeType || "application/pdf";
                if (mime === "application/pdf") {
                  hlContentBlocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: fc.base64 }, title: `${roleTag} ${fc.name}` });
                } else if (IMAGE_MIMES_HL.has(mime)) {
                  hlContentBlocks.push({ type: "image", source: { type: "base64", media_type: mime, data: fc.base64 } });
                }
              } else {
                hlSourceTexts.push(`【${roleTag} ${fc.name}】\n${fc.content}`);
              }
            }
          }
          // thread.folderPath の案件フォルダも読む（sub.activeでない場合）
          if (templateFolderPath) {
            // templateFolderPath は書類テンプレのパスなので、案件フォルダのパスではない
            // 案件フォルダは company.subfolders から取得済み
          }

          const markerPrompt = `あなたは司法書士事務所の書類作成担当です。
以下は過去案件の完成書類をテンプレートとして使ったものです。★マーク★で囲まれた部分が「可変箇所」（前案件の値が入っている場所）です。

この書類を上から通して読み、★マーク★の各箇所が書類の文脈上どのような意味の値なのか判断してください。
その上で、今回の案件データ（下記の原本ファイル・基本情報・案件整理テキスト）から正しい値を見つけて差し替えてください。

## 書類テンプレート（★マーク★部分が差し替え対象）
${markedDocText}
${commentList ? `\n## コメント補足（★部分の意味のヒント）\n${commentList}\n` : ""}

## 今回の案件データ
### 基本情報（会社の登記情報等）
${dataContext}
${directMasterContent ? `\n### 案件整理テキスト（今回の手続き内容）\n${directMasterContent}\n` : masterSheet?.content ? `\n### 案件整理テキスト\n${masterSheet.content}\n` : ""}
${globalMemo ? `\n### 共通ルール\n${globalMemo}\n` : ""}
${memoText ? `\n### テンプレート注意事項\n${memoText}\n` : ""}
${confirmedAnswers && Object.keys(confirmedAnswers).length > 0 ? `\n### ユーザー確定済みの値\n${Object.entries(confirmedAnswers).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n` : ""}

### 原本ファイル（共通フォルダ・案件フォルダの資料）
${hlSourceTexts.join("\n\n")}

## 回答形式
★マーク★の元の値をキー、新しい値をバリューとするJSONで返してください。値は必ず文字列で。
同じ元の値が複数箇所に出現する場合でも、書類内の位置によって意味が異なることがあります（例: 同じ日付でも「決定日」と「届出日」で違う値になる場合）。その場合は文脈から正しい値を判断してください。

例: {"株式会社HIBARI": "株式会社ABC", "佐藤 羽瑠": "山田太郎", "令和８年３月２７日": "令和７年１月１５日"}

重要:
- **書類を上から通して読み、各★の位置が何を指すか文脈から正確に判断する**
- 元の値の「型」（日付の書式、全角/半角、数値の桁区切り等）を維持すること
- 原本ファイル・基本情報・案件整理テキストに書いてある情報は必ず使い、「要確認」にしない
- どこにも見つからない情報だけ "（要確認）" とすること`;

          hlContentBlocks.push({ type: "text", text: markerPrompt });

          const markerResponse = await client.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            messages: [{ role: "user", content: hlContentBlocks as Anthropic.ContentBlockParam[] }],
          });
          const markerText = markerResponse.content[0].type === "text" ? markerResponse.content[0].text : "";
          const markerJsonMatch = markerText.match(/\{[\s\S]*\}/);
          if (!markerJsonMatch) continue;

          const replacements: Record<string, string> = {};
          for (const [k, v] of Object.entries(JSON.parse(markerJsonMatch[0]))) {
            if (typeof v !== "string") continue;
            // AIが★マーク★をキーに含めて返す場合があるので除去
            const cleanKey = k.replace(/★/g, "");
            replacements[cleanKey] = toFullWidth(v);
          }
          console.log("[produce/highlight] fields:", markedFields.map(f => `"${f.originalValue}"`).join(", "));
          console.log("[produce/highlight] AI replacements:", JSON.stringify(replacements, null, 2));
          // マッチ確認
          for (const f of markedFields) {
            if (replacements[f.originalValue]) {
              console.log(`[produce/highlight] MATCH: "${f.originalValue}" -> "${replacements[f.originalValue]}"`);
            } else {
              console.log(`[produce/highlight] MISS: "${f.originalValue}" (no replacement found)`);
            }
          }
          const outputBuffer = replaceMarkedFields(wordBuffer, replacements);
          const outputName = `${company.name}_${baseName}.docx`;
          let previewHtml = "";
          try { previewHtml = (await mammothHL.convertToHtml({ buffer: outputBuffer })).value; } catch { /* ignore */ }
          documentsHL.push({ name: baseName, docxBase64: outputBuffer.toString("base64"), previewHtml, fileName: outputName });
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
