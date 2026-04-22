import Anthropic from "@anthropic-ai/sdk";
import type { FileContent, CompanyProfile, Company } from "@/types";
import { readFileContent } from "@/lib/files";
import { logTokenUsage } from "@/lib/token-logger";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `あなたはバックオフィス業務を支援するAIアシスタント「recast」です。
案件整理テキストと会社の基本情報をもとに、ユーザーの質問に正確に回答してください。
日本語で回答してください。

基本方針:
- まず案件整理テキスト（下に添付）で回答を試みる
- 会社の基本情報が必要な場合は get_company_profile を呼ぶ
- 案件整理でも基本情報でも分からない原文レベルの詳細が必要な場合に限り read_common_file で共通フォルダのファイルを読む

案件整理の情報で回答できる場合はツールを使う必要はありません。`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_company_profile",
    description: "会社の基本情報サマリー（登記簿、定款、株主構成）を取得します。共通フォルダのファイル一覧も返すので、詳細が必要なファイルがあれば read_common_file で読めます。",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "read_common_file",
    description: "共通フォルダ内の特定のファイルを読み取ります。get_company_profile で取得したファイル一覧から、必要なファイルのIDを指定してください。",
    input_schema: {
      type: "object" as const,
      properties: {
        file_id: { type: "string" as const, description: "読み取るファイルのID" },
        file_name: { type: "string" as const, description: "ファイル名" },
        mime_type: { type: "string" as const, description: "MIMEタイプ" },
      },
      required: ["file_id", "file_name"],
    },
  },
  {
    name: "search_all_companies",
    description: "全会社の基本情報（structured JSON）とマスターシートを横断検索します。特定の条件に合う会社を探したり、複数社の情報を比較する場合に使います。",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

type MessageContent =
  | { type: "text"; text: string }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string };

export async function* streamChat(
  messages: { role: "user" | "assistant"; content: string }[],
  contextFiles: FileContent[],
  companyProfile?: CompanyProfile | null,
  commonFiles?: { id: string; name: string; mimeType: string }[],
  allCompanies?: Company[],
  masterContent?: string | null
) {
  // system の構成
  // 案件整理テキスト（masterContent）があれば、それだけを使う（原本の再送は避ける）。
  // 無い場合のみフォールバックで案件フォルダの生ファイルを詰める。
  //
  // cache_control で system ブロックにキャッシュを効かせる。
  //   - 5分以内の連続メッセージは入力トークン 1/10 に
  //   - tool use ループの再送も cached read でほぼタダ
  let system = SYSTEM_PROMPT;

  const textFiles = contextFiles.filter(f => !f.base64);
  const binaryFiles = contextFiles.filter(f => f.base64);

  if (masterContent && masterContent.trim().length > 0) {
    system += `\n\n--- 案件整理テキスト ---\n${masterContent}\n`;
  } else if (textFiles.length > 0) {
    // 案件整理が未生成の場合のフォールバック
    system += "\n\n--- 案件ファイル（案件整理未生成のためフォールバック） ---\n";
    for (const file of textFiles) {
      system += `\n【${file.name}】\n${file.content}\n`;
    }
  }

  // メッセージを組み立て
  const apiMessages: Anthropic.MessageParam[] = [];

  // バイナリ（PDF）は masterContent があれば同梱しない（案件整理に要約済みのはず）。
  // ただし画像やスキャンPDF中心のケースはフォールバック時に同梱する。
  const shouldAttachBinaries = binaryFiles.length > 0 && !masterContent;

  if (shouldAttachBinaries && messages.length > 0) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "user" && i === messages.length - 1) {
        const content: MessageContent[] = [];
        for (const file of binaryFiles) {
          content.push({
            type: "document",
            source: {
              type: "base64",
              media_type: file.mimeType || "application/pdf",
              data: file.base64!,
            },
            title: file.name,
          });
        }
        content.push({ type: "text", text: msg.content });
        apiMessages.push({ role: "user", content: content as Anthropic.ContentBlockParam[] });
      } else {
        apiMessages.push({ role: msg.role, content: msg.content });
      }
    }
  } else {
    for (const msg of messages) {
      apiMessages.push({ role: msg.role, content: msg.content });
    }
  }

  // system を cache_control 付きで配列形式に
  const buildSystem = (): Anthropic.TextBlockParam[] => [
    { type: "text", text: system, cache_control: { type: "ephemeral" } },
  ];

  // 最初からストリーミングで呼ぶ。tool use が来たらストリームを読み切ってから次ラウンドへ。
  // tool use が無いラウンドの text_delta はその場で yield（即レスポンス）。
  // 従来の「非ストリーミングで判定 → ストリーミングで再呼び出し」の二重課金を解消。
  let round = 0;
  while (true) {
    round += 1;
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      system: buildSystem(),
      messages: apiMessages,
      tools: TOOLS,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }

    const response = await stream.finalMessage();
    logTokenUsage(`/api/chat${round > 1 ? `#round${round}` : ""}`, MODEL, response.usage);

    if (response.stop_reason !== "tool_use") break;

    // tool use 処理
    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolBlocks) {
      if (tool.name === "get_company_profile") {
        let result = "";
        if (companyProfile) {
          result = companyProfile.structured
            ? JSON.stringify({ structured: companyProfile.structured, 変更履歴: companyProfile.変更履歴 || [] }, null, 2)
            : companyProfile.summary || "";
          if (commonFiles && commonFiles.length > 0) {
            result += "\n\n--- 共通フォルダのファイル一覧 ---\n";
            result += "詳細が必要な場合は read_common_file ツールでファイルIDを指定してください。\n";
            for (const f of commonFiles) {
              result += `- ${f.name} (ID: ${f.id}, タイプ: ${f.mimeType})\n`;
            }
          }
        } else {
          result = "基本情報は未生成です。基本情報タブから生成してください。";
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: result,
        });
      } else if (tool.name === "read_common_file") {
        const input = tool.input as { file_id: string; file_name: string; mime_type?: string };
        try {
          const content = await readFileContent(input.file_id);
          if (content && !content.base64) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: tool.id,
              content: `【${content.name}】\n${content.content}`,
            });
          } else if (content?.base64) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: tool.id,
              content: `【${content.name}】このファイルはスキャンPDFのためテキスト取得できません。`,
            });
          } else {
            toolResults.push({
              type: "tool_result",
              tool_use_id: tool.id,
              content: "ファイルの読み取りに失敗しました。",
            });
          }
        } catch {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tool.id,
            content: "ファイルの読み取りに失敗しました。",
          });
        }
      } else if (tool.name === "search_all_companies") {
        const companies = allCompanies || [];
        const summaries = companies.map(c => {
          const info: Record<string, unknown> = { 会社名: c.name };
          if (c.profile?.structured) info.基本情報 = c.profile.structured;
          if (c.profile?.変更履歴) info.変更履歴 = c.profile.変更履歴;
          if (c.masterSheet?.structured) info.マスターシート = c.masterSheet.structured;
          return info;
        }).filter(c => Object.keys(c).length > 1); // 基本情報かマスターシートがある会社のみ
        toolResults.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: summaries.length > 0
            ? JSON.stringify(summaries, null, 2)
            : "基本情報が登録されている会社がありません。",
        });
      }
    }

    apiMessages.push({ role: "assistant", content: response.content });
    apiMessages.push({ role: "user", content: toolResults });
  }
}
