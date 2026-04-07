export type FolderProvider = "local" | "google" | "dropbox";

export type SubfolderRole = "common" | "job" | "none";

// Local-First: ファイルはライブ読み取り。無効化リストのみ保存
export interface Subfolder {
  id: string;              // ローカルパス（フォルダ）
  name: string;
  role: SubfolderRole;
  active: boolean;
  disabledFiles?: string[]; // 無効化したファイルの相対パス
}

export interface SourceFile {
  name: string;
  id: string;              // ローカルパス
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
  summary?: string;
  structured?: StructuredProfile;
  変更履歴?: ChangeHistoryEntry[];
  updatedAt: string;
  sourceFiles: (string | SourceFile)[];
}

export interface DocumentTemplatePart {
  id: string;
  name: string;
  content: string;
}

export interface DocumentTemplate {
  id: string;
  name: string;
  category?: string;
  content: string;
  parts?: DocumentTemplatePart[];
  createdAt: string;
}

export interface MasterSheet {
  templateId: string;
  templateName: string;
  content: string;
  structured?: Record<string, unknown>;
  sourceFiles?: { id: string; name: string; mimeType: string }[];
  createdAt: string;
}

export interface GeneratedDocument {
  templateName: string;
  docxBase64: string;
  previewHtml: string;
  fileName: string;
  createdAt: string;
}

export interface CaseRoom {
  id: string;              // 一意ID (timestamp-based)
  folderPath: string;      // 案件フォルダのパス
  displayName: string;     // 表示名（AIが自動生成、ユーザー変更可）
  masterSheet?: MasterSheet;
  generatedDocuments?: GeneratedDocument[];
  checkResult?: string;    // 突合せ結果
  createdAt: string;
  updatedAt: string;
}

export interface Company {
  id: string;              // ローカルパス（会社フォルダ）
  name: string;
  subfolders: Subfolder[];
  profile?: CompanyProfile;
  caseRooms?: CaseRoom[];
  // 後方互換: 旧データ
  masterSheet?: MasterSheet;
  generatedDocuments?: GeneratedDocument[];
}

export interface WorkspaceConfig {
  basePath?: string;       // 後方互換
  basePaths: string[];     // 顧問先フォルダのローカルパス（複数）
  templateBasePath: string; // 書類テンプレートフォルダのローカルパス
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
  items: string[];
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
