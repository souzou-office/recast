import { NextRequest } from "next/server";
import { streamChat } from "@/lib/claude";
import { getWorkspaceConfig } from "@/lib/folders";
import { readFileById } from "@/lib/files-google";
import type { FileContent } from "@/types";

export async function POST(request: NextRequest) {
  const { messages } = await request.json();

  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: "messages は必須です" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const config = await getWorkspaceConfig();
  const contextFiles: FileContent[] = [];
  const company = config.companies.find(c => c.id === config.selectedCompanyId);

  // 案件フォルダ（active）のenabledファイルだけ読む
  if (company) {
    for (const sub of company.subfolders) {
      if (sub.role === "job" && sub.active) {
        if (sub.files && sub.files.length > 0) {
          for (const f of sub.files) {
            if (!f.enabled) continue;
            const content = await readFileById(f.id, f.name, f.mimeType);
            if (content) contextFiles.push(content);
          }
        }
      }
    }
  }

  // 基本情報はtool use経由で必要な時だけ渡す
  const companyProfile = company?.profile || null;

  // 共通フォルダのファイル一覧（tool useでファイル読み取りに使う）
  const commonFiles = company?.subfolders
    .filter(s => s.role === "common")
    .flatMap(s => s.files || [])
    .filter(f => f.enabled) || [];

  // ストリーミングレスポンス
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const text of streamChat(messages, contextFiles, companyProfile, commonFiles)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "不明なエラーが発生しました";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`)
        );
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
