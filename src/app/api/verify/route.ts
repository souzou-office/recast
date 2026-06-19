import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig } from "@/lib/folders";
import { logTokenUsage } from "@/lib/token-logger";
import {
  saveAiMessages,
  appendUserTurn,
  appendAssistantTurn,
  toAnthropicMessages,
} from "@/lib/case-conversation";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx");

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

// RECAST_ENGINE=officecli のとき、verify は officecli の機械チェック (view issues / validate) を
// 先に呼んで AI に渡す。AI は Tool Use で「どの paraId にどんなコメントを書くか」を出し、
// recast が officecli add comment で書類に直接書き込む。
function useOfficeCliEngine(): boolean {
  return process.env.RECAST_ENGINE === "officecli";
}

// AI が verify で出す「書類別コメント」の Tool 定義。
// 各書類について commentSpot[] (paraId + コメント text + 重要度) を出す。
const VERIFY_COMMENTS_TOOL: Anthropic.Tool = {
  name: "submit_verify_comments",
  description:
    "各書類に対する確認コメントを paraId 単位で構造化して提出する。" +
    "recast はこれを officecli add comment で書類に直接書き込む (Word ネイティブのコメント機能)。" +
    "確認事項が無い書類は entry を出さない。",
  input_schema: {
    type: "object",
    properties: {
      documents: {
        type: "array",
        description: "書類ごとのコメント一覧",
        items: {
          type: "object",
          properties: {
            fileName: {
              type: "string",
              description: "対象書類のファイル名 (生成書類 list で示されたもの)",
            },
            comments: {
              type: "array",
              description: "この書類に付ける確認コメント",
              items: {
                type: "object",
                properties: {
                  paraId: {
                    type: "string",
                    description: "対象段落の @paraId (officecli view text の出力から取れる、8文字の16進)",
                  },
                  severity: {
                    type: "string",
                    enum: ["info", "warn", "error"],
                    description: "info=軽い確認 / warn=要確認 / error=確実な不整合",
                  },
                  text: {
                    type: "string",
                    description: "コメント本文 (Word のレビュー機能で表示される)。簡潔に。",
                  },
                },
                required: ["paraId", "severity", "text"],
              },
            },
          },
          required: ["fileName", "comments"],
        },
      },
    },
    required: ["documents"],
  },
};

/**
 * 検証 = 「1案件1会話」のターン4。
 *
 * 旧設計: 検証担当 Claude を「はじめまして」状態で呼び、原本+生成書類+Q&A を毎回再送していた。
 *   この Claude は organize/clarify/produce で各値がどう判断されたかを知らないため、
 *   「これは organize で迷った末に選んだ値」のような文脈を持たずにチェックしていた。
 * 新設計: produce が会話に書き込んだ「自分が各書類の各スロットに入れた値」を、同じ Claude が
 *   ターン4で自己レビューする形にする。Claude は organize での迷い・clarify でユーザーに
 *   確認した結果を全て覚えているので、「自分が怪しいと思っていた所」を集中チェックできる。
 *
 * 注: 原本ファイルは organize（ターン1）で既に Claude に渡している。verify でも fileIds 経由で
 *   個別に追加できるが、通常は同じ案件資料が前提なので会話履歴のみで成立する。
 */

// 生成書類の base64 からテキストを抽出
async function extractDocumentText(base64: string, fileName: string): Promise<string> {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  try {
    const buffer = Buffer.from(base64, "base64");
    if (ext === "xlsx" || ext === "xlsm" || ext === "xls") {
      const wb = XLSX.read(buffer, { type: "buffer" });
      const parts: string[] = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        const csv: string = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        if (csv.trim()) parts.push(`[シート: ${sheetName}]\n${csv}`);
      }
      return parts.join("\n\n").trim();
    }
    const result = await mammoth.extractRawText({ buffer });
    return result.value?.trim() || "";
  } catch {
    return "";
  }
}

export async function POST(request: NextRequest) {
  const { companyId, threadId } = await request.json() as {
    companyId: string;
    fileIds?: string[]; // 互換のため残すが現在は未使用
    caseRoomId?: string; // 互換のため残すが現在は未使用
    threadId?: string;
    folderPath?: string;
    disabledFiles?: string[];
  };

  if (!threadId) {
    return new Response(JSON.stringify({ error: "threadId が必要です" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === companyId);
  if (!company) {
    return new Response(JSON.stringify({ error: "会社が見つかりません" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  // スレッドから生成書類を取得
  let threadDocs: { templateName: string; docxBase64: string; previewHtml: string; fileName: string; filledSlots?: { slotId: number; label: string; value: string }[] }[] = [];
  try {
    const fs = await import("fs/promises");
    const nodePath = await import("path");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require("crypto");
    const companyHash = crypto.createHash("md5").update(companyId).digest("hex");
    const threadFile = nodePath.default.join(process.cwd(), "data", "chat-threads", companyHash, `${threadId}.json`);
    const raw = await fs.default.readFile(threadFile, "utf-8");
    const thread = JSON.parse(raw);
    if (thread.generatedDocuments) threadDocs = thread.generatedDocuments;
  } catch { /* ignore */ }

  if (threadDocs.length === 0) {
    return new Response(JSON.stringify({ error: "生成済み書類がありません。先に書類を生成してください。" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // ★ verify は生成書類だけを入力にする (会話履歴・案件整理・原本資料は渡さない)。
  // 旧設計: loadAiMessages で 60k+ トークンの履歴を全部送ってた → cacheWrite $0.3 食ってた。
  // 新設計: 「全書類を見て横断的な整合性・明らかな誤りだけ指摘」に役割を絞る → 入力 ~30k に削減。
  // 履歴の代わりに空配列から始めて、user ターン 1 つ (生成書類 + 指示) だけ送る。

  // 生成書類のテキスト抽出 + filledSlots 一覧
  // OfficeCLI モードでは追加で officecli view text / issues / validate も AI に渡す。
  const generatedTexts: string[] = [];
  // OfficeCLI モード: 各書類を temp に書き出して paraId 付きで AI に渡す。後段の Tool Use で paraId を指定してもらう。
  const officecliWorkPaths = new Map<string, string>(); // fileName -> temp file path
  const useOfficeCli = useOfficeCliEngine();

  for (const doc of threadDocs) {
    const text = await extractDocumentText(doc.docxBase64, doc.fileName);
    if (!text) continue;
    let docBlock = `【生成書類: ${doc.fileName}】\n${text}`;
    const slots = doc.filledSlots;
    if (slots && slots.length > 0) {
      docBlock += `\n\n[この書類の項目一覧（slotId 付き）]\n` +
        slots
          .filter(s => s.value && s.value.trim())
          .map(s => `- slotId=${s.slotId}: ${s.label} = "${s.value}"`)
          .join("\n");
    }

    // xlsx の数式セル (=SUM 等) は、表示値が「前回計算時のキャッシュ」。officecli はセル値を書き換える
    // だけで再計算しないので、合計・割合が古い値 (前テンプレ案件の数字) のまま残る。ただし生成 xlsx には
    // fullCalcOnLoad を立ててあり (xlsx-cleanup)、Excel で開けば自動再計算されて正しくなる。
    // verify は Excel で開かず生の値を読むため、このキャッシュ値が個別値と合わず「合計が違う」と誤検知して
    // いた (株主リストの合計 24,756 問題)。どのセルが数式かはファイルに <f> として明記されているので機械的に
    // 特定でき、AI に「これらは指摘するな」と渡せる。個別値のチェックは従来どおり残るので安全。
    if (/\.(xlsx|xlsm|xls)$/i.test(doc.fileName)) {
      try {
        const { getXlsxFormulaCells } = await import("@/lib/xlsx-marker-parser");
        const formulaCells = getXlsxFormulaCells(Buffer.from(doc.docxBase64, "base64"));
        if (formulaCells.size > 0) {
          docBlock += `\n\n[★数式セル（自動計算）= 指摘しないこと★]\n` +
            `次のセルは =SUM 等の数式で、表示されている値は前回計算時のキャッシュにすぎない。` +
            `この xlsx は Excel で開くと全数式が自動再計算される設定 (fullCalcOnLoad) なので、開けば正しい値になる。` +
            `したがって、これらのセルの合計・割合が個別の値と一致しなくても誤りではない。` +
            `**これらの数式セルについては差異を指摘・コメントしないこと**:\n` +
            [...formulaCells].map((k) => `- ${k}`).join("\n");
        }
      } catch { /* 数式セル特定に失敗しても続行 (誤検知が残るだけ) */ }
    }

    // OfficeCLI モードでは追加情報を本文末尾に付与
    if (useOfficeCli) {
      try {
        const fs = await import("fs/promises");
        const os = await import("os");
        const nodePath = await import("path");
        const { runOfficeCli, copyToTemp } = await import("@/lib/officecli");
        // base64 → 一時 docx ファイル
        const buf = Buffer.from(doc.docxBase64, "base64");
        const tmpDir = nodePath.default.join(os.default.tmpdir(), "recast-verify");
        await fs.default.mkdir(tmpDir, { recursive: true });
        const tmpFile = nodePath.default.join(tmpDir, `${Date.now()}_${doc.fileName}`);
        await fs.default.writeFile(tmpFile, buf);
        officecliWorkPaths.set(doc.fileName, tmpFile);
        // paraId 付きテキスト取得
        const viewText = await runOfficeCli(["view", tmpFile, "text"]);
        if (viewText.exitCode === 0) {
          docBlock += `\n\n[OfficeCLI view text (paraId 付き、コメント貼付の参照用)]\n${viewText.stdout}`;
        }
        // 機械チェック (issues)
        const issues = await runOfficeCli(["view", tmpFile, "issues", "--limit", "30"]);
        if (issues.exitCode === 0 && issues.stdout.trim()) {
          docBlock += `\n\n[OfficeCLI view issues]\n${issues.stdout}`;
        }
        // validate
        const validate = await runOfficeCli(["validate", tmpFile]);
        if (validate.exitCode !== 0 || validate.stdout.trim()) {
          docBlock += `\n\n[OfficeCLI validate]\n${validate.stdout || validate.stderr}`;
        }
        // 不要 copy したテンプレを copyToTemp 経由でない場合に備えてフラグ用に保持
        void copyToTemp; // 参照: 後段で使う
      } catch (e) {
        console.warn(`[verify officecli] check failed for ${doc.fileName}:`, e instanceof Error ? e.message : e);
      }
    }

    generatedTexts.push(docBlock);
  }

  const userTurnText = `## あなたが今やること: 生成書類の横断チェック

下記が今回生成された全 ${threadDocs.length} 書類の本文です。
**書類同士を見比べて**、整合性が取れていないところ・明らかな誤りを指摘してください。

## 確認対象 (これだけ見ればよい)

1. **書類間の値の不一致** — 同じ意味の値が複数書類で違う
   例: 書類Aの代表取締役氏名「徳永優也」と書類Bで「徳永優」が混在
   例: 書類Aの日付「令和8年6月1日」と書類Bで「令和8年5月25日」が混在
2. **明らかな誤り / 異常**
   - 空欄・未入力 (★label★ がそのまま残ってる等)
   - 改行や整形がおかしい
   - 単位の抜け (金額に「円」がない 等)
   - タイポ・文字化け
3. **論理的におかしい組み合わせ**
   例: 代表取締役と取締役が同一人物の議案で別氏名
4. **1つの書類の中の「一読して変」な崩れ** ← 最重要。人間がその書類を1枚通して読めば当然気づくレベルの崩れを見る
   - **同じ人名・住所の不自然な重複**: 例) 同意欄に「代表取締役　川上登福」と「氏　名　川上登福」が
     両方ある＝同じ人が二重に書かれている。役割欄が重複・同じ値が並んでいる/連続している
   - **構造の崩れ・混在**: 不要な行が残っている、欄が二重になっている。特に **組合 (○○投資事業有限責任組合・
     ○○有限責任事業組合 等) が当事者なのに、その署名/同意欄が個人と同じ「住所＋氏名」形式のまま**で
     「主たる事務所・名称・無限責任組合員・組合員・代表取締役」の構造になっていない場合は崩れ
   - **別案件の残骸 (置換漏れ)**: 今回の案件の当事者でない会社名・人名・住所が紛れている。
     ヒント: 他の書類が全部同じ会社名・代表者で揃っているのに、**1 書類だけ別の社名・人名・住所**が
     出ていたら、前テンプレ案件のデータが置換されず残った残骸 (例: 全書類が当社なのに1枚だけ別会社名)

## 確認 *しない* もの (取り上げないこと)

- 原本資料 (今回入力されてない) との突合せ — それは別工程
- 条文番号や記号の揺れ (第1条/①/(1) 等)
- 全角半角の違い・空白・句読点の差
- テンプレ由来の見出し・定型文 (recast が触ってない部分)
- **xlsx の合計・割合など数式セル (=SUM 等) の値が個別値と合わない件** — これは「前回計算のキャッシュ値」で、
  Excel で開けば自動再計算されて正しくなる (fullCalcOnLoad 設定済み)。誤りではないので **指摘しない**
  (例: 株主リストの合計議決権が各株主の合計と違っても、それは開封前のキャッシュ。指摘不要)
- **発行日時点ではどちらも正しい値**が書類間で違うだけのもの — 例) 移転前に発送する提案書の差出人住所が
  旧本店、移転後に作る登記書類が新本店。日付的にどちらも正しいので「不一致」として指摘しない

## 出力

**Markdown チェックリスト形式**:

\`\`\`markdown
## 最終確認してほしいこと

### 1.取締役決定書
- [ ] 氏名「徳永優也」と書類2の「徳永優」が不一致、どちらが正しいか確認

### 2.臨時株主総会の提案書
- [ ] 払込金額「100,000」に円の単位がない
\`\`\`

ルール:
- 問題ない書類は見出しを出さない
- 全書類で問題なければ本文に **「最終確認が必要な事項は見つかりませんでした。」** だけ返す

## 生成書類

${generatedTexts.join("\n\n")}`;

  // 履歴は空 (生成書類だけ送る、コスト削減のため)
  const messagesWithUserTurn = appendUserTurn([], userTurnText, "verify");

  // 生成書類のファイル名も sourceFiles に追加（リンク用）
  const sourceFiles: { id: string; name: string; mimeType: string }[] = [];
  for (const doc of threadDocs) {
    sourceFiles.push({ id: `generated:${doc.fileName}`, name: `[生成] ${doc.fileName}`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ type: "meta", sourceFiles });

      try {
        // verify は 2 段階で AI を呼ぶ (本体チェックリスト + comments Tool Use)。
        // 1 回目の入力 (会話履歴 + 生成書類テキスト + officecli view text 等で 60-70k トークン) を
        // cache_control で明示 cache 化 → 2 回目は同じプレフィックスで cacheRead (10倍安い)。
        // これがないと 2 回 cacheWrite で $0.6 食う (前回ログ確認済)。
        const baseMessages = toAnthropicMessages(messagesWithUserTurn) as Anthropic.MessageParam[];
        // 最後の user メッセージに cache_control を付与 (プレフィックス確定マーカー)
        const lastIdx = baseMessages.length - 1;
        const lastMsg = baseMessages[lastIdx];
        if (lastMsg.role === "user" && typeof lastMsg.content === "string") {
          baseMessages[lastIdx] = {
            role: "user",
            content: [
              { type: "text", text: lastMsg.content, cache_control: { type: "ephemeral" } },
            ],
          };
        }
        const aiStream = client.messages.stream({
          model: MODEL,
          max_tokens: 8192,
          messages: baseMessages,
        });

        let assistantText = "";
        for await (const event of aiStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            assistantText += event.delta.text;
            send({ type: "text", text: event.delta.text });
          }
        }

        try {
          const final = await aiStream.finalMessage();
          logTokenUsage("/api/verify", MODEL, final.usage);
        } catch { /* ignore */ }

        // assistant ターンを保存
        const finalMessages = appendAssistantTurn(messagesWithUserTurn, assistantText, "verify");
        await saveAiMessages(company.id, threadId, finalMessages);

        // ===== OfficeCLI モード: Tool Use で構造化コメントを取って Word に書き込む =====
        // 上で得た markdown チェックリストとは別に、もう 1 回 AI を呼んで「どこに何のコメントを書くか」を
        // 構造化して受け取り、officecli add comment で書類に直接書き込む。
        // 結果として generatedDocuments の docxBase64 をコメント付きバージョンに置き換える。
        if (useOfficeCli && officecliWorkPaths.size > 0) {
          send({ type: "text", text: "\n\n---\n\n📝 書類にコメントを書き込んでいます...\n" });
          try {
            const commentPrompt = `## あなたが今やること (officecli モード)

直前で出した「最終確認すべきこと」のチェックリストを、各書類の Word ネイティブのコメント機能として
書類に直接書き込むため、構造化してください。**submit_verify_comments** ツールを呼んでください。

各コメントには対象段落の **@paraId** (前の入力で渡した [OfficeCLI view text] に \`[/body/p[@paraId=XXXXXXXX]] 本文\`
形式で記載されている、8文字の16進ID) と、簡潔な確認テキストを指定してください。

severity:
- error: 確実な不整合 (数字違い、氏名間違い等)
- warn: 要確認 (表記揺れ、書類間整合確認等)
- info: 軽い確認 (任意で目を通すレベル)

paraId は **必ず実在するもの** を指定 (前の入力で渡した view text に含まれていない paraId はダメ)。
内容が良ければわずかなコメントで OK。問題なしの書類は出力に含めない。`;

            // 2 回目の AI 呼び出し: 1 回目と同じ baseMessages (cache_control 付き) + AI 応答 +
            // comments 用 prompt の順で送る → 前半は cacheRead で 10倍安くなる。
            const commentMessages: Anthropic.MessageParam[] = [
              ...baseMessages,  // cache_control 付き、cacheRead される
              { role: "assistant", content: assistantText },  // 1 回目の AI 応答
              { role: "user", content: commentPrompt },  // 新規 (毎回違う指示)
            ];
            const commentResponse = await client.messages.create({
              model: MODEL,
              max_tokens: 8192,
              tools: [VERIFY_COMMENTS_TOOL],
              tool_choice: { type: "tool", name: "submit_verify_comments" },
              messages: commentMessages,
            });
            logTokenUsage("/api/verify (comments Tool Use)", MODEL, commentResponse.usage);

            const toolBlock = commentResponse.content.find(
              (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use"
            );

            if (toolBlock?.name === "submit_verify_comments") {
              const input = toolBlock.input as {
                documents?: { fileName: string; comments: { paraId: string; severity: string; text: string }[] }[];
              };
              const { applyCommands } = await import("@/lib/officecli");
              const fs = await import("fs/promises");

              let totalComments = 0;
              let totalFailed = 0;
              const updatedDocs: typeof threadDocs = [];
              const fileNameToDoc = new Map(threadDocs.map(d => [d.fileName, d]));

              for (const docSpec of input.documents || []) {
                const workPath = officecliWorkPaths.get(docSpec.fileName);
                const origDoc = fileNameToDoc.get(docSpec.fileName);
                if (!workPath || !origDoc) {
                  console.warn(`[verify officecli] target not found: ${docSpec.fileName}`);
                  continue;
                }
                // xlsx は body/paraId 構造が無いのでコメント書き込みスキップ (markdown チェックリストで報告)
                const isXlsxDoc = /\.(xlsx|xlsm|xls)$/i.test(docSpec.fileName);
                if (isXlsxDoc) {
                  console.log(`[verify officecli] skip ${docSpec.comments.length} comments for xlsx ${docSpec.fileName} (markdown checklist で通知)`);
                  continue;
                }
                // docx のみ: 1 書類分のコメントを officecli batch で一括追加。
                // 旧実装はコメント 1 件ごとに officecli を起動していたため、produce-v2 の
                // 14 書類並列直後で Word プロセスが枯渇し「コメントを書き込んでいます」で固まっていた。
                // batch なら 1 書類 = 1 プロセス・1 開閉で済む。
                if (!docSpec.comments || docSpec.comments.length === 0) continue;
                const commentCommands = docSpec.comments.map((c) => {
                  const prefix = c.severity === "error" ? "❌ " : c.severity === "warn" ? "⚠️ " : "ℹ️ ";
                  return {
                    command: "add" as const,
                    path: `/body/p[@paraId=${c.paraId}]`,
                    type: "comment",
                    props: { text: `${prefix}${c.text}`, author: "recast verify" },
                  };
                });
                // ★view 済みの workPath ではなく、原本から作った「view していない新コピー」に batch する★
                // verify は前段 (line ~200) で workPath を officecli view (text/issues/validate) 済み。
                // officecli は view/get したファイルを resident process で掴み、同一ファイルへの batch を
                // 【全コマンド success と報告するのに保存が一切反映されない】無言失敗を起こす (実機で再現確認。
                //  produce-v2 で組合書類が丸ごとテンプレのまま出た件と同根)。このため従来の
                //  「コメント書き込み完了: 成功 N 件」は嘘で、コメントは 1 つも保存されていなかった。
                // → view していない新しいファイルに原本 base64 を書き出し、それに batch する。
                const freshPath = `${workPath}.cmt.docx`;
                await fs.default.writeFile(freshPath, Buffer.from(origDoc.docxBase64, "base64"));
                const cmdResults = await applyCommands(freshPath, commentCommands);
                const okCount = cmdResults.filter((r) => r.ok).length;
                totalComments += okCount;
                totalFailed += commentCommands.length - okCount;
                cmdResults
                  .filter((r) => !r.ok)
                  .forEach((r) => console.warn(`[verify officecli] add comment failed for ${docSpec.fileName}: ${r.error}`));
                // 結果 docx を base64 で読み戻して generatedDocuments を更新する候補に
                try {
                  const newBuf = await fs.default.readFile(freshPath);
                  updatedDocs.push({
                    ...origDoc,
                    docxBase64: newBuf.toString("base64"),
                  });
                } catch (e) {
                  console.warn(`[verify officecli] readback failed: ${e instanceof Error ? e.message : e}`);
                }
              }

              if (totalComments > 0 || totalFailed > 0) {
                send({ type: "text", text: `\n→ コメント書き込み完了: 成功 ${totalComments} 件, 失敗 ${totalFailed} 件\n` });
              }

              // generatedDocuments を更新 (コメント付きで上書き)
              if (updatedDocs.length > 0) {
                try {
                  const fsLib = await import("fs/promises");
                  const nodePath = await import("path");
                  // eslint-disable-next-line @typescript-eslint/no-require-imports
                  const crypto = require("crypto");
                  const companyHash = crypto.createHash("md5").update(companyId).digest("hex");
                  const threadFile = nodePath.default.join(process.cwd(), "data", "chat-threads", companyHash, `${threadId}.json`);
                  const raw = await fsLib.default.readFile(threadFile, "utf-8");
                  const threadData = JSON.parse(raw);
                  if (Array.isArray(threadData.generatedDocuments)) {
                    const updatedFileNames = new Set(updatedDocs.map(d => d.fileName));
                    threadData.generatedDocuments = threadData.generatedDocuments.map((d: typeof threadDocs[number]) => {
                      if (updatedFileNames.has(d.fileName)) {
                        const replaced = updatedDocs.find(u => u.fileName === d.fileName);
                        return replaced ? { ...d, docxBase64: replaced.docxBase64 } : d;
                      }
                      return d;
                    });
                    threadData.updatedAt = new Date().toISOString();
                    await fsLib.default.writeFile(threadFile, JSON.stringify(threadData, null, 2), "utf-8");
                  }
                } catch (e) {
                  console.warn(`[verify officecli] thread update failed: ${e instanceof Error ? e.message : e}`);
                }
              }
            } else {
              send({ type: "text", text: "\n(コメントの構造化に失敗しました)\n" });
            }
          } catch (e) {
            console.warn("[verify officecli] comment phase failed:", e instanceof Error ? e.message : e);
            send({ type: "text", text: `\n(コメント書き込みフェーズでエラー: ${e instanceof Error ? e.message : e})\n` });
          }
        }

        send({ type: "done" });
      } catch (e) {
        send({ type: "error", error: e instanceof Error ? e.message : "突合せに失敗" });
      } finally {
        controller.close();
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
}
