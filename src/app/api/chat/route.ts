import { NextRequest } from "next/server";
import { streamChat } from "@/lib/claude";
import { getWorkspaceConfig } from "@/lib/folders";
import { readAllFilesInFolder, listFiles } from "@/lib/files";
import { isPathDisabled } from "@/lib/disabled-filter";
import { loadThread } from "@/lib/thread-store";
import type { FileContent } from "@/types";

export async function POST(request: NextRequest) {
  const { messages, companyId: requestedCompanyId, threadId } = await request.json() as {
    messages: { role: "user" | "assistant"; content: string }[];
    companyId?: string;
    threadId?: string;
  };

  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: "messages は必須です" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const config = await getWorkspaceConfig();
  const company = config.companies.find(
    c => c.id === (requestedCompanyId || config.selectedCompanyId)
  );

  // スレッド情報を読む。これが「今話している案件」の単一のソース。
  // 案件整理（masterSheet）・案件フォルダ（folderPath）・除外ファイル はすべて thread に紐付く。
  // 会社全体の caseRooms/masterSheet は案件をまたいで混ざるので参照しない。
  const thread = threadId && company ? await loadThread(company.id, threadId) : null;

  const masterContent = thread?.masterSheet?.content || null;

  // 案件フォルダ: スレッドに紐付いたパスだけを使う（会社全体ではない）
  const contextFiles: FileContent[] = [];
  if (company && !masterContent && thread?.folderPath) {
    const files = await readAllFilesInFolder(thread.folderPath);
    const disabled = thread.disabledFiles || [];
    for (const f of files) {
      if (!isPathDisabled(f.path, disabled)) {
        contextFiles.push(f);
      }
    }
  }

  const companyProfile = company?.profile || null;

  // 共通フォルダのファイル一覧（tool use でファイル読み取りに使う）。
  // 「共通」は会社全体で共有する情報（定款・登記簿等）なので会社の subfolders から取得してOK。
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
        for await (const text of streamChat(messages, contextFiles, companyProfile, commonFiles, config.companies, masterContent)) {
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
