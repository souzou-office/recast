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

## 設計判断の変更履歴

- **クラウドストレージ**: ローカル同期フォルダ経由 → **Google Drive API直接連携**に変更（ウェブデプロイ前提）
- **フォルダ構造**: フラットな共通/個別 → **ワークスペース型**（ベースフォルダ→会社→サブフォルダ）に変更
- **ファイル読み取り**: テキストのみ → **PDF（テキスト抽出+base64フォールバック）、docx、xlsx対応**
- **基本情報**: チャットに毎回渡す → **tool useで必要時のみ参照**
- **テンプレート**: source区分（サマリー/指示書/原文）あり → **全AI読み取りに統一**（シンプル化）
- **テンプレート作成**: 手動で1項目ずつ → **AIが案件タイプ名から自動生成**

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
