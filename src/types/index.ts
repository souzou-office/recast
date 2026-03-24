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

export interface OfficerInfo {
  役職: string;
  氏名: string;
  住所?: string;
  就任日?: string;
  任期満了?: string;
}

export interface ShareholderInfo {
  氏名: string;
  住所?: string;
  持株数?: string;
  持株比率?: string;
}

export interface StructuredProfile {
  会社法人等番号: string;
  商号: string;
  本店所在地: string;
  設立年月日: string;
  事業目的: string[];
  資本金: string;
  発行可能株式総数: string;
  発行済株式総数: string;
  株式の譲渡制限: string;
  役員: OfficerInfo[];
  新株予約権: string;
  公告方法: string;
  決算期: string;
  役員の任期: string;
  株主: ShareholderInfo[];
  備考?: string;
}

export interface ChangeHistoryEntry {
  日付: string;
  内容: string;
  根拠ファイル: string;
}

export interface CompanyProfile {
  summary?: string; // 後方互換: 旧フリーテキスト
  structured?: StructuredProfile;
  変更履歴?: ChangeHistoryEntry[];
  updatedAt: string;
  sourceFiles: (string | SourceFile)[];
}

export interface DocumentTemplate {
  id: string;
  name: string;          // 例: "株主総会議事録（役員選任）"
  category: string;      // 例: "議事録", "就任承諾書", "届出書"
  content: string;       // 雛形テキスト（個人情報除去済み）
  createdAt: string;
}

export interface MasterSheet {
  templateId: string;
  templateName: string;
  content: string; // マークダウン表示用
  structured?: Record<string, unknown>; // JSON構造化データ
  sourceFiles?: { id: string; name: string; mimeType: string }[];
  createdAt: string;
}

export interface Company {
  id: string;
  name: string;
  subfolders: Subfolder[];
  profile?: CompanyProfile;
  masterSheet?: MasterSheet; // テンプレート実行結果
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
