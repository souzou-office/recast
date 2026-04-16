import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";
import type { ClarificationQuestion } from "@/types";

const client = new Anthropic();

// テンプレートのプレースホルダーに対する確認質問を生成
// previousQA: これまでのQ&A履歴（ループで再質問する際に含める）
export async function POST(request: NextRequest) {
  const { companyId, templateFolderPath, previousQA, folderPath, disabledFiles } = await request.json() as {
    companyId: string;
    templateFolderPath: string;
    previousQA?: { question: string; answer: string }[];
    folderPath?: string;
    disabledFiles?: string[];
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

  // AIにデータ矛盾・不明項目を検出させる
  const prompt = `以下の会社データとプレースホルダー一覧を比較して、確認が必要な項目だけをJSON配列で返してください。

${globalMemo ? `## 共通ルール（最優先で従うこと）\n${globalMemo}\n` : ""}
${memoText ? `## テンプレート注意事項（このテンプレ固有のルール。質問の源泉）\n${memoText}\n\n` : ""}
## 会社データ
${dataContext}
${masterSheet?.content ? `\n## 案件整理テキスト\n${masterSheet.content}\n` : ""}
${qaBlock}
## プレースホルダー一覧
${placeholderList}

## 重要な前提
- **共通フォルダ（定款・登記簿・株主名簿等）の情報は基本情報として確定済み**。ここに記載の日付・住所等は正しい前提で扱う
- **案件フォルダ（議事録・スケジュール・指示書等）の情報が今回の手続き内容**。スケジュール表に記載された日付はそのまま使う
- 共通フォルダと案件フォルダの情報が異なっても、それは矛盾ではなく「変更手続き」である

## ルール
**質問は「専門家の判断が必要で、データから一意に決まらない」場合だけに絞る**。素人が読んでもわかるような自明なことは聞かない。

### 質問してはいけないもの（これは絶対に聞かない）
- **会社名・住所・代表者名など、基本情報に明確に記載がある値**
- プレースホルダー名と基本情報の項目名が一致または明らかに対応するもの（「会社名」「代表取締役」等）
- 案件整理テキストや議事録に明記されている日付・金額・人名
- 共通フォルダ（定款・登記簿・株主名簿）に記載されている値
- 表記ゆれレベルの違い（「株式会社」と「(株)」等はAIが正規化して使う）
- プレースホルダー名から内容が推測できて、かつ対応データがある場合

### 質問してよいもの
1. **テンプレート注意事項/共通ルールで明示的に「〜を確認すること」と書かれている項目**
2. **案件フォルダ内の複数資料間で値が矛盾している**
3. **複数の解釈が可能**（例: 役員が複数いて手続き対象者が特定できない、日付が複数あってどれを使うか不明）
4. **テンプレートに必要な値が見つからない**（書類の作成に必要だが、提供された資料のどこにもない情報）
5. **既に回答された内容を受けて、新たに発生した確認事項**
6. **確信が持てない値**（推測はできるが間違っていたら書類が無効になるような重要な値）

### 判断のコツ
- 日付（届出日・決議日・就任日等）は**特に重要**。資料から明確に特定できない場合は必ず質問する
- 人名（誰が辞任するか、誰が就任するか等）も確信がなければ質問する
- **既に確定した値は再質問しない**
- 質問が0件なら空配列[]を返す

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
    if (!match) {
      return NextResponse.json({ questions: [] });
    }

    const questions: ClarificationQuestion[] = JSON.parse(match[0]);
    return NextResponse.json({ questions });
  } catch {
    return NextResponse.json({ questions: [] });
  }
}
