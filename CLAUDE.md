# CLAUDE.md — recast

## プロジェクト概要

**recast**（リキャスト）は、バックオフィス業務を効率化するソフトウェア。
名前の由来：recast = 鋳造し直す。起きた事実を、相手の要求仕様に合う型に流し込み直す。

## 基本思想

> バックオフィスの仕事とは、起きた事実を、相手の要求仕様に沿った情報へ再構成することである。

### 核心的な価値

> 書類がマスターデータになる。

## 技術スタック

- **フレームワーク**: Next.js 15 + React 19 + TypeScript
- **スタイリング**: Tailwind CSS 4 + @tailwindcss/typography
- **AI**: Anthropic Claude API (claude-sonnet-4-6) + tool use + Haiku (claude-haiku-4-5-20251001)
- **ファイルアクセス**: Local-First（ローカルfs直接読み取り。Google Drive for Desktop等の同期フォルダ対応）
- **ファイル解析**: pdf-parse, mammoth, xlsx（共通パーサー: file-parsers.ts）
- **書類生成**: docxtemplater + pizzip（Wordテンプレート【プレースホルダー】置換）
- **プレビュー**: LibreOffice（Word→PDF変換）, LibreOffice HTML（Excel表示）
- **マークダウン**: react-markdown + remark-gfm

## 現在のアーキテクチャ

### レイアウト
```
[ロゴ]  チャット | 基本情報 | 案件整理 | 書類生成 | チェック  [🔍] [⚙]
├─[サイドバー]─┤──────────[メインコンテンツ]──────────┤
│ 会社セレクター │                                      │
│ ファイルツリー │                                      │
│ （共通/案件/除外）│                                   │
└──────────┴──────────────────────────────────┘
```

- **ヘッダー**: ロゴ + タブ + 横断検索(🔍) + 設定(⚙)
- **サイドバー**: 会社セレクター + ファイルツリー（フォルダ展開・ファイルチェックボックス・共通/案件/除外ロール切替）
- **サイドバー幅**: ドラッグでリサイズ可能
- **タブ切替**: 案件整理・チェックはhidden方式で状態保持

### データ構造
```
data/
  folders.json          — ワークスペース設定（会社・サブフォルダ・プロファイル・マスターシート・生成書類）
  templates.json        — 案件整理テンプレート
  profile-template.json — 基本情報抽出項目
  chat-history/         — 会社ごとのチャット履歴
```

### WorkspaceConfig
```typescript
{
  basePath: string;           // 顧問先フォルダのローカルパス
  templateBasePath: string;   // 書類テンプレートフォルダのローカルパス
  defaultCommonPatterns: string[];
  companies: Company[];
  selectedCompanyId: string | null;
}
```

### Company
```typescript
{
  id: string;                 // ローカルパス
  name: string;
  subfolders: Subfolder[];    // role: "common" | "job" | "none", disabledFiles
  profile?: CompanyProfile;
  masterSheet?: MasterSheet;
  generatedDocuments?: GeneratedDocument[];  // 生成済み書類（docxBase64 + previewHtml）
}
```

### API構成
| パス | 用途 |
|------|------|
| `/api/workspace` | ワークスペース設定CRUD（selectCompany, selectSingleJob, toggleFile, selectSingleFolder, setSubfolderRole, setTemplateBasePath, setDefaultCommonPatterns, applyDefaultCommon, rescanCompany, removeCompany, deleteMasterSheet, saveGeneratedDocument, deleteGeneratedDocument） |
| `/api/workspace/list-files` | ローカルフォルダのライブファイル一覧（POST） |
| `/api/workspace/read-file` | ローカルファイル読み取り（テキスト抽出 or HTML変換） |
| `/api/workspace/raw-file` | ローカルファイルの生データ返却 |
| `/api/workspace/preview-pdf` | Word→LibreOffice PDF変換 |
| `/api/workspace/preview-html` | Excel→LibreOffice HTML変換 |
| `/api/workspace/profile` | 基本情報の生成・差分更新 |
| `/api/workspace/profile-template` | 基本情報抽出項目のCRUD |
| `/api/workspace/check` | チェック項目生成 |
| `/api/browse-local` | ローカルファイルシステムブラウザ（ドライブ一覧→フォルダ階層） |
| `/api/chat` | チャットAPI（SSE、tool use対応） |
| `/api/chat-history` | チャット履歴CRUD |
| `/api/templates` | 案件整理テンプレートCRUD |
| `/api/templates/execute` | テンプレート実行（SSEストリーミング） |
| `/api/templates/suggest` | 案件名からテンプレート推定（Haiku） |
| `/api/templates/suggest-folders` | テンプレート→関連フォルダ推論（Haiku） |
| `/api/templates/generate` | AIでテンプレート項目を自動生成 |
| `/api/templates/save-master` | マスターシートJSON保存 |
| `/api/templates/link-sources` | Haikuで各セクションと根拠ファイルを紐付け |
| `/api/document-templates/produce` | Wordテンプレート【プレースホルダー】置換→docx生成 or AI全文生成 |
| `/api/verify` | 突合せ（案件整理結果と書類の相違チェック、表形式レポート） |

## 実装済み機能

### Local-First ✅
- ローカルfs直接読み取り（Google Drive API廃止）
- ベースフォルダ設定（ファイラーUIでフォルダ選択→会社自動検出）
- 中間フォルダ自動スキップ（01.法務→中の01.定款等を直接登録）
- 共通パターン自動分類（定款, 登記, 株主名簿等）
- フォルダ3段階ロール: 共通/案件/除外
- ファイル再帰読み取り（readAllFilesInFolder）
- disabledFilesでフォルダ/ファイル単位のON/OFF
- ウィンドウフォーカス時にファイル一覧自動更新

### サイドバー（ファイラー）✅
- 会社セレクター（検索付き）
- ファイルツリー再帰表示（📁/📂フォルダ、📄📝📊📎ファイル）
- フォルダ展開でライブファイル読み込み
- ロール切替バッジ（共通→案件→除外→共通のサイクル）
- 案件フォルダ単一選択（●トグル）
- フォルダ内チェックボックス単一選択
- サイドバー幅ドラッグ調整

### チャット ✅
- 会社ごとのチャット（専用タブ）
- 横断検索（search_all_companies tool）
- tool use（基本情報・共通ファイル読み取り）
- SSEストリーミング

### 基本情報 ✅
- 共通フォルダのファイルからAI自動生成（テキスト+structured JSON）
- 抽出項目カスタマイズ
- 参照元資料リンク + FilePreview
- ダウンロード機能

### 案件整理 ✅
- テンプレート選択カードUI（クリックで展開→確認項目表示→実行）
- テンプレート→フォルダ推論（Haiku）
- テンプレート実行（SSEストリーミング）
- マスターシート保存（HaikuでJSON変換）
- 出典リンク（link-sources）
- テンプレート管理（設定タブ: 箇条書き入力、AI生成）

### 書類生成 ✅
- テンプレートフォルダ方式（ドライブ上のdocx+メモファイル）
- Wordテンプレート【プレースホルダー】→AIが値生成→docxtemplater置換
- 複数docx一括生成
- 英数字全角変換
- 生成書類の保存・一覧・プレビュー・ダウンロード

### 突合せ（チェック）✅
- 案件整理結果 vs 書類の相違チェック
- 表形式レポート出力
- ファイル直接パス読み取り
- 結果削除機能

### ファイルプレビュー ✅
- PDF: ブラウザネイティブ
- Word (.doc/.docx): LibreOffice PDF変換
- Excel (.xls/.xlsx): LibreOffice HTML変換
- 画像: ブラウザネイティブ
- テキスト: そのまま表示
- ダウンロード機能

## 未完了・次のタスク

### 案件部屋（CaseRoom）— 次に実装
- 案件ごとに作業結果を保存（案件整理・書類・チェック）
- 案件に表示名（AIが自動生成、リネーム可能）
- タブ構成: チャット | 基本情報 | [案件部屋: 案件整理 → 書類作成 → チェック]
- Company.caseRooms: CaseRoom[] でデータ保存

### その他
- プロンプトテンプレートのカスタマイズUI

## 設計判断の変更履歴

- **ファイルアクセス**: Google Drive API → **Local-First**（ローカルfs直接読み取り）
- **ファイルキャッシュ**: CachedFile[] → **廃止、ライブ読み取り**
- **サイドバー**: テンプレート表示 → **ファイラー**（会社選択+フォルダツリー）
- **会社/案件セレクター**: ヘッダー → **サイドバーに移動**
- **フォルダ分類**: 設定画面 → **サイドバーのバッジ切替**
- **案件整理+チャット**: 統合 → **分離**（案件整理はテンプレートカード、チャットは専用タブ）
- **書類雛形**: コード内管理 → **ドライブ上のテンプレートフォルダ**（docx+メモ）
- **書類生成**: AI全文生成 → **docxtemplater【プレースホルダー】置換**
- **プレビュー**: Google Drive iframe → **LibreOffice PDF/HTML変換**
- **フォルダロール**: common/job 2種 → **common/job/none 3種**
- **案件フォルダ選択**: 複数選択 → **単一選択**
- **全角変換**: 書類生成時に英数字を全角に

## 運用ルール

- **mainに直接プッシュしない。必ずブランチを切ってPRを作ること**
- コミット後は必ず `git push` まで行うこと
- 作業の区切りごとにこの CLAUDE.md も更新してコミット・プッシュすること
- 別PCでも作業する前提。CLAUDE.md を引き継ぎ書として常に最新に保つこと

## 環境変数（.env.local）

```
ANTHROPIC_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## 開発コマンド

```bash
npm install
npm run dev    # http://localhost:3000
```

## 現在のブランチ

- `feat/local-first` — PR #9: Local-First移行 + UI全面リデザイン
