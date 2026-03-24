import fs from "fs/promises";
import path from "path";
import type { WorkspaceConfig } from "@/types";

const DATA_PATH = path.join(process.cwd(), "data", "folders.json");

const DEFAULT_CONFIG: WorkspaceConfig = {
  baseFolders: [],
  globalCommon: [],
  defaultCommonPatterns: [],
  companies: [],
  selectedCompanyId: null,
};

export async function getWorkspaceConfig(): Promise<WorkspaceConfig> {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf-8");
    const data = JSON.parse(raw);
    // 旧形式（common/jobs）の場合はデフォルトを返す
    if ("common" in data || "jobs" in data) {
      return { ...DEFAULT_CONFIG };
    }

    const config = { ...DEFAULT_CONFIG, ...data };

    // 旧形式 baseFolder → baseFolders に移行
    if (data.baseFolder && !data.baseFolders) {
      config.baseFolders = [{
        id: data.baseFolder.id,
        name: data.baseFolder.name,
        folderId: data.baseFolder.id,
        provider: data.baseFolder.provider,
      }];
      delete (config as Record<string, unknown>).baseFolder;
    }

    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveWorkspaceConfig(config: WorkspaceConfig): Promise<void> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  // 旧形式のbaseFolderが残っていたら削除
  const toSave = { ...config };
  delete (toSave as Record<string, unknown>).baseFolder;
  await fs.writeFile(DATA_PATH, JSON.stringify(toSave, null, 2), "utf-8");
}
