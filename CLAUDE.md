# CLAUDE.md — recast

## プロジェクト概要

**recast**（リキャスト）は、バックオフィス業務を効率化するソフトウェア。
名前の由来：recast = 鋳造し直す。起きた事実を、相手の要求仕様に合う型に流し込み直す。

## 基本思想

### バックオフィス業務の普遍法則

> バックオフィスの仕事とは、起きた事実を、相手の要求仕様に沿った情報へ再構成することである。

法務、税務、労務、記帳——一見別の仕事だが、抽象化すると同じ構造を持つ。

- すでに起きた事実がある
- その事実は、メール・PDF・指示書・本人確認資料・通帳・領収書・定款・登記情報などに散らばっている
- それをそのまま提出先に渡しても使えない
- だから人が必要な情報を拾い、相手が処理できる形に整えている

### 業務構造の4分類

| 位置づけ | 要素 | 説明 |
|---------|------|------|
| **本質** | 再構成 | 事実を要求仕様に沿う情報へ組み替える |
| **前提** | 取得 | 材料（資料・情報）を集める |
| **出口** | 入力 | 整えた情報を帳票・システムに流し込む |
| **補助** | 検証 | 間違いを見つける |

価値の中心は「再構成」。

## 技術スタック

- **フレームワーク**: Next.js 15 + React 19 + TypeScript
- **スタイリング**: Tailwind CSS 4 + @tailwindcss/typography
- **AI**: Anthropic Claude API (claude-sonnet-4-20250514) + tool use
- **クラウドストレージ**: Google Drive API（OAuth2、読み取り専用）
- **ファイル解析**: pdf-parse（PDF→テキスト）、mammoth（docx→テキスト）、xlsx（Excel→CSV）
- **マークダウン**: react-markdown + remark-gfm

## アーキテクチャ

### データ構造
```
data/
  folders.json     — ワークスペース設定（WorkspaceConfig）
  templates.json   — 案件整理テンプレート
  tokens.json      — OAuth トークン（.gitignore済み）
```

### WorkspaceConfig の構造
```
baseFolder: Google Driveの起点フォルダ
defaultCommonPatterns: デフォルト共通フォルダ名パターン（全会社適用）
companies: [
  {
    name: "会社名"
    subfolders: [
      { name: "01.定款", role: "common", files: [CachedFile...] }
      { name: "202308dd_役員就任", role: "job", active: true, files: [...] }
    ]
    profile: { summary: "基本情報サマリー", sourceFiles: [...] }
  }
]
selectedCompanyId: 選択中の会社
```

### API構成
| パス | 用途 |
|------|------|
| `/api/workspace` | ワークスペース設定CRUD |
| `/api/workspace/scan` | フォルダスキャン（子フォルダ一覧） |
| `/api/workspace/scan-files` | ファイルスキャン（重複排除付き） |
| `/api/workspace/profile` | 基本情報の生成・差分更新 |
| `/api/workspace/toggle-file` | ファイル単位のON/OFF |
| `/api/workspace/check` | 確認事項一覧生成（旧・未使用） |
| `/api/auth/google`, `/api/auth/dropbox` | OAuth フロー |
| `/api/auth/status` | 接続状態確認・解除 |
| `/api/browse` | フォルダブラウザ（ローカル/Google/Dropbox） |
| `/api/chat` | チャットAPI（SSE、tool use対応） |
| `/api/templates` | テンプレートCRUD |
| `/api/templates/execute` | テンプレート実行（全AI読み取り） |
| `/api/templates/suggest` | 案件名からテンプレート推定 |
| `/api/templates/generate` | AIでテンプレート項目を自動生成 |
| `/api/debug` | デバッグ用（ファイル読み取り確認） |

### 画面構成
```
[サイドバー]          [メインエリア]
├ クラウド接続         タブ: チャット | 基本情報
├ 会社セレクター
│  (ドロップダウン+検索) チャットタブ:
├ フォルダタブ         ├ メッセージ一覧（マークダウン対応）
│  ├ 常時参照          ├ ショートカットボタン（案件を整理）
│  │  └ ファイル一覧   └ 入力欄
│  ├ 案件（ワンタップ切替）
│  └ フォルダ設定      基本情報タブ:
└ フッター             ├ 会社名・生成ボタン
   ├ ベース変更        ├ セクション別テーブル（登記簿/定款/株主）
   └ 会社更新          ├ 参照元資料（リンク+プレビュー）
                       └ ファイルプレビューワー（左右分割・リサイズ可能）
```

## 実装済み機能

### Phase 1: チャット + フォルダ参照 ✅
- Google Drive OAuth連携（読み取り専用）
- ワークスペース型フォルダ管理（ベースフォルダ→会社→サブフォルダ）
- ファイル読み取り（PDF→テキスト抽出 or base64、docx、xlsx対応）
- ファイルスキャン・キャッシュ・重複排除（同名ファイルは最新のみ有効）
- デフォルト共通フォルダパターン（全会社一括適用）
- チャットUI（SSEストリーミング、マークダウンレンダリング）
- tool use（基本情報・共通ファイルを必要時のみ参照）

### Phase 2: ショートカットボタン（取得フェーズ） 🔧 作業中
- 基本情報の自動生成（登記簿・定款・株主名簿からAIが抽出）
- 基本情報の表形式表示（セクション分け、カード型）
- ファイルプレビューワー（Google Drive iframe、左右分割リサイズ）
- 「案件を整理」ボタン（テンプレート選択→全AI読み取り→マークダウン出力）
- テンプレート管理（作成・編集・AI自動生成）
- テンプレート自動推定（案件フォルダ名からマッチ）

### Phase 3: 自動転記 ❌ 未着手

## 次の実装予定

### A. 共通フォルダのファイル重複排除AI化

**目的:** 名前が違っても実質同じ書類ならAIが判定して最新だけONにする（人間の手動管理を削減）

- **対象:** 共通フォルダ（role: "common"）のみ。案件フォルダ（role: "job"）は対象外
- **現状:** `normalizeName()` 正規表現で文字列一致グループ化 → 限界あり（「登記簿謄本」と「履歴事項全部証明書」が別扱い）
- **変更:** 正規表現を廃止 → Haiku（claude-haiku-4-5-20251001）にファイル名一覧を投げて意味レベルでグループ化
- **トリガー:** scan-files時（フォルダスキャン、新ファイル検出時）
- **フロー:**
  1. Google Driveからファイル一覧取得（今と同じ）
  2. ファイル名の配列をHaikuに投げる
  3. Haikuが「実質同じ書類」をグループ化してJSON返却
  4. 各グループ内でmodifiedTime最新だけ `enabled: true`
  5. ユーザーは手動toggle可能（今と同じ）
- **判定例:**
  - 「登記簿謄本」=「履歴事項全部証明書」→ 同グループ
  - 「定款」=「定款_改定版」=「定款(公証役場認証済み)」→ 同グループ
  - 「株主名簿」≠「株主総会議事録」→ 別グループ
- **normalizeName() / deduplicateFiles() は削除してHaikuに完全置き換え**

### B. 基本情報の構造化（横断検索対応）

**目的:** 複数会社の横断検索を可能にする。全社のstructuredをtoolで渡してClaudeが検索。

- **変更点:** 基本情報生成時に `summary`（フリーテキスト）と同時に `structured`（JSON）も生成・保存
- **型定義:**
  ```ts
  CompanyProfile {
    summary: string              // 今と同じ（表示・チャット用）
    structured: {                // 追加（横断検索用）
      会社法人等番号: string
      商号: string
      本店所在地: string
      設立年月日: string
      事業目的: string[]
      資本金: string
      発行可能株式総数: string
      発行済株式総数: string
      株式の譲渡制限: string
      役員: { 役職: string, 氏名: string, 住所?: string, 就任日?: string, 任期満了?: string }[]
      新株予約権: string
      公告方法: string
      決算期: string
      役員の任期: string
      株主: { 氏名: string, 住所?: string, 持株数?: string, 持株比率?: string }[]
      備考?: string
    }
    updatedAt: string
    sourceFiles: ...
  }
  ```
- **項目:** 現行のプロンプト（EXTRACT_PROMPT）と同一。チェック項目としても横断検索としても必要
- **横断検索:** 新tool `search_all_companies` → 全社の `structured` を渡す（200社で約40Kトークン、許容範囲）
- **個社深掘り:** 今と同じ `get_company_profile` で `summary` を返す

### C. 複数ルートフォルダ対応

**目的:** 会社が複数のGoogle Driveフォルダに分かれている場合に対応（例：1〜100社はフォルダA、101〜200社はフォルダB）

- **変更:** `baseFolder: string` → `baseFolders: { id, name, folderId }[]` + `selectedBaseFolderId: string`
- **表示・操作は1ルートずつ** — 選択中のルート配下の会社のみ会社セレクターに表示
- **横断検索は全ルート対象** — Bのstructuredは全社分保存されているので、ルートに関係なく検索可能
- **前回選択を記憶** — `selectedBaseFolderId` を保存。次回起動時はそのまま前回のルートが出る。切り替えは必要な時だけ
- **UIはベース変更ボタンを拡張** — 複数ルートの登録・切り替えをここで行う

## 設計判断の変更履歴

- **クラウドストレージ**: ローカル同期フォルダ経由 → **Google Drive API直接連携**に変更（ウェブデプロイ前提）
- **フォルダ構造**: フラットな共通/個別 → **ワークスペース型**（ベースフォルダ→会社→サブフォルダ）に変更
- **ファイル読み取り**: テキストのみ → **PDF（テキスト抽出+base64フォールバック）、docx、xlsx対応**
- **基本情報**: チャットに毎回渡す → **tool useで必要時のみ参照**
- **テンプレート**: source区分（サマリー/指示書/原文）あり → **全AI読み取りに統一**（シンプル化）
- **テンプレート作成**: 手動で1項目ずつ → **AIが案件タイプ名から自動生成**
- **ファイル重複排除**: 正規表現ベースの文字列一致 → **Haikuによる意味レベルのグループ化**に変更予定（共通フォルダのみ）
- **基本情報**: フリーテキストsummaryのみ → **structured（JSON）を追加**予定（横断検索対応）

## 運用ルール

- コミット後は必ず `git push` まで行うこと
- 作業の区切りごとにこの CLAUDE.md も更新してコミット・プッシュすること
- 別PCでも作業する前提。CLAUDE.md を引き継ぎ書として常に最新に保つこと
- 設計判断の変更があった場合はこのファイルに記録すること

## 環境変数（.env.local）

```
ANTHROPIC_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
DROPBOX_APP_KEY=
DROPBOX_APP_SECRET=
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## 開発コマンド

```bash
npm install
npm run dev    # http://localhost:3000
```

※ PowerShellで実行ポリシーエラーが出る場合は `cmd` から実行
