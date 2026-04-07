# チャット統合型ワークフロー設計書

## 背景・課題

### 現状の問題

1. **案件整理タブの存在意義** — 案件整理は書類生成のための中間データ（masterSheet）を作る処理。ユーザーがマークダウン出力を直接参照する必要性が薄い
2. **書類生成の精度** — AIが曖昧な情報を勝手に解釈して埋めてしまう。人間に頼んだら「ここどちらですか？」と聞いてくるのに、AIは聞かずに突っ走る
3. **タブ切替が手順知識を前提にしている** — 案件整理→書類作成→チェックの順番を知らないと使えない
4. **チャットと業務フローが分離している** — 自由質問も業務フローもAIとのやりとりなのに、別タブに分かれている

### 目指す姿

ChatGPT/Claude のようなチャットUIに業務ワークフローを統合する。ただし「会話が主役」のChatGPTとは異なり、**「書類（ファイル）が主役」でチャットは操作インターフェース**。

---

## 全体構成

### レイアウト

```
ヘッダー:    [ロゴ recast]                          [🔍横断検索] [⚙設定]
            ┌──────────────┬──────────────────────────┬──────────────┐
            │ サイドバー     │ メイン: チャット           │ 右パネル:     │
            │              │                          │ 書類プレビュー │
            │ 会社セレクター │ メッセージ + カード        │              │
            │              │                          │ ファイルチップ │
            │ チャット履歴   │                          │ (🔵生成/⚪元資料)│
            │ (日付グループ) │                          │              │
            │              │                          │ プレビュー本体 │
            │              │                          │              │
            │              │ [入力欄____________][送信] │              │
            └──────────────┴──────────────────────────┴──────────────┘
```

### 変更前 → 変更後

```
ヘッダー:  [ロゴ] チャット|基本情報|案件整理|書類生成|チェック [🔍][⚙]
                              ↓
ヘッダー:  [ロゴ]                                          [🔍][⚙]

サイドバー: 会社セレクター + ファイルツリー
                              ↓
サイドバー: 会社セレクター + チャット履歴

メイン:    タブごとに異なるUI
                              ↓
メイン:    統一チャットUI（メッセージ + アクションカード）
```

---

## ワークフロー

### 全体の流れ

```
[新規チャット]
  ↓
Step 1: フォルダ選択カード（案件フォルダ一覧）
  ↓
Step 2: ファイル選択カード（チェックボックス）
  ↓
Step 3: テンプレート選択カード（書類テンプレート一覧）
  ↓
  (バックグラウンドで案件整理＝masterSheet生成)
  ↓
Step 4: 確認カード（選択式Q&A）※質問なければスキップ
  ↓
Step 5: 生成完了カード（プレビュー+DLリンク）→ 右パネルに書類表示
  ↓
Step 6: チェック提案カード（「チェックする？」）
  ↓
Step 7: チェック結果カード（表形式）
  ↓
  自由チャット継続可能（「ここ直して」「共通フォルダ変わった」等）
```

途中どのステップでも自由入力で質問可能。

### 各ステップの詳細

#### Step 1: フォルダ選択

```
🤖 案件フォルダを選んでください

  📁 01_役員変更（3ファイル）
  📁 02_本店移転（5ファイル）
  📁 03_決算（2ファイル）
```

#### Step 2: ファイル選択

```
🤖 以下のファイルを使います。外すものがあればチェックを外してください

  ☑ 臨時株主総会議事録.docx
  ☑ 就任承諾書.pdf
  ☑ 本人確認書類.pdf
  ☐ 見積書_ボツ.xlsx

  [これで進める]
```

#### Step 3: テンプレート選択

```
🤖 書類テンプレートを選んでください

  [役員変更]  [本店移転]  [定款変更]  ...
```

#### Step 4: 確認Q&A（質問がある場合のみ）

```
🤖 2点確認があります

  Q1. 【本店所在地】— 登記簿と定款で住所が異なります
      ○ 東京都千代田区...（登記簿 2024/03/01）
      ○ 東京都港区...（定款 2023/06/15）
      ○ 手動入力 [____________]

  Q2. 【届出日】— 資料に記載がありません
      ○ （要確認）のまま生成
      ○ 手動入力 [____________]

  [← 戻る]  [生成する →]
```

確信度の高い項目は質問せず自動解決。全項目確信度高ければスキップ。

#### Step 5: 生成完了

```
🤖 書類を生成しました ✅

  📄 臨時株主総会議事録  [プレビュー] [DL]
  📄 就任承諾書          [プレビュー] [DL]
```

[プレビュー] クリックで右パネルに表示。

#### Step 6-7: チェック

```
🤖 生成した書類をチェックしますか？
   [チェックする]

🤖 チェック結果

  ✅ 全体: 整合性OK

  | 項目       | 参照データ       | 書類         | 結果 |
  |-----------|-----------------|-------------|------|
  | 代表取締役 | 鈴木一郎         | 鈴木一郎     | ✅   |
  | 就任日    | 2024年4月1日     | 2024年4月1日 | ✅   |
```

### 自由チャットとの共存

同じ入力欄から両方使える:

- カードをクリック → ワークフロー進行
- テキスト入力 → 自由質問（「この会社の決算期いつ？」）
- ワークフロー途中でも自由質問可能
- 「共通フォルダ変わった」→ tool use で共通ファイル再読み込み + 基本情報更新

---

## サイドバー

### 構成

```
┌──────────────────────┐
│ [会社セレクター ▼]     │  ← 検索付きドロップダウン
├──────────────────────┤
│ [+ 新規チャット]       │
│                        │
│ 今日                   │
│ 💬 役員変更の件         │
│ 💬 定款変更            │
│                        │
│ 昨日                   │
│ 💬 本店移転手続き       │
│                        │
│ 先週                   │
│ 💬 決算関連書類         │
└──────────────────────┘
```

- 会社ごとにチャット履歴を表示
- 日付グルーピング（今日/昨日/先週/それ以前）
- 各スレッド: displayName + 最終更新時刻
- 右クリック or ホバー: 名前変更/削除

### ファイルツリーの扱い

ファイルツリーは廃止。代わりに:

- **フォルダ選択**: チャット内カードで表示
- **ファイルON/OFF**: チャット内カードで操作
- **共通フォルダ設定**: ⚙設定画面で管理（初期設定時のみ）
- **ファイル変更通知**: チャットで「変わった」と言えばtool useで再読み込み

---

## 右パネル（書類プレビュー）

### 基本構成

```
┌─────────────────────┐
│ 📄議事録 📄承諾書 📄登記簿│  ← ファイルチップ（クリックで切替）
│  🔵生成   🔵生成   ⚪元資料│     🔵=生成書類 ⚪=元資料
├─────────────────────┤
│                      │
│  (選択中ファイルの     │
│   プレビュー表示)      │
│                      │
│                      │
│                      │
│         [DL]         │
└─────────────────────┘
```

### 動作

- チャット内の [プレビュー] クリック → 右パネルに追加 & 表示
- チップの × で閉じる
- 生成書類はプレビューHTML表示
- 元資料は既存FilePreviewの仕組みを流用（PDF/Word/Excel/画像対応）
- 書類が再生成されたら自動で最新版に更新

### 将来拡張（初期実装では不要）

- 上下分割表示（書類 + チェック結果を同時に見る）

---

## データ構造

### ChatThread（CaseRoom + chat-history を統合）

```typescript
interface ChatThread {
  id: string;                         // "thread_" + timestamp
  companyId: string;
  displayName: string;                // AI自動命名 or ユーザー編集
  messages: ChatMessage[];
  // ワークフロー成果物
  folderPath?: string;                // 選択された案件フォルダ
  disabledFiles?: string[];           // 除外ファイル
  masterSheet?: MasterSheet;
  generatedDocuments?: GeneratedDocument[];
  checkResult?: string;
  // メタ
  createdAt: string;
  updatedAt: string;
}
```

### ChatMessage

```typescript
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;                    // テキスト部分
  cards?: ActionCard[];               // インタラクティブカード
  timestamp: string;
}
```

### ActionCard（チャット内UIパーツ）

```typescript
type ActionCard =
  | FolderSelectCard
  | FileSelectCard
  | TemplateSelectCard
  | ClarificationCard
  | DocumentResultCard
  | CheckPromptCard
  | CheckResultCard;

interface FolderSelectCard {
  type: "folder-select";
  folders: { name: string; path: string; fileCount: number }[];
  selectedPath?: string;              // 選択後にセット
}

interface FileSelectCard {
  type: "file-select";
  folderPath: string;
  files: { name: string; path: string; enabled: boolean }[];
  confirmed?: boolean;                // 確定後にtrue
}

interface TemplateSelectCard {
  type: "template-select";
  templates: { name: string; path: string; fileCount: number }[];
  selectedPath?: string;
}

interface ClarificationCard {
  type: "clarification";
  questions: ClarificationQuestion[];
  answered?: boolean;
}

interface ClarificationQuestion {
  id: string;
  placeholder: string;               // 対象プレースホルダー名
  question: string;                   // 質問文
  options: {
    id: string;
    label: string;                    // 選択肢テキスト（値そのもの）
    source: string;                   // 出典（"登記簿 2024/03/01"等）
  }[];
  selectedOptionId?: string;
  manualInput?: string;               // 手動入力時の値
}

interface DocumentResultCard {
  type: "document-result";
  documents: {
    name: string;
    fileName: string;
    docxBase64: string;
    previewHtml: string;
  }[];
}

interface CheckPromptCard {
  type: "check-prompt";
  accepted?: boolean;
}

interface CheckResultCard {
  type: "check-result";
  content: string;                    // マークダウン（表形式）
}
```

### PreviewPanel（右パネル状態）

```typescript
interface PreviewPanel {
  openFiles: PreviewFile[];
  activeFileId: string | null;
}

interface PreviewFile {
  id: string;
  name: string;
  type: "source" | "generated";
  filePath?: string;                  // sourceの場合
  docxBase64?: string;               // generatedの場合
  previewHtml?: string;              // generatedの場合
}
```

### ストレージ

```
data/
  folders.json              — ワークスペース設定（会社・サブフォルダ）
  chat-threads/
    {companyId}/
      {threadId}.json        — スレッドごとにファイル分離
  templates.json             — 案件整理テンプレート（設定用）
  profile-template.json      — 基本情報抽出項目
```

---

## API構成

### 新規

| パス | メソッド | 用途 |
|------|---------|------|
| `/api/chat-threads` | GET | スレッド一覧（companyId指定、メッセージ本文除く） |
| `/api/chat-threads` | POST | 新規スレッド作成 |
| `/api/chat-threads/[threadId]` | GET | スレッド詳細（メッセージ込み） |
| `/api/chat-threads/[threadId]` | PATCH | 更新（名前変更、メッセージ追加） |
| `/api/chat-threads/[threadId]` | DELETE | 削除 |
| `/api/chat-threads/[threadId]/action` | POST | カード操作→次ステップ返却 |
| `/api/document-templates/clarify` | POST | 確認質問リスト生成 |

### 変更

| パス | 変更内容 |
|------|---------|
| `/api/document-templates/produce` | `clarificationAnswers` パラメータ追加 |
| `/api/chat` | `reload_common_files` tool 追加 |

### 廃止候補

| パス | 理由 |
|------|------|
| `/api/chat-history` | chat-threads に統合 |

---

## 実装フェーズ

### Phase 1: 型定義

- `src/types/index.ts` に ChatThread, ChatMessage, ActionCard 等を追加

### Phase 2: チャットスレッドAPI

- `src/app/api/chat-threads/` — CRUD + action エンドポイント
- `data/chat-threads/` ディレクトリでファイルベース永続化

### Phase 3: サイドバー改修

- 会社セレクター + チャット履歴一覧
- 新規チャットボタン
- 日付グルーピング
- スレッド名変更/削除

### Phase 4: チャットUI（メイン画面）

- `src/components/ChatWorkflow.tsx` — メッセージ表示 + 入力欄
- 既存 ChatView.tsx のストリーミング基盤を流用

### Phase 5: カードコンポーネント群

- `FolderSelectCard.tsx`
- `FileSelectCard.tsx`
- `TemplateSelectCard.tsx`
- `ClarificationCard.tsx`
- `DocumentResultCard.tsx`
- `CheckResultCard.tsx`
- 各カードは操作後にロック（再操作不可、薄いグレー表示）

### Phase 6: 右パネル（書類プレビュー）

- ファイルチップ（生成書類🔵 / 元資料⚪）
- プレビュー表示（既存FilePreview流用）
- チャット内カードとの連動

### Phase 7: ワークフローエンジン

- `src/lib/workflow-engine.ts`
- カード操作に応じて次ステップを決定
- 案件整理のバックグラウンド自動実行

### Phase 8: clarify API

- `src/app/api/document-templates/clarify/route.ts`
- プレースホルダー抽出→データ矛盾検出→質問リスト生成
- masterSheet未生成なら自動で案件整理実行

### Phase 9: produce API 拡張

- `clarificationAnswers` でユーザー回答を受け取り
- 回答済みの値はAI出力より優先してテンプレートに適用

### Phase 10: 整理・移行

- ヘッダーからタブ削除
- 旧コンポーネント削除（CaseOrganizer, CaseRoomView, DocumentGenerator の UI部分）
- 既存 caseRooms データ → chatThreads への移行
- chat tool に `reload_common_files` 追加

---

## ChatGPTとの違い（設計の前提）

| | ChatGPT | recast |
|---|---------|--------|
| 主役 | 会話 | 書類（ファイル） |
| ファイル | アップロード→使い捨て | ローカル同期フォルダに常在 |
| 出力 | 画面上のテキスト | docxファイル（実務成果物） |
| フロー | 自由会話 | ガイド付きワークフロー + 自由会話 |
| 構造 | フラットなスレッド | 会社×案件の階層 |
| 検証 | なし | 生成→突合せのループ |
| 右パネル | 補助的 | 本体の半分（書類を常に参照） |

---

## リスク・判断ポイント

| 項目 | 対策 |
|------|------|
| 変更量が大きい | Phase 4まで（チャット表示）を先に動かし、ワークフローは段階的に追加 |
| 既存データとの互換 | caseRooms → chatThreads の移行スクリプトを用意 |
| カード操作の状態管理 | カードの状態は ChatMessage 内に保存。リロードしても復元 |
| 自由チャットとワークフローの混在 | テキスト入力→chat API、カード操作→action API。入力欄は共通 |
| 案件整理を完全に消すか | バックグラウンド処理化。結果はチャット内で折りたたみ確認可能 |
| clarifyで質問0件の場合 | 自動スキップして直接生成 |
| 共通フォルダ変更時 | 自動検知はしない。ユーザーがチャットで言えばtool useで再読み込み |
