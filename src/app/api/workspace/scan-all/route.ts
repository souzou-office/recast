import { NextRequest } from "next/server";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";
import { listFoldersGoogle } from "@/lib/files-google";

// 再帰的にサブフォルダを全階層スキャンしてフラットに返す
async function scanAllSubfolders(
  folderId: string,
  maxDepth: number = 4,
  depth: number = 0
): Promise<{ id: string; name: string }[]> {
  if (depth >= maxDepth) return [];

  const result = await listFoldersGoogle(folderId);
  let all: { id: string; name: string }[] = [];

  for (const dir of result.dirs) {
    all.push({ id: dir.path, name: dir.name });
    const children = await scanAllSubfolders(dir.path, maxDepth, depth + 1);
    all = all.concat(children);
  }

  return all;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const reset = body.reset === true;

  const config = await getWorkspaceConfig();

  if (!config.baseFolder) {
    return new Response(JSON.stringify({ error: "ベースフォルダが未設定です" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  if (config.baseFolder.provider !== "google") {
    return new Response(JSON.stringify({ error: "現在Googleのみ対応" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const patterns = config.defaultCommonPatterns || [];
  if (patterns.length === 0) {
    return new Response(JSON.stringify({ error: "共通フォルダが未設定です" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const baseResult = await listFoldersGoogle(config.baseFolder!.id);
        const companyFolders = baseResult.dirs.map(d => ({ id: d.path, name: d.name }));
        const total = companyFolders.length;

        send({ type: "progress", current: 0, total, message: `${total}社を検出` });

        const existingCompanyMap = new Map(config.companies.map(c => [c.id, c]));
        let registeredCount = 0;

        for (let i = 0; i < companyFolders.length; i++) {
          const cf = companyFolders[i];
          send({ type: "progress", current: i + 1, total, message: cf.name });

          let company = existingCompanyMap.get(cf.id);
          if (!company) {
            company = { id: cf.id, name: cf.name, subfolders: [] };
            config.companies.push(company);
          }

          const allFolders = await scanAllSubfolders(cf.id);
          const existingSubMap = new Map(company.subfolders.map(s => [s.id, s]));

          if (reset) {
            company.subfolders = [];
          }

          const currentSubIds = new Set(company.subfolders.map(s => s.id));

          for (const sf of allFolders) {
            if (currentSubIds.has(sf.id)) continue;

            const matches = patterns.some(p =>
              sf.name.toLowerCase() === p.toLowerCase()
            );
            if (matches) {
              const existing = existingSubMap.get(sf.id);
              company.subfolders.push({
                id: sf.id,
                name: sf.name,
                role: "common" as const,
                active: true,
                files: existing?.files,
              });
              registeredCount++;
            }
          }
        }

        await saveWorkspaceConfig(config);

        send({
          type: "done",
          totalCompanies: total,
          registeredCount,
          config,
        });
      } catch (e) {
        send({
          type: "error",
          error: e instanceof Error ? e.message : "一括スキャンに失敗しました",
        });
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
