import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder } from "@/lib/files";
import { mimeFromExtension } from "@/lib/file-parsers";
import { isPathDisabled } from "@/lib/disabled-filter";
import { logTokenUsage } from "@/lib/token-logger";
import {
  loadAiMessages,
  saveAiMessages,
  truncateBeforeStage,
  appendUserTurn,
  appendAssistantTurn,
  toAnthropicMessages,
} from "@/lib/case-conversation";
import type { CaseAiContentBlock } from "@/types";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

/**
 * 案件整理 = 「1案件1会話」のターン1。
 *
 * 旧設計: 毎回ステートレスに Claude を呼んでいた。clarify/produce/verify は本ステップが
 *   作った「表」だけを引き継ぎ、その背後の判断・迷いは消えていた。
 * 新設計: スレッドの aiMessages にユーザーターン+アシスタント応答を追記する。
 *   後続ステップ（clarify/produce/verify）は同じ aiMessages にターンを足していくため、
 *   Claude は「自分が前のターンで何をどう判断したか」を全部覚えている。
 *
 * 再実行のときは aiMessages を「organize より前」に切り戻してからターンを追加する。
 */
export async function POST(request: NextRequest) {
  const { companyId, folderPath, disabledFiles, templateFolderPath, threadId } = await request.json() as {
    companyId: string;
    folderPath?: string;
    disabledFiles?: string[];
    templateFolderPath?: string;
    threadId?: string;
  };

  const config = await getWorkspaceConfig();
  const company = companyId
    ? config.companies.find(c => c.id === companyId)
    : config.companies.find(c => c.id === config.selectedCompanyId);

  if (!company) {
    return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });
  }

  // 全資料を収集
  // - allTexts:    案件資料（PDF以外のテキスト系。原本データ）
  // - caseRules:   案件フォルダ直下のメモ系ファイル（.txt/.md）→ 「案件ルール」として高優先度で渡す
  // - pdfFiles:    PDF/画像（base64）
  const allTexts: string[] = [];
  const caseRules: string[] = [];
  const pdfFiles: { name: string; base64: string; mimeType: string }[] = [];
  const sourceFiles: { id: string; name: string; mimeType: string }[] = [];

  // メモ系ファイル判定: .txt/.md 拡張子（ファイル名に「メモ」「ルール」を含むものは特に優先）
  const isMemoFile = (name: string): boolean => /\.(txt|md)$/i.test(name);

  if (folderPath) {
    // チャットのフォルダ選択カードで指定されたパスを読む
    const files = await readAllFilesInFolder(folderPath);
    const disabled = disabledFiles || [];
    for (const content of files) {
      // フォルダパスを disabledFiles に入れたとき、その配下全ファイルを除外するため
      // 完全一致ではなく prefix match (isPathDisabled) を使う。
      // 旧実装は disabled.includes(content.path) で完全一致だったため、
      // フォルダレベルの除外指定が効かず、未展開フォルダの中身まで AI に渡っていた。
      if (isPathDisabled(content.path, disabled)) continue;
      const ext = path.extname(content.name).toLowerCase();
      const mime = mimeFromExtension(ext);
      sourceFiles.push({ id: content.path, name: content.name, mimeType: mime });
      if (content.base64) {
        pdfFiles.push({ name: content.name, base64: content.base64, mimeType: content.mimeType || "application/pdf" });
      } else if (isMemoFile(content.name)) {
        // メモ/ルールは「案件ルール」として独立ブロックに格納（=高優先度で AI に届く）
        caseRules.push(`【案件ルール: ${content.name}】\n${content.content}`);
      } else {
        allTexts.push(`--- ${content.name} ---\n${content.content}`);
      }
    }
  } else {
    // フォールバック: sub.role === "job" && sub.active の案件フォルダ
    for (const sub of company.subfolders) {
      if (!(sub.role === "job" && sub.active)) continue;
      const files = await readAllFilesInFolder(sub.id);
      const disabled = sub.disabledFiles || [];
      for (const content of files) {
        if (isPathDisabled(content.path, disabled)) continue;
        const ext = path.extname(content.name).toLowerCase();
        const mime = mimeFromExtension(ext);
        sourceFiles.push({ id: content.path, name: content.name, mimeType: mime });
        if (content.base64) {
          pdfFiles.push({ name: content.name, base64: content.base64, mimeType: content.mimeType || "application/pdf" });
        } else if (isMemoFile(content.name)) {
          caseRules.push(`【案件ルール: ${content.name}】\n${content.content}`);
        } else {
          allTexts.push(`--- ${content.name} ---\n${content.content}`);
        }
      }
    }
  }

  if (allTexts.length === 0 && pdfFiles.length === 0 && caseRules.length === 0) {
    return NextResponse.json({ error: "案件フォルダに読み取れるファイルがありません" }, { status: 400 });
  }

  // 案件ルールブロック（あれば）
  const caseRulesBlock = caseRules.length > 0
    ? `\n## 案件ルール（この案件特有のルール、必ず従うこと）\n${caseRules.join("\n\n")}\n`
    : "";

  // テンプレ本体・ラベル一覧は Phase 1 では渡さない。
  // Phase 1 の役割は「実体判断」であって値の抽出ではないため、テンプレ詳細は不要。
  // 値の抽出は Phase 2 (書類生成) が案件ファイルを直接再読込して行う。
  //
  // ただし「案件タイプ」はテンプレフォルダ名から取得する。AI が
  // 「これは増資案件 / 役員変更 / ...」を識別するための文脈として使う。
  const caseType = templateFolderPath ? path.basename(templateFolderPath) : "";

  // 会社の基本情報（profile.structured）も参考データとして添付する
  const profileBlock = company.profile?.structured
    ? `\n## 会社の基本情報（参照データ）\n\`\`\`json\n${JSON.stringify(company.profile.structured, null, 2)}\n\`\`\`\n`
    : "";

  // 共通ルール（テンプレフォルダの上位にある共通ルール集 + テンプレ別注意事項メモ）を読む。
  // ターン1で渡しておけば clarify/produce/verify でも会話履歴経由で参照される。
  // 旧設計では各ステップが個別に loadGlobalRules していたが、会話化リファクタで execute に
  // 入れ忘れていた → 「共通ルールに書いた指示が無視される」バグの原因。
  let globalRulesBlock = "";
  if (templateFolderPath && config.templateBasePath) {
    try {
      const { loadGlobalRules } = await import("@/lib/global-rules");
      const rules = await loadGlobalRules(config.templateBasePath, templateFolderPath);
      if (rules && rules.trim()) {
        globalRulesBlock = `\n## 共通ルール（最優先で従うこと）\n${rules}\n`;
      }
    } catch { /* ignore */ }
  }

  // テンプレフォルダ内のメモファイル (.txt/.md) もテンプレ固有のルールとして渡す
  let templateMemoBlock = "";
  if (templateFolderPath) {
    try {
      const tpFiles = await readAllFilesInFolder(templateFolderPath);
      const memoText = tpFiles
        .filter(f => !f.base64 && (f.name.endsWith(".txt") || f.name.endsWith(".md")))
        .map(f => `【${f.name}】\n${f.content}`)
        .join("\n\n");
      if (memoText.trim()) {
        templateMemoBlock = `\n## テンプレート注意事項（このテンプレ固有のルール）\n${memoText}\n`;
      }
    } catch { /* ignore */ }
  }

  const caseTypeBlock = caseType
    ? `\n## 案件タイプ\n**${caseType}**\n（ユーザーが選択した書類テンプレフォルダ名から識別）\n`
    : "";

  const promptText = `あなたは司法書士事務所の書類作成担当者です。これからこの案件を **最初から最後まで** 1人で担当してもらいます。

今後の工程:
  ① 案件整理（実体判断）← 今ここ
  ② 不足判断・矛盾の確認質問を作る
  ③ 書類のスロットに入れる値を決める
  ④ 原本と生成書類を突き合わせて検証

各工程で、自分が前に何を判断したかを覚えておいてください。

**出力には「ターンN:」のような番号ラベルは付けない**。見出しと中身に集中する。

## あなたが今やること（① 案件整理 = 実体判断）

案件資料を **全部読んで** 実体を整理してください。司法書士が「これ何の案件？事実関係どうなってる？」を
把握するための整理。

### 整理のポイント

- 案件構造の判断（例: 第三者割当 / 株主割当、現金 / 現物、特別決議要件の充足等）
- 議題構成の判断（必要な議案 / 不要な議案）
- 当事者・関係者（複数資料で一致しているか）
- 日程（資料に書かれている日付は全部把握する。スケジュール表があれば各タスクの日付を読む）
- その他、案件の理解に必要なこと

### ⚠ 要確認事項に積むのは何か

⚠ は「**資料から本当に分からない / 業務判断が必要**」なものだけ。次のものは **積まない**:

- 資料に書かれている値・日付・事実（複数資料間で食い違いが無いなら、整理サマリーに書くだけ）
- 基本情報・登記簿・株主名簿に明示されている事実（例: 「藤崎が代表取締役」が基本情報にあるなら、
  「引き続き代表取締役か？」は変更を示唆する資料がある時だけ ⚠）

迷ったら「資料を全部読み返して、本当にどこにも書かれてないか」を確認してから ⚠ に積むこと。

### 値の精密性について

氏名のフルネームスペル・住所の番地等の **細かい文字列の精密さ** は次のターンが案件ファイルを直接
再読込して取り直すので、このターンでは「ざっくり把握」でOK（資料が読めない / 文字が掠れている等で
正確に拾えなくても、整理は進めて構わない）。ただし「読まない」「無視する」という意味ではない。

${caseTypeBlock}
${globalRulesBlock}
${templateMemoBlock}
${caseRulesBlock}
${profileBlock}

## 出力フォーマット（必ずこの形式で）

セクション付き Markdown で出力する。事実をセクション化するのは **AI（あなた）の判断**。
案件タイプから「よくあるセクション」を頭に置きつつ、事実次第で柔軟にセクションを増減してよい。

**先頭**: 1 文の「今回の手続き要約」を書く

**中段**: セクション付き判断サマリー。例：

\`\`\`
## 案件構造の判断
- 募集方法: 第三者割当（投資契約書・取締役会議事録で一致）
- 必要な決議: 取締役会 + 株主総会特別決議
- 公開/非公開: 非公開会社
- 取締役会設置: あり

## 議題構成の判断
- 募集事項の決定: 必要
- 払込期日の決定: 必要
- 役員報酬議案: 今回該当なし
- 監査役関連議案: 今回該当なし

## 整合性チェック
- 発行会社・引受人: 資料間で一致 ✓
- 取締役会決議日: ⚠ 食い違い検出
  - 投資契約書: 令和8年5月20日
  - スケジュール表: 令和8年5月22日
\`\`\`

**末尾**: \`## ⚠ 要確認事項\` リスト（**最大10件程度**）。各項目は番号付き＋根拠付き：

\`\`\`
## ⚠ 要確認事項
1. 取締役会決議日: 5/20（投資契約書）vs 5/22（スケジュール表）、どちらが正？
2. 引受人「××株式会社」の正式商号確認（登記資料が見当たらず）
3. 株主総会基準日の公告予定日が資料に未記載
4. ...
\`\`\`

### 要確認事項に積むべきもの
- (a) 複数資料で値が食い違う（矛盾検出）
- (b) どの資料にも書かれてない（欠落検出）
- (c) 業務判断が要る（規範的判断、例: 「就任承諾書は別途準備されますか？」）
- (d) 形式が曖昧で解釈ぶれが起きうる

### 注意
- **値の精密性は気にしなくていい**（金額の数字、氏名スペル、住所の細部は後段で再読込される）
- **セクション数は固定じゃない**。事実に応じて 3〜6 セクション程度で柔軟に
- **判断と事実を区別する**: 「○○である」（事実）と「○○と判断される」（判断）は意識して書く

## 案件資料
${allTexts.join("\n\n")}`;

  // ターン1のユーザー content: PDF添付 + プロンプトテキスト
  const userTurnContent: CaseAiContentBlock[] = [];
  for (const pdf of pdfFiles) {
    if (pdf.mimeType === "application/pdf") {
      userTurnContent.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
        title: pdf.name,
      });
    }
  }
  userTurnContent.push({ type: "text", text: promptText });

  // 既存 aiMessages を読み込み、organize より前に切り戻す（再実行対応）
  const priorMessages = threadId
    ? truncateBeforeStage(await loadAiMessages(company.id, threadId), "organize")
    : [];
  const messagesWithUserTurn = appendUserTurn(priorMessages, userTurnContent, "organize");

  try {
    const encoder = new TextEncoder();
    const send = (controller: ReadableStreamDefaultController, data: object) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    };
    const stream = new ReadableStream({
      async start(controller) {
        try {
          send(controller, { type: "meta", sourceFiles });
          send(controller, { type: "stage", stage: "organizing" });

          const aiStream = client.messages.stream({
            model: MODEL,
            max_tokens: 8192,
            temperature: 0,
            messages: toAnthropicMessages(messagesWithUserTurn) as Anthropic.MessageParam[],
          });

          let assistantText = "";
          for await (const event of aiStream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              assistantText += event.delta.text;
              send(controller, { type: "text", text: event.delta.text });
            }
          }

          try {
            const final = await aiStream.finalMessage();
            logTokenUsage("/api/templates/execute", MODEL, final.usage);
          } catch { /* ignore */ }

          // assistant ターンを保存（次の clarify/produce/verify が読む）
          if (threadId) {
            const finalMessages = appendAssistantTurn(messagesWithUserTurn, assistantText, "organize");
            await saveAiMessages(company.id, threadId, finalMessages);
          }

          send(controller, { type: "done" });
        } catch (e) {
          // ERR_EMPTY_RESPONSE 防止: 例外を必ず SSE で返してから close する
          const errMsg = e instanceof Error ? `${e.message}\n${e.stack || ""}` : String(e);
          console.error("[execute] stream failed:", errMsg);
          try { send(controller, { type: "error", error: e instanceof Error ? e.message : "実行に失敗" }); } catch { /* controller already closed */ }
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "実行に失敗しました" },
      { status: 500 }
    );
  }
}
