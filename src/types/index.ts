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
  baseFolderId?: string; // どのルートフォルダから来たか
}

export interface BaseFolder {
  id: string;          // エントリの一意ID
  name: string;        // 表示名
  folderId: string;    // クラウド上のフォルダID
  provider: FolderProvider;
}

export interface WorkspaceConfig {
  baseFolders: BaseFolder[];
  globalCommon: { id: string; name: string }[];
  defaultCommonPatterns: string[];
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
  sourceFiles?: { id: string; name: string; mimeType: string }[];
  sourceLinks?: Record<string, { id: string; name: string }[]>;
}
