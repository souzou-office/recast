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

  // ハイライト方式のテンプレ用に .labels.json から豊かなラベルを取得
  // execute と同じくテンプレ解釈キャッシュを使い、「人名」程度ではなく
  // 「代表取締役の氏名」「取締役決定書の作成日」のような具体的なラベルで質問を作る。
  type RichLabel = { docName: string; label: string; format: string; sourceHint?: string };
  const richLabels: RichLabel[] = [];
  if (allPlaceholders.size === 0) {
    const { ensureDocxLabels, ensureXlsxLabels } = await import("@/lib/template-labels");
    for (const tf of templateFiles) {
      if (tf.base64) continue;
      const ext = tf.name.toLowerCase().split(".").pop() || "";
      const baseName = tf.name.replace(/\.[^.]+$/, "");
      let labels;
      if (ext === "docx" || ext === "docm") labels = await ensureDocxLabels(tf.path);
      else if (ext === "xlsx" || ext === "xlsm" || ext === "xls") labels = await ensureXlsxLabels(tf.path);
      if (!labels) continue;
      const seen = new Set<string>();
      for (const s of labels.slots) {
        if (!s.label || s.label === "不明" || seen.has(s.label)) continue;
        seen.add(s.label);
        richLabels.push({ docName: baseName, label: s.label, format: s.format, sourceHint: s.sourceHint });
      }
    }
    if (richLabels.length === 0) {
      return NextResponse.json({ questions: [] });
    }
  }

  // 案件整理は thread のものだけを使う（案件ごとに独立、混ざらない）
  const masterSheet = thread?.masterSheet;
  const profile = company.profile;

  const dataContext = JSON.stringify({
    基本情報: profile?.structured || {},
    案件情報: masterSheet?.structured || {},
  }, null, 2);

  // プレースホルダーまたはハイライトフィールドのリスト
  // ハイライト方式は .labels.json の豊かなラベル（書類別 + 形式 + 出典）を使う
  let placeholderList: string;
  if (allPlaceholders.size > 0) {
    placeholderList = Array.from(allPlaceholders).join(", ");
  } else {
    const byDoc: Record<string, RichLabel[]> = {};
    for (const r of richLabels) {
      if (!byDoc[r.docName]) byDoc[r.docName] = [];
      byDoc[r.docName].push(r);
    }
    const lines: string[] = [];
    for (const [doc, labels] of Object.entries(byDoc)) {
      lines.push(`### ${doc}`);
      for (const l of labels) {
        const parts = [`- **${l.label}**`];
        if (l.format) parts.push(`形式: \`${l.format}\``);
        if (l.sourceHint) parts.push(`出典候補: ${l.sourceHint}`);
        lines.push(parts.join(" | "));
      }
    }
    placeholderList = lines.join("\n");
  }

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
    //
    // 重複判定はラベル名をゆるく正規化（カッコ・記号・空白を除去）してから比較。
    // 「日付（株主リスト（6-2）証明書作成日）」と「株主リスト（6-2）の証明書作成日」は
    // 同じ項目を指しているので、片方が AI 生成で出ていれば auto 追加はしない。
    const normalize = (s: string): string =>
      s.replace(/[（）\(\)【】「」『』《》<>\[\]/／\\\\\-－‐ー−・,，、。\s　]/g, "")
        .replace(/^日付/, "")
        .replace(/の値$/, "");

    if (knownMissing && knownMissing.length > 0) {
      const answeredNormalized = new Set(
        (previousQA || []).map(qa => {
          const m = qa.question.match(/【([^】]+)】/);
          return normalize(m ? m[1] : "");
        }).filter(Boolean)
      );
      const existingNormalized = new Set([
        ...questions.map(q => normalize(q.placeholder || "")),
        ...questions.map(q => normalize(q.question || "")),
      ].filter(Boolean));

      for (const missing of knownMissing) {
        const norm = normalize(missing);
        if (!norm) continue;
        if (answeredNormalized.has(norm)) continue;
        // 既存の質問にラベルが含まれていれば追加しない（緩い包含一致でも）
        const alreadyCovered = existingNormalized.has(norm) ||
          [...existingNormalized].some(e => e.includes(norm) || norm.includes(e));
        if (!alreadyCovered) {
          questions.push({
            id: `auto_${questions.length + 1}`,
            placeholder: missing,
            question: `${missing} の値を入力してください（案件整理で特定できませんでした）`,
            options: [],
          });
          existingNormalized.add(norm);
        }
      }
    }

    return NextResponse.json({ questions });
  } catch {
    return NextResponse.json({ questions: [] });
  }
}
