export type FolderProvider = "local" | "google" | "dropbox";

export type SubfolderRole = "common" | "job";

export interface CachedFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedTime: string;
  enabled: boolean;
}

export interface Subfolder {
  id: string;
  name: string;
  role: SubfolderRole;
  active: boolean;
  files?: CachedFile[];
}

export interface SourceFile {
  name: string;
  id: string;
}

export interface CompanyProfile {
  summary: string;
  updatedAt: string;
  sourceFiles: (string | SourceFile)[]; // 後方互換: stringも許容
}

export interface Company {
  id: string;
  name: string;
  subfolders: Subfolder[];
  profile?: CompanyProfile;
}

export interface WorkspaceConfig {
  baseFolder: {
    id: string;
    name: string;
    provider: FolderProvider;
  } | null;
  globalCommon: { id: string; name: string }[];
  defaultCommonPatterns: string[]; // デフォルト共通フォルダ名パターン
  companies: Company[];
  selectedCompanyId: string | null;
}

export interface FileInfo {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
}

export interface FileContent {
  name: string;
  path: string;
  content: string;
  mimeType?: string;
  base64?: string;
}

// テンプレート関連
export interface CheckTemplate {
  id: string;
  name: string;
  items: string[]; // 確認項目名のリスト
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  checkResult?: {
    templateName: string;
    items: { label: string; result: string; note?: string }[];
    createdAt: string;
  };
}
