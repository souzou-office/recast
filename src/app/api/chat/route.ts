import { NextRequest } from "next/server";
import { streamChat } from "@/lib/claude";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder, listFiles } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";
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

  // 案件フォルダ（active）のファイルをライブ読み取り
  if (company) {
    for (const sub of company.subfolders) {
      if (sub.role === "job" && sub.active) {
        const files = await readAllFilesInFolder(sub.id);
        const disabled = sub.disabledFiles || [];
        for (const f of files) {
          if (!isPathDisabled(f.path, disabled)) {
            contextFiles.push(f);
          }
        }
      }
    }
  }

  const companyProfile = company?.profile || null;

  // 共通フォルダのファイル一覧（tool useでファイル読み取りに使う）
  const commonFiles: { id: string; name: string; mimeType: string }[] = [];
  if (company) {
    for (const sub of company.subfolders) {
      if (sub.role === "common") {
        const entries = await listFiles(sub.id);
        const disabled = new Set(sub.disabledFiles || []);
        for (const e of entries) {
          if (!e.isDirectory && !disabled.has(e.path)) {
            const ext = e.name.split(".").pop() || "";
            commonFiles.push({ id: e.path, name: e.name, mimeType: ext });
          }
        }
      }
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const text of streamChat(messages, contextFiles, companyProfile, commonFiles, config.companies)) {
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
