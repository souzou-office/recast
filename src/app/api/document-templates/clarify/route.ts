import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { logTokenUsage } from "@/lib/token-logger";
import { loadThread } from "@/lib/thread-store";
import type { ClarificationQuestion } from "@/types";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

// テンプレートのプレースホルダーに対する確認質問を生成
//
// コスト設計（2026-04 改訂）:
// - 基本情報（profile）と案件整理（masterSheet）は、それ自体が「原本を AI が要約した確定情報」。
//   それらを渡しておきながら原本 PDF/テキストを重ねて送るのは本末転倒でトークンを食うだけ。
// - ここでは基本情報 + 案件整理テキスト + プレースホルダー一覧のみ送る。
//   「ここに無ければ人間に聞く」で十分で、原本の確認は案件整理ステップの責務。
//
// previousQA: これまでのQ&A履歴（ループで再質問する際に含める）
// knownMissing: 案件整理の出力で「値が *要確認*」になった項目名（必ず質問として出す）
export async function POST(request: NextRequest) {
  const { companyId, templateFolderPath, previousQA, knownMissing, threadId } = await request.json() as {
    companyId: string;
    templateFolderPath: string;
    previousQA?: { question: string; answer: string }[];
    folderPath?: string;      // 互換のため残すが使わない（thread.folderPath から取る）
    disabledFiles?: string[]; // 互換のため残すが使わない
    knownMissing?: string[];
    threadId?: string;
  };

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return NextResponse.json({ questions: [] });
  }

  // 案件整理は必ず「今話しているチャットスレッド」に紐付くものを使う。
  // company.caseRooms や company.masterSheet を拾うと別案件の情報が混入する。
  const thread = threadId ? await loadThread(company.id, threadId) : null;

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

  // 案件整理は thread のものだけを使う（案件ごとに独立、混ざらない）
  const masterSheet = thread?.masterSheet;
  const profile = company.profile;

  // デバッグ: 何が clarify に流れているかをサーバーコンソールに出す
  console.log("[clarify/debug] threadId =", threadId);
  console.log("[clarify/debug] thread loaded =", !!thread, "folderPath =", thread?.folderPath);
  console.log("[clarify/debug] masterSheet.content length =", masterSheet?.content?.length || 0);
  console.log("[clarify/debug] masterSheet.content preview =", masterSheet?.content?.slice(0, 200));
  console.log("[clarify/debug] profile has 変更履歴 =", !!profile?.変更履歴);
  console.log("[clarify/debug] profile has 辞任 string in structured =",
    JSON.stringify(profile?.structured || {}).includes("辞任"));
  console.log("[clarify/debug] memoText includes 辞任 =", memoText.includes("辞任"));
  console.log("[clarify/debug] globalMemo includes 辞任 =", globalMemo.includes("辞任"));
  console.log("[clarify/debug] globalMemo length =", globalMemo.length);
  console.log("[clarify/debug] globalMemo file count =",
    (globalMemo.match(/【共通ルール: /g) || []).length);
  console.log("[clarify/debug] templateFolderPath =", templateFolderPath);

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

  // 原本 PDF/テキストは送らない。基本情報と案件整理テキストが「原本から抽出した確定情報」
  // なので、同じ原本を重ねて送るのは本末転倒。
  //
  // system（固定・cache_control 対象）:
  //   共通ルール / テンプレート注意事項 / 基本情報 / 案件整理テキスト / 出力ルール・形式
  // user（可変）:
  //   プレースホルダー一覧 / これまでのQ&A / knownMissing
  const systemText = `あなたはテンプレートのプレースホルダーについて確認質問を作るアシスタントです。
会社データと案件整理テキストから値が特定できる項目は質問せず、不明・矛盾・「必ず質問する項目」だけをJSON配列で返してください。

${globalMemo ? `## 共通ルール（最優先で従うこと）\n${globalMemo}\n\n` : ""}${memoText ? `## テンプレート注意事項（このテンプレ固有のルール。質問の源泉）\n${memoText}\n\n` : ""}## 会社データ
${dataContext}
${masterSheet?.content ? `\n## 案件整理テキスト\n${masterSheet.content}\n` : ""}

## 重要な前提
- **共通フォルダ（定款・登記簿・株主名簿等）の情報は基本情報として確定済み**。ここに記載の日付・住所等は正しい前提で扱う
- **案件フォルダ（議事録・スケジュール・指示書等）の情報が今回の手続き内容**。スケジュール表に記載された日付はそのまま使う
- 共通フォルダと案件フォルダの情報が異なっても、それは矛盾ではなく「変更手続き」である
- **基本情報内の「過去の変更履歴」（辞任日、住所移転日、前任者氏名、旧所在地 等）は完了した事実**。今回の手続きとは無関係なので、**絶対に質問に含めない**。今回の案件整理テキストに記載されていることだけが今回の手続き内容。

## ルール

### 必須（必ず質問に含める）
- **「必ず質問する項目」リスト**: 案件整理で *要確認* となった項目。省略禁止。

### その上で追加してよい質問
- **テンプレート注意事項/共通ルールで明示的に「〜を確認すること」と書かれている項目**
- **案件フォルダ内の複数資料間で値が矛盾している**（専門家判断が必要）
- **複数の解釈が可能**（例: 役員が複数いて手続き対象者が特定できない）

### 質問してはいけないもの（厳守）
- **「必ず質問する項目」リストに無く、かつ基本情報／案件整理テキストに明確な値がある項目**
- **基本情報内の変更履歴・過去の辞任・過去の住所移転等、今回の手続きと関係ない過去の事実**
- **案件整理テキストに既に記載されている内容**（記載済み = 確定済み。そこから値を取るだけで質問不要）
- 表記ゆれレベルの違い（「株式会社」と「(株)」等はAIが正規化する）

### options の生成
各質問には可能な限り候補を 1〜3 件 options に含める:
- 案件整理テキスト（投資契約書・スケジュール表等から抽出した値）から推測される値を候補に
- それぞれ source に出典（どの資料か）を書く
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

  const userPrompt = `## プレースホルダー一覧
${placeholderList}
${qaBlock}${knownMissingBlock}
上記のプレースホルダーについて、確認が必要な項目だけを JSON 配列で返してください。`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [
        { type: "text", text: systemText, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userPrompt }],
    });
    logTokenUsage("/api/document-templates/clarify", MODEL, response.usage);
    console.log("[clarify/debug] previousQA count =", previousQA?.length || 0);
    console.log("[clarify/debug] previousQA items =", (previousQA || []).map(qa => qa.question.slice(0, 40)));
    console.log("[clarify/debug] knownMissing =", knownMissing);

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    // JSON パース: 完全な [ ... ] があればそれを使い、途切れていたら末尾を補って救出
    let questions: ClarificationQuestion[] = [];
    const fullMatch = text.match(/\[[\s\S]*\]/);
    if (fullMatch) {
      try {
        questions = JSON.parse(fullMatch[0]);
      } catch {
        /* fall through to truncation recovery */
      }
    }
    if (questions.length === 0) {
      // 途中で切れている場合: 最後の } までを拾って、リストとして閉じ直す
      const start = text.indexOf("[");
      const lastBrace = text.lastIndexOf("}");
      if (start >= 0 && lastBrace > start) {
        const patched = text.slice(start, lastBrace + 1) + "]";
        try {
          questions = JSON.parse(patched);
          console.log(`[clarify] recovered from truncated JSON: ${questions.length} questions`);
        } catch {
          /* give up */
        }
      }
    }

    console.log("[clarify/debug] AI returned questions =", questions.map(q => ({ placeholder: q.placeholder, q: q.question?.slice(0, 50) })));

    // previousQA に既に答えた質問を除外（AI が同じ質問を再生成してしまうケースへの安全網）
    if (previousQA && previousQA.length > 0 && questions.length > 0) {
      const answeredPlaceholders = new Set(
        previousQA.map(qa => {
          const m = qa.question.match(/【([^】]+)】/);
          return m ? m[1].trim() : "";
        }).filter(Boolean)
      );
      const before = questions.length;
      questions = questions.filter(q => !answeredPlaceholders.has(q.placeholder));
      if (before !== questions.length) {
        console.log(`[clarify] filtered ${before - questions.length} duplicate questions (already answered)`);
      }
    }

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
