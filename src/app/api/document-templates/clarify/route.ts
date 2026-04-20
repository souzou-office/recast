import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";
import type { ClarificationQuestion } from "@/types";

const client = new Anthropic();

// テンプレートのプレースホルダーに対する確認質問を生成
// previousQA: これまでのQ&A履歴（ループで再質問する際に含める）
// knownMissing: 案件整理の出力で「値が *要確認*」になった項目名（必ず質問として出す）
export async function POST(request: NextRequest) {
  const { companyId, templateFolderPath, previousQA, folderPath, disabledFiles, knownMissing } = await request.json() as {
    companyId: string;
    templateFolderPath: string;
    previousQA?: { question: string; answer: string }[];
    folderPath?: string;
    disabledFiles?: string[];
    knownMissing?: string[];
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ questions: [] });
  }

  // テンプレートファイルを読み込み
  const templateFiles = await readAllFilesInFolder(templateFolderPath);

  // テンプレートフォルダ内のテキストメモ（ルール・注意事項）を収集
  // ここに書かれている指示が「何を確認すべきか」の源泉になる
  const memoText = templateFiles
    .filter(f => !f.base64 && (f.name.endsWith(".txt") || f.name.endsWith(".md")))
    .map(f => `【${f.name}】\n${f.content}`)
    .join("\n\n");

  // 共通ルールフォルダの再帰読み込み
  const { loadGlobalRules } = await import("@/lib/global-rules");
  const globalMemo = await loadGlobalRules(config.templateBasePath, templateFolderPath);

  // プレースホルダーを抽出
  const allPlaceholders = new Set<string>();
  const patterns = [
    /【([^】]+)】/g,
    /\{\{([^}]+)\}\}/g,
    /｛｛([^｝]+)｝｝/g,
  ];
  for (const tf of templateFiles) {
    if (tf.base64) continue;
    for (const p of patterns) {
      let m;
      const regex = new RegExp(p.source, p.flags);
      while ((m = regex.exec(tf.content)) !== null) {
        allPlaceholders.add(m[1].trim());
      }
    }
  }

  // ハイライト方式のテンプレートかチェック
  let markedFieldDescs: string[] = [];
  if (allPlaceholders.size === 0) {
    // プレースホルダーなし → ハイライト方式かもしれない
    const { extractMarkedFields } = await import("@/lib/docx-marker-parser");
    for (const tf of templateFiles) {
      if (tf.base64) continue;
      const ext = tf.name.toLowerCase().split(".").pop() || "";
      if (ext !== "docx") continue;
      try {
        const fsLib = await import("fs/promises");
        const buf = await fsLib.readFile(tf.path);
        const fields = extractMarkedFields(buf);
        for (const f of fields) {
          // コメントがあればそのまま使う。なければ値の「種類」を推定（元の値自体は渡さない＝前案件のデータだから）
          let desc: string;
          if (f.comment) {
            desc = f.comment;
          } else {
            const v = f.originalValue;
            if (/年.*月.*日|令和|平成/.test(v)) desc = "日付（決定日・届出日・払込期日等）";
            else if (/都|道|府|県|市|区|町|丁目|番/.test(v)) desc = "住所";
            else if (/株式会社|有限|合同|組合/.test(v)) desc = "法人名";
            else if (/[，,]\d{3}/.test(v) || /^\d+$/.test(v.replace(/[，,]/g, ""))) desc = "数値（株数・金額等）";
            else desc = "人名";
          }
          if (!markedFieldDescs.includes(desc)) markedFieldDescs.push(desc);
        }
      } catch { /* ignore */ }
    }
    if (markedFieldDescs.length === 0) {
      return NextResponse.json({ questions: [] });
    }
  }

  // マスターシートとプロファイル
  const caseRoom = company.caseRooms?.find(r => r.masterSheet);
  const masterSheet = caseRoom?.masterSheet || company.masterSheet;
  const profile = company.profile;

  const dataContext = JSON.stringify({
    基本情報: profile?.structured || {},
    案件情報: masterSheet?.structured || {},
  }, null, 2);

  // プレースホルダーまたはハイライトフィールドのリスト
  const placeholderList = allPlaceholders.size > 0
    ? Array.from(allPlaceholders).join(", ")
    : markedFieldDescs.map(d => `「${d}」`).join(", ");

  // これまでのQ&Aを前提として追加
  const qaBlock = previousQA && previousQA.length > 0
    ? `\n## これまでの確認結果（既に確定済み。再質問しないこと）\n` +
      previousQA.map(qa => `- Q: ${qa.question}\n  A: ${qa.answer}`).join("\n") + "\n"
    : "";

  // 案件整理の出力で *要確認* になっている項目（確実に聞く）
  const knownMissingBlock = (knownMissing && knownMissing.length > 0)
    ? `\n## 必ず質問する項目（案件整理で *要確認* になったもの）\n${knownMissing.map(m => `- ${m}`).join("\n")}\n\nこの項目は全て質問リストに含めてください。必要に応じて、資料から推測される候補を options に入れて選択肢として提示します。\n`
    : "";

  // AIにデータ矛盾・不明項目を検出させる
  const prompt = `以下の会社データとプレースホルダー一覧を比較して、確認が必要な項目だけをJSON配列で返してください。

${globalMemo ? `## 共通ルール（最優先で従うこと）\n${globalMemo}\n` : ""}
${memoText ? `## テンプレート注意事項（このテンプレ固有のルール。質問の源泉）\n${memoText}\n\n` : ""}
## 会社データ
${dataContext}
${masterSheet?.content ? `\n## 案件整理テキスト\n${masterSheet.content}\n` : ""}
${qaBlock}
${knownMissingBlock}
## プレースホルダー一覧
${placeholderList}

## 重要な前提
- **共通フォルダ（定款・登記簿・株主名簿等）の情報は基本情報として確定済み**。ここに記載の日付・住所等は正しい前提で扱う
- **案件フォルダ（議事録・スケジュール・指示書等）の情報が今回の手続き内容**。スケジュール表に記載された日付はそのまま使う
- 共通フォルダと案件フォルダの情報が異なっても、それは矛盾ではなく「変更手続き」である

## ルール

### 必須（必ず質問に含める）
- **「必ず質問する項目」リスト**: 案件整理で *要確認* となった項目。省略禁止。

### その上で追加してよい質問
- **テンプレート注意事項/共通ルールで明示的に「〜を確認すること」と書かれている項目**
- **案件フォルダ内の複数資料間で値が矛盾している**（専門家判断が必要）
- **複数の解釈が可能**（例: 役員が複数いて手続き対象者が特定できない）

### 質問してはいけないもの
- **「必ず質問する項目」リストに無く、かつ基本情報／案件整理テキストに明確な値がある項目**
- 表記ゆれレベルの違い（「株式会社」と「(株)」等はAIが正規化する）

### options の生成
各質問には可能な限り候補を 1〜3 件 options に含める:
- 案件資料（投資契約書・スケジュール表等）から推測される値を候補に
- それぞれ source に出典（どのファイルのどこか）を書く
- 手動入力ができる（フロントエンドが自動で追加）ので、分からなければ空の options でも可

## 出力形式（JSONのみ）
[
  {
    "id": "q1",
    "placeholder": "プレースホルダー名",
    "question": "質問文",
    "options": [
      { "id": "a1", "label": "選択肢の値", "source": "出典（登記簿 2024/03等）" },
      { "id": "a2", "label": "別の選択肢", "source": "出典" }
    ]
  }
]`;

  // 共通・案件フォルダの原本ファイルを content blocks として添付（AIが生データも参照できるように）
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
  const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  const contentBlocks: ContentBlock[] = [];
  const sourceTexts: string[] = [];

  // 共通フォルダ（role === "common"）＋ チャットで指定された案件フォルダを読む
  const readFromSub = async (subId: string, subDisabled: string[], roleTag: string) => {
    const files = await readAllFilesInFolder(subId);
    for (const fc of files) {
      if (isPathDisabled(fc.path, subDisabled)) continue;
      if (fc.base64) {
        const mime = fc.mimeType || "application/pdf";
        if (mime === "application/pdf") {
          contentBlocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: fc.base64 }, title: `${roleTag} ${fc.name}` });
        } else if (IMAGE_MIMES.has(mime)) {
          contentBlocks.push({ type: "image", source: { type: "base64", media_type: mime, data: fc.base64 } });
        }
      } else {
        sourceTexts.push(`【${roleTag} ${fc.name}】\n${fc.content}`);
      }
    }
  };

  for (const sub of company.subfolders) {
    if (sub.role !== "common") continue;
    await readFromSub(sub.id, sub.disabledFiles || [], "[共通]");
  }
  if (folderPath) {
    // チャットで選択された案件フォルダ（sub.activeではなくthread.folderPathを使用）
    await readFromSub(folderPath, disabledFiles || [], "[案件]");
  } else {
    // フォールバック: sub.active な案件フォルダ
    for (const sub of company.subfolders) {
      if (!(sub.role === "job" && sub.active)) continue;
      await readFromSub(sub.id, sub.disabledFiles || [], "[案件]");
    }
  }

  const fullPrompt = sourceTexts.length > 0
    ? `${prompt}\n\n## 原本ファイル（テキスト抽出済み）\n${sourceTexts.join("\n\n")}`
    : prompt;
  contentBlocks.push({ type: "text", text: fullPrompt });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{ role: "user", content: contentBlocks as Anthropic.ContentBlockParam[] }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\[[\s\S]*\]/);
    let questions: ClarificationQuestion[] = match ? JSON.parse(match[0]) : [];

    // 安全網: knownMissing にあるのに AI が質問に含め忘れた項目を追加
    // （AI が ignoring したり整理で名前ブレしたりしても、案件整理で *要確認* だった項目は必ず聞く）
    if (knownMissing && knownMissing.length > 0) {
      const answered = new Set((previousQA || []).map(qa => qa.question.replace(/【([^】]+)】.*/, "$1")));
      for (const missing of knownMissing) {
        if (answered.has(missing)) continue; // 既に回答済み
        const exists = questions.some(q =>
          q.placeholder === missing ||
          (q.question && q.question.includes(missing))
        );
        if (!exists) {
          questions.push({
            id: `auto_${questions.length + 1}`,
            placeholder: missing,
            question: `${missing} の値を入力してください（案件整理で特定できませんでした）`,
            options: [],
          });
        }
      }
    }

    return NextResponse.json({ questions });
  } catch {
    return NextResponse.json({ questions: [] });
  }
}
