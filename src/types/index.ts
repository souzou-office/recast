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
  pendingChanges?: boolean;    // 値が変更されたが docxBase64 にまだ反映されていない
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
  // 直近 detectSubfolders 時の「会社フォルダ + 中間フォルダ mtime ハッシュ」。
  // 次回スキャン依頼が来た時にこの sig と現状の sig を比較し、変わってなければ
  // readdir を一切走らせずに済ませる（mtime cache）。
  scannedSig?: string;
}

export interface WorkspaceConfig {
  basePath?: string;       // 後方互換
  basePaths: string[];     // 顧問先フォルダのローカルパス（複数）
  templateBasePath: string; // 書類テンプレートフォルダのローカルパス
  // 作業記録の自動保存先（クラウドストレージ等を指定すれば他 PC・他人と自動共有可能）
  // 設定されていれば、スレッド更新時に <recordsBasePath>/<会社名>/<案件名>/ 以下に
  // 案件整理.md / 生成書類/ / 質問回答.json / 検証結果.md を自動書き出す
  recordsBasePath?: string;
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
  // 実体確認 (Phase 1 clarify) か 書面ルール確認 (Phase 2 = analyze 後の clarify-procedural) か。
  // 省略時は substantive 扱い（既存スレッドとの互換のため）。
  kind?: "substantive" | "procedural";
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
  pendingChanges?: boolean; // 編集された値が docxBase64 にまだ反映されていない
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

// Phase 2 (analyze) が出力する「テンプレに何を入れるか」の決定。
// analyze AI がテンプレ本文 + 案件ファイル + Phase 1 整理 + Phase 1 Q&A を読んで決める。
// Phase 3 (produce) はこの決定をルールベースで適用するだけ。
export interface Phase2Decisions {
  documents: Phase2DocumentDecision[];
}

// 1 slot あたりの決定。各 slot は配列に 1 度だけ登場し、action は必ず 1 つ。
// (旧設計では slots / deletes / unconfirmed が別配列で、AI が同じ slot に複数指示を
//  書き込む事故 (value に指示文を埋め込む等) が発生していた → 構造的に防ぐ)
// さらに新設計 (Phase 2-A 質問フェーズ導入後) では「迷う」は事前に質問で解決済み
// なので unconfirmed / candidates も削除し、fill / delete-row の2択のみに簡素化。
export interface SlotDecision {
  slot: string;          // labels.json のラベル名 (例: "乙の無限責任組合員の名称")
  action: "fill" | "delete-row";
  value?: string;                                          // fill のとき
  source?: string;                                         // fill のとき
  reason?: string;                                         // delete-row のとき
}

// 行挿入: 既存 slot の行の直後に「新ラベル付き行」を追加する。
// 設計思想:
// - 「行を追加する」= 必ず案件依存の値が入る = 必ず ★label★ を立てる
// - 固定文の追加はテンプレ側に書けばいいので row insertion の対象外
// - template に書いた ★label★ ごとの値を fills に **同じエントリに** 入れさせる
//   ことで、AI が「行は挿入したが値を埋め忘れた」事故を構造的に防止する
export interface RowInsertion {
  afterSlot: string;            // この slot を含む行の直後に挿入
  template: string;             // 行のテンプレ文字列 (例: "代表取締役　★乙の代表取締役★")
                                 // template 中の ★label★ は必ず fills に対応 entry が要る (サーバ検証)
  fills: {                       // template 内の ★label★ ごとの値
    slot: string;
    value: string;
    source?: string;
  }[];
  reason: string;
}

// テキスト一括置換: 議案番号繰り上げ (議案3 → 議案2) 等、blockDeletes の副作用を表現する。
// Phase 2 が delete を決めた時点でその副作用も Phase 2 が同時に決める (Phase 3 に判断させない)
export interface TextReplace {
  anchor: string;       // 検索文字列 (完全一致部分文字列)
  replacement: string;  // 置換文字列
  reason: string;
}

// 議案ブロック等の複数段落削除。Phase 3 で機械処理するため範囲を明示する。
// startAnchor: ブロック開始段落に含まれる文字列 (例: "議案２　取締役の報酬に関する件")
// endAnchor:   削除終了 = この文字列を含む段落の **直前まで** 削除。省略時は文書末尾まで
export interface BlockDelete {
  startAnchor: string;
  endAnchor?: string;
  reason: string;
}

export interface Phase2DocumentDecision {
  templateFile: string;                                    // クリーンな物理テンプレファイル名 (例: "2-1.提案書兼同意書.docx")
  outputLabel?: string;                                    // 同一テンプレから複数出力する場合の識別 (例: "藤崎用", "先端機構用")
                                                            // 省略時は同一テンプレに 1 出力。出力ファイル名は {base}_{outputLabel}.{ext}
  // 新スキーマ (changes): 段落番号ベースの統一操作リスト。1 段落 1 op が構造的保証される。
  // 旧 slotDecisions / blockDeletes / rowInsertions / textReplaces は当面互換のため残置するが
  // 新規 AI 出力ではこちらだけ使う想定。
  changes?: ChangeOp[];
  // 旧スキーマ (互換用、新ルートでは使わない)
  slotDecisions?: SlotDecision[];                          // 各 slot 1 entry のみ
  blockDeletes?: BlockDelete[];                            // 議案ブロック等の複数段落削除 (start/end anchor で範囲指定)
  rowInsertions?: RowInsertion[];                          // 新規行挿入 (法人引受人なら代表取締役行を足す等)
  textReplaces?: TextReplace[];                            // blockDeletes に伴う議案番号繰り上げ等
}

// 新スキーマ: 段落単位の操作 1 つ。AI が「どの段落をどうする」を 1 op で表現する。
// 同じ idx に複数 op を入れない (1 段落 1 op の構造的保証)。
//
// action 別の必須/任意:
//   delete:       idx (until は省略可、複数段落削除なら指定)
//   fill:         idx + slot + value
//   rewrite:      idx + text
//   insertAfter:  idx + text
export interface ChangeOp {
  idx: number;                       // 段落番号 (1-indexed)
  action: "delete" | "fill" | "rewrite" | "insertAfter";

  // delete のとき: 範囲削除なら idx〜until まで (idx 単独削除なら省略)
  until?: number;

  // fill のとき: ★label★ と置換後の値
  slot?: string;                     // 例: "★代表取締役の氏名★" or "代表取締役の氏名" (どちらでも)
  value?: string;

  // rewrite / insertAfter のとき: 完成形テキスト (AI が値込みで生成)
  text?: string;

  // 任意: AI の判断理由 (デバッグ・verify 用)
  reason?: string;
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
  // Phase 2 で確定した「テンプレに入れる値・削除する議案・残る要確認」。
  // clarify-procedural と produce の両方が参照する。
  phase2Decisions?: Phase2Decisions;
  // 1案件=1会話: 案件整理→質問→書類生成→検証 を Claude の同じ会話履歴で進める
  // （別人感をなくし、各ステップが前段の判断・迷いを継承するため）
  aiMessages?: CaseAiMessage[];
  // メタ
  createdAt: string;
  updatedAt: string;
}

// 1案件1会話: Claude に送る生のメッセージ履歴
// 各ターンに stage を打って「どのステップで書かれたか」を区別する（再実行時の切り戻し位置にも使う）
export type CaseAiContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string; cache_control?: { type: "ephemeral" } }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: { type: "ephemeral" } };

export interface CaseAiMessage {
  role: "user" | "assistant";
  content: string | CaseAiContentBlock[];
  // どのステップが書き込んだか
  stage?: "organize" | "clarify" | "analyze" | "clarify-procedural" | "produce" | "verify";
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
