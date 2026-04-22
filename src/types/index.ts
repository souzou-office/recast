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
  mtime?: string;          // 最終更新日時 (ISO8601)。profile鮮度判定に使用
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

// 書類に埋めた値（スロット単位）。値の直接編集 UI / 再生成で使う。
export interface FilledSlot {
  slotId: number;        // docx-marker-parser / xlsx-marker-parser のスロットID
  label: string;         // 意味ラベル（例: "代表取締役氏名"、template-labels.ts が付けたもの）
  value: string;         // 実際に埋めた値
  format?: string;       // 記載形式ヒント（"令和○年○月○日" 等）
  sourceHint?: string;   // 推定出典
  copyIndex?: number;    // 複数部数書類の N 番目（1-indexed）。単一なら省略
}

export interface GeneratedDocument {
  templateName: string;
  templatePath?: string; // 元テンプレのファイルパス。再生成で使う（後方互換のため optional）
  docxBase64: string;
  previewHtml: string;
  fileName: string;
  createdAt: string;
  filledSlots?: FilledSlot[];  // 埋めた値の履歴（直接編集・再生成用）。後方互換で optional
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
  profileSources?: string[]; // 基本情報抽出に使うファイルパス一覧（未設定なら共通フォルダ全ファイル）
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

// === 旧ChatMessage（後方互換） ===
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

// === チャットワークフロー ===

// アクションカード（チャット内UIパーツ）
export interface FolderSelectCard {
  type: "folder-select";
  folders: { name: string; path: string; fileCount: number }[];
  selectedPath?: string;
}

export interface FileSelectCard {
  type: "file-select";
  folderPath: string;
  files: { name: string; path: string; enabled: boolean }[];
  confirmed?: boolean;
}

export interface TemplateSelectCard {
  type: "template-select";
  templates: { name: string; path: string; fileCount: number }[];
  selectedPath?: string;
}

export interface ClarificationQuestion {
  id: string;
  placeholder: string;
  question: string;
  options: {
    id: string;
    label: string;
    source: string;
  }[];
  selectedOptionId?: string;
  manualInput?: string;
}

export interface ClarificationCard {
  type: "clarification";
  questions: ClarificationQuestion[];
  answered?: boolean;
}

export interface CheckIssue {
  severity: "error" | "warn" | "info"; // 🔴重大 / 🟡注意 / 🔵軽微
  aspect: string;   // チェック観点（例: 原本との整合性 / 書類間の整合性 / 要確認の残り）
  problem: string;  // 問題内容
  expected?: string; // 原本の正しい値（あれば）
  slotId?: number;  // verify が指摘した項目の slotId（紐付かない指摘の場合は undefined）
  candidates?: { value: string; source: string }[]; // 修正候補（expected 含む、なければ空）
  acknowledged?: boolean; // ユーザーが「確認した、このままで OK」とマークした
}

export interface DocumentResultItem {
  name: string;
  fileName: string;
  docxBase64: string;
  previewHtml: string;
  // 突合せチェックの結果（runCheck 後に追加）
  checkStatus?: "ok" | "warn" | "error";
  issues?: CheckIssue[];
  // 値の直接編集・再生成用（後方互換のため optional）
  templatePath?: string;
  filledSlots?: FilledSlot[];
}

export interface DocumentResultCard {
  type: "document-result";
  documents: DocumentResultItem[];
  checkSummary?: string;        // 人間向けの短いサマリ（例: 3件要確認）
  checkedAt?: string;           // ISO datetime
}

// 新規テンプレ解釈生成済みの通知カード（初回テンプレ使用時のみ表示）
export interface TemplateReviewCard {
  type: "template-review";
  folderPath: string;      // テンプレフォルダパス（[確認する] で設定タブを開く際に使う）
  templateName: string;    // 表示用のフォルダ名
  totalFiles: number;      // フォルダ内のテンプレファイル数
  newlyGenerated: number;  // 今回新規生成された数
  files: { name: string; slotCount: number; wasNew: boolean }[];
  acknowledged?: boolean;  // [このまま実行] か [確認して実行] が押されたら true
}

export interface CheckPromptCard {
  type: "check-prompt";
  accepted?: boolean;
}

export interface CheckResultCard {
  type: "check-result";
  content: string;
}

export type ActionCard =
  | FolderSelectCard
  | FileSelectCard
  | TemplateSelectCard
  | ClarificationCard
  | DocumentResultCard
  | TemplateReviewCard
  | CheckPromptCard
  | CheckResultCard;

// チャットスレッドメッセージ
export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  cards?: ActionCard[];
  timestamp: string;
}

// チャットスレッド（CaseRoom + chat-history 統合）
export interface ChatThread {
  id: string;
  companyId: string;
  displayName: string;
  messages: ThreadMessage[];
  // ワークフロー成果物
  folderPath?: string;
  disabledFiles?: string[];
  masterSheet?: MasterSheet;
  generatedDocuments?: GeneratedDocument[];
  checkResult?: string;
  // メタ
  createdAt: string;
  updatedAt: string;
}

// 右パネル
export interface PreviewFile {
  id: string;
  name: string;
  type: "source" | "generated";
  filePath?: string;
  docxBase64?: string;
  previewHtml?: string;
}
