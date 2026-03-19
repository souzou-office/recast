import fs from "fs/promises";
import path from "path";
import type { WorkspaceConfig } from "@/types";

const DATA_PATH = path.join(process.cwd(), "data", "folders.json");

const DEFAULT_CONFIG: WorkspaceConfig = {
  baseFolder: null,
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
    return { ...DEFAULT_CONFIG, ...data };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveWorkspaceConfig(config: WorkspaceConfig): Promise<void> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(config, null, 2), "utf-8");
}
