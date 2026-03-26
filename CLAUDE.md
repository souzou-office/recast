# CLAUDE.md — recast

## プロジェクト概要

**recast**（リキャスト）は、バックオフィス業務を効率化するソフトウェア。
名前の由来：recast = 鋳造し直す。起きた事実を、相手の要求仕様に合う型に流し込み直す。

## 基本思想

### バックオフィス業務の普遍法則

> バックオフィスの仕事とは、起きた事実を、相手の要求仕様に沿った情報へ再構成することである。

法務、税務、労務、記帳——一見別の仕事だが、抽象化すると同じ構造を持つ。

### 業務構造の4分類

| 位置づけ | 要素 | 説明 |
|---------|------|------|
| **本質** | 再構成 | 事実を要求仕様に沿う情報へ組み替える |
| **前提** | 取得 | 材料（資料・情報）を集める |
| **出口** | 入力 | 整えた情報を帳票・システムに流し込む |
| **補助** | 検証 | 間違いを見つける |

### 核心的な価値

> 書類がマスターデータになる。

## 技術スタック

- **フレームワーク**: Next.js 15 + React 19 + TypeScript
- **スタイリング**: Tailwind CSS 4 + @tailwindcss/typography
- **AI**: Anthropic Claude API (claude-sonnet-4-6) + tool use + Haiku (claude-haiku-4-5-20251001)
- **クラウドストレージ**: Google Drive API（OAuth2、読み取り専用）
- **ファイル解析**: pdf-parse（PDF→テキスト）、mammoth（docx→テキスト）、xlsx（Excel→CSV）
- **マークダウン**: react-markdown + remark-gfm

## 現在のアーキテクチャ

### レイアウト
```
[ロゴ] [会社 ▼] [案件 ▼] チャット | 基本情報 | 案件整理 | 突合せ | 書類生成  [🔍] [⚙]
├─[サイドバー]─┤──────────[メインコンテンツ]──────────┤
│ プロンプト   │                                      │
│ テンプレート  │                                      │
│（タブで変化） │                                      │
└──────────┴──────────────────────────────────┘
```

- **ヘッダー**: ロゴ + 会社セレクター + 案件セレクター + タブ + 横断検索(🔍) + 設定(⚙)
- **サイドバー**: チャットタブ→プロンプトテンプレート、案件整理タブ→テンプレート選択（プルダウン+確認項目表示）
- **基本情報以外の全タブにチャット入力欄**

### データ構造
```
data/
  folders.json          — ワークスペース設定（会社・サブフォルダ・プロファイル・マスターシート）
  templates.json        — 案件整理テンプレート
  document-templates.json — 書類雛形
  profile-template.json — 基本情報抽出項目
  prompt-templates.json — プロンプトテンプレート
  chat-history/         — 会社ごとのチャット履歴
  tokens.json           — OAuth トークン（.gitignore済み）
```

### API構成
| パス | 用途 |
|------|------|
| `/api/workspace` | ワークスペース設定CRUD + autoSetupCompany + batchAutoSetup + deleteMasterSheet |
| `/api/workspace/scan` | フォルダスキャン（子フォルダ一覧） |
| `/api/workspace/scan-files` | ファイルスキャン（サブフォルダ含む） |
| `/api/workspace/scan-all` | 全社一括共通フォルダスキャン（SSE進捗） |
| `/api/workspace/profile` | 基本情報の生成（テキスト+structured JSON）・差分更新 |
| `/api/workspace/profile-template` | 基本情報抽出項目のCRUD |
| `/api/workspace/master-sheet` | マスターシートJSON取得・更新 |
| `/api/workspace/toggle-file` | ファイル単位のON/OFF |
| `/api/auth/google` | OAuth フロー |
| `/api/auth/status` | 接続状態確認・解除 |
| `/api/browse` | フォルダブラウザ（Google Drive） |
| `/api/chat` | チャットAPI（SSE、tool use対応） |
| `/api/chat-history` | チャット履歴CRUD |
| `/api/templates` | 案件整理テンプレートCRUD |
| `/api/templates/execute` | テンプレート実行（SSEストリーミング） |
| `/api/templates/suggest` | 案件名からテンプレート推定（Haiku） |
| `/api/templates/generate` | AIでテンプレート項目を自動生成 |
| `/api/templates/save-master` | マスターシートJSON保存（Haikuでマークダウン→JSON変換） |
| `/api/templates/link-sources` | Haikuで各セクションと根拠ファイルを紐付け |
| `/api/prompt-templates` | プロンプトテンプレートCRUD |
| `/api/document-templates` | 書類雛形CRUD |
| `/api/document-templates/generate` | 過去案件ファイルから書類雛形をAI生成 |
| `/api/document-templates/produce` | マスターシート+雛形→書類生成（SSE） |
| `/api/document-templates/suggest-documents` | 必要書類をHaikuが自動提案 |
| `/api/verify` | 突合せ（案件整理結果と書類の相違チェック、SSE） |

## 実装済み機能

### Phase 1: チャット + フォルダ参照 ✅
- Google Drive OAuth連携
- 会社フォルダの直接登録（ドラッグ&ドロップ/チェックボックス）
- ファイル読み取り（PDF、docx、xlsx、doc、画像対応）
- Excel日付シリアル値の自動変換（rawNumbers+自前変換）
- ファイル重複排除（Haikuによる意味レベルグループ化）
- チャットUI（SSEストリーミング、マークダウンレンダリング）
- チャット履歴保存（会社ごとにJSON）
- tool use（基本情報・共通ファイル・横断検索）

### Phase 2: 案件整理 + 基本情報 ✅
- 基本情報の自動生成（テキスト+structured JSON同時出力）
- 基本情報の抽出項目カスタマイズ（設定から編集可能）
- 基本情報のJSON表示/編集機能
- 案件整理（テンプレート選択→全AI読み取り→マークダウン出力→ストリーミング）
- マスターシート保存（HaikuでJSON変換）
- テンプレート管理（作成・編集・AI自動生成・ドラッグ&ドロップ並び替え）
- テンプレート推定（Haikuでフォルダ名から推定）
- 各セクション見出し横に根拠ファイルリンク（Haiku紐付け）
- ファイルプレビューワー（Google Drive iframe、左右分割）
- 横断検索（search_all_companies tool + 横断検索タブ）
- 横断検索結果の会社名クリックで基本情報タブに遷移

### Phase 3: 書類自動生成 🔧 作業中
- 書類雛形管理（ファイルからAI雛形生成、マスター+パーツ階層）
- 必要書類のAI自動提案（Haiku）
- 書類生成（マスターシート+雛形→AI生成、SSEストリーミング）
- 突合せ（案件整理結果と書類の相違チェック、チャット形式で結果表示）
- 突合せファイル選択（Google Driveブラウザ、ドラッグ&ドロップ）

### UI改善
- ロゴ（logo_C）をヘッダーに表示、ファビコン設定
- サイドバー廃止→ヘッダーに会社/案件セレクター+タブ統合
- サイドバー復活（テンプレート表示用、タブで内容切替）
- 設定タブ（会社登録・共通フォルダ・抽出項目・書類雛形を統合）
- フォルダ自動セットアップ（1社分類→全社自動適用）
- サブフォルダ再帰表示（全階層のファイルにチェックボックス）
- 基本情報以外の全タブにチャット入力欄

## 未完了・作業中のタスク（次セッションで対応）

### サイドバーからCaseOrganizerへのテンプレート実行接続（途中）
- page.tsxの`executeTemplateId`ステートとTemplateSidebar→CaseOrganizerの接続が未完了
- サイドバーの「案件を整理」ボタンクリック→CaseOrganizerのhandleExecuteが呼ばれるようにする

### プロンプトテンプレートのカスタマイズUI
- 設定タブにプロンプトテンプレート管理セクションを追加（API作成済み、UI未完了）
- 案件整理テンプレートの設定UIも設定タブに統合

### 0. Local-Firstアーキテクチャ移行（最優先）

**目的:** Google Drive APIベースの遅い設計から、ローカルファイルシステム優先に切り替え。速度・UXを根本的に改善。

**背景:**
- Google Drive API経由だとフォルダスキャン・ファイル読み取りが遅く、CachedFile[]の事前キャッシュ、セットアップ画面での手動設定が必要だった
- ローカルなら`fs.readdir`/`fs.readFile`で即時。設定レイヤーが丸ごと不要になる
- Google Drive for Desktop / Dropboxがローカル同期してくれるので、ユーザーはPCのフォルダを指定するだけ

**設計:**
- ローカルfsがプライマリ。クラウドAPIはポータビリティ用バックグラウンド処理
- CachedFile[]廃止 → ライブ読み取り。disabledFiles（OFFリスト）のみ保存
- サイドバーのセットアップ画面廃止 → ファイラー化（フォルダ開く＝ファイルが見える＝AIの参照対象）
- 共通フォルダはdefaultCommonPatternsで自動分類。1社設定＝全社完了
- 既存ファイルへの書き込み禁止。readFile/readdirのみ。新規ファイル作成のみ許可

**実装フェーズ:**
1. バイナリパーサー共通化（PDF/docx/xlsx解析をfiles-google.tsから抽出）
2. 型定義変更（CachedFile廃止、ID→ローカルパス、disabledFiles追加、LiveFile新設）
3. ライブファイル一覧API（scan-files廃止、list-files新設）
4. ワークスペースAPI Local-First化（ベースフォルダ設定で全社自動セットアップ）
5. チャットAPIローカル読み取り対応（readFileById→readLocalFile）
6. フロントエンド（セットアップ画面削除、サイドバー＝ファイラー）
7. バックグラウンドクラウドID紐付け（後回し可）
8. クリーンアップ（scan-files, CompanyDetail.tsx削除）

### 書類雛形の登録フロー改善
- ファイルからAI雛形生成は実装済み
- マスター+パーツの階層構造は実装済み
- 書類雛形管理を設定タブのインライン表示に統合済み

### 書類生成結果の改善
- 生成結果の保存・エクスポート（Word/PDF出力）

### D. チャットのスレッド管理
- GPTのようにチャットをスレッド単位で管理
- 会社ごとのスレッド一覧

### ドロップダウン外クリックで閉じる処理
- 会社セレクター、案件セレクターのドロップダウンが外クリックで閉じない

## 設計判断の変更履歴

- **クラウドストレージ**: ローカル同期フォルダ経由 → **Google Drive API直接連携**
- **フォルダ構造**: ベースフォルダ → **会社フォルダ直接登録**（baseFolders概念を廃止）
- **フォルダセットアップ**: 手動設定画面 → **自動セットアップ**（1社分類→全社適用）
- **ファイル重複排除**: 正規表現 → **Haikuによる意味レベルのグループ化**
- **基本情報**: フリーテキストのみ → **テキスト+structured JSON同時出力**（表示は旧形式、裏でJSON保存）
- **テンプレート実行結果**: マークダウンのみ → **マスターシート（structured JSON）として保存**
- **テンプレート推定**: キーワードマッチ → **Haiku推定**
- **案件整理**: チャットタブ内 → **独立タブ**
- **横断検索・設定**: タブ → **ヘッダー右のアイコン**
- **サイドバー**: 登録系UI全部入り → **テンプレート表示のみ**（登録系は設定タブに統合）
- **全タブ**: 基本情報以外にチャット入力欄を追加
- **AIモデル**: claude-sonnet-4-20250514 → **claude-sonnet-4-6**
- **ファイルアクセス**: Google Drive API直接連携 → **Local-First（ローカルfs優先）**に変更。Google Drive for Desktop / Dropboxのローカル同期フォルダを直接読む。クラウドAPIはポータビリティ用バックグラウンド処理に格下げ。理由: API経由は遅く、事前スキャン・キャッシュ・設定UIが複雑化する原因だった
- **ファイルキャッシュ**: CachedFile[]を事前スキャンしてfolders.jsonに保存 → **ライブ読み取り（fs.readdir/fs.readFile）**に変更。キャッシュ不要、disabledFiles（OFFにしたファイル一覧）のみ保存
- **フォルダ設定**: 会社ごとにセットアップ画面でサブフォルダのロールを手動設定 → **defaultCommonPatternsで自動分類、セットアップ画面廃止**。1社分類したら全社に自動適用
- **ファイル安全性**: 既存ファイルへの書き込み一切禁止。読み取り専用（fs.readFile/fs.readdir）。新規ファイルの作成のみ許可（Phase 3用）

## 運用ルール

- **mainに直接プッシュしない。必ずブランチを切ってPRを作ること**
- コミット後は必ず `git push` まで行うこと
- 作業の区切りごとにこの CLAUDE.md も更新してコミット・プッシュすること
- 別PCでも作業する前提。CLAUDE.md を引き継ぎ書として常に最新に保つこと
- 設計判断の変更があった場合はこのファイルに記録すること
- data/templates.json等のデータファイルはgit管理のため、merge時に上書きに注意

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

- `feat/document-template-modal` — PR #5（未マージ）: 書類雛形管理、突合せ、設定タブ統合、サイドバー改修、フォルダ自動セットアップ等の大量変更
