import Anthropic from "@anthropic-ai/sdk";
import type { FileContent, CompanyProfile, CachedFile } from "@/types";
import { readFileById } from "@/lib/files-google";

const client = new Anthropic();

const SYSTEM_PROMPT = `あなたはバックオフィス業務を支援するAIアシスタント「recast」です。
ユーザーが提供した案件フォルダ内のファイルを参照し、質問に正確に回答してください。
日本語で回答してください。

会社の基本情報が必要な場合:
1. まず get_company_profile で基本情報サマリーを確認
2. サマリーだけでは不十分で原文が必要な場合は read_common_file で特定のファイルを読む

案件ファイルの情報だけで回答できる場合はツールを使う必要はありません。`;

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
];

type MessageContent =
  | { type: "text"; text: string }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string };

export async function* streamChat(
  messages: { role: "user" | "assistant"; content: string }[],
  contextFiles: FileContent[],
  companyProfile?: CompanyProfile | null,
  commonFiles?: CachedFile[]
) {
  const textFiles = contextFiles.filter(f => !f.base64);
  const binaryFiles = contextFiles.filter(f => f.base64);

  // システムプロンプト（案件ファイルだけ）
  let system = SYSTEM_PROMPT;
  if (textFiles.length > 0) {
    system += "\n\n--- 案件ファイル ---\n";
    for (const file of textFiles) {
      system += `\n【${file.name}】\n${file.content}\n`;
    }
  }

  // メッセージを組み立て
  const apiMessages: Anthropic.MessageParam[] = [];

  if (binaryFiles.length > 0 && messages.length > 0) {
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

  // tool useが必要か判定するため最初は非ストリーミング
  let response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system,
    messages: apiMessages,
    tools: TOOLS,
  });

  // tool useループ（非ストリーミング）
  while (response.stop_reason === "tool_use") {
    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    // ツール結果を組み立て
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolBlocks) {
      if (tool.name === "get_company_profile") {
        let result = "";
        if (companyProfile) {
          result = companyProfile.summary;
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
          const content = await readFileById(input.file_id, input.file_name, input.mime_type);
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
      }
    }

    apiMessages.push({ role: "assistant", content: response.content });
    apiMessages.push({ role: "user", content: toolResults });

    // まだtool useが続くか確認
    response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system,
      messages: apiMessages,
      tools: TOOLS,
    });
  }

  // 最終回答がtool use無しならストリーミングで再リクエスト
  // （tool useループ後のresponseはテキストのみのはず）
  if (response.stop_reason === "end_turn") {
    // tool useがあった場合、最終回答をストリーミングで再取得
    const hadToolUse = apiMessages.length > messages.length;
    if (hadToolUse) {
      // 既にresponseがあるのでそれをyield
      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          yield block.text;
        }
      }
    } else {
      // tool use無し → ストリーミングで最初からやり直し
      const stream = client.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system,
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
    }
  }
}
