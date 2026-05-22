import fs from "fs/promises";
import path from "path";
import type { WorkspaceConfig } from "@/types";

const DATA_PATH = path.join(process.cwd(), "data", "folders.json");

const DEFAULT_CONFIG: WorkspaceConfig = {
  basePaths: [],
  templateBasePath: "",
  defaultCommonPatterns: [],
  companies: [],
  selectedCompanyId: null,
};

export async function getWorkspaceConfig(): Promise<WorkspaceConfig> {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf-8");
    const data = JSON.parse(raw);

    // 旧形式からの移行: baseFolders/globalCommon は無視
    // 旧basePath → basePaths移行
    let basePaths: string[] = data.basePaths || [];
    if (basePaths.length === 0 && data.basePath) {
      basePaths = [data.basePath];
    }

    const config: WorkspaceConfig = {
      basePaths,
      templateBasePath: data.templateBasePath || "",
      recordsBasePath: data.recordsBasePath || "",
      defaultCommonPatterns: data.defaultCommonPatterns || [],
      companies: data.companies || [],
      selectedCompanyId: data.selectedCompanyId || null,
    };

    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// 同一プロセス内で「前回シリアライズした JSON」を持っておき、内容が変わらなければ
// writeFile を skip する。フォーカス復帰時の空振り rescan で 59KB の書き込みが
// 走らないようにするための簡易最適化。プロセス再起動後は1回目だけ必ず書く。
let lastSerialized: string | null = null;

export async function saveWorkspaceConfig(config: WorkspaceConfig): Promise<void> {
  const serialized = JSON.stringify(config, null, 2);
  if (serialized === lastSerialized) return;
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, serialized, "utf-8");
  lastSerialized = serialized;
}
