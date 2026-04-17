# CLAUDE.md — recast

## プロジェクト概要

**recast**（リキャスト）は、バックオフィス業務を効率化するソフトウェア。
名前の由来：recast = 鋳造し直す。起きた事実を、相手の要求仕様に合う型に流し込み直す。

## 基本思想

> バックオフィスの仕事とは、起きた事実を、相手の要求仕様に沿った情報へ再構成することである。

### 核心的な価値

> 書類がマスターデータになる。

## 展開方針

現状はローカル開発（`npm run dev`）だが、**将来はWeb展開**を想定する。

- **UIはWeb**: Next.jsをホストしてブラウザからアクセスする形
- **ファイル読み取りは各ユーザーのローカル**: ブラウザのFile System Access API等で、顧問先フォルダにクライアント側から直接アクセス。**ファイル本体はサーバーを経由しない**
- **サーバーの責任**: 認証、AI API呼び出し、docx生成・変換処理、（将来）共通設定の配信
- **顧客データの所在**: 各ユーザーのローカルに留まり、サーバーには永続化しない

### 新規コード原則（Web展開への布石）

- **ファイルの受け渡しはパスではなくコンテンツで**（base64 / text）
  - 新規APIで `fileIds: string[]` → サーバー側 `fs` 読み込み、の形は使わない
  - クライアントで読み取り → APIへ base64 / text で送る
- **サーバー側 `fs` 直接読み込みのコードを新規では増やさない**
  - 既存の `/api/workspace/list-files`, `/api/workspace/read-file` 等は段階的に置き換え予定
- **LibreOffice依存の新機能を追加しない**
  - 新規プレビューはブラウザ側レンダリング（docx-preview, mammoth等）を検討
  - 既存の `/api/workspace/preview-pdf`, `preview-html` も将来的に置換候補

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
| `/api/verify` | 突合せ（原本 vs 生成済み書類の相違チェック、表形式レポート） |

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
- テンプレートフォルダ方式（ドライブ上のdocx/xlsx+メモファイル）
- **2方式併存**:
  - **プレースホルダー方式**: `{{会社名}}` `【会社名】` `｛｛会社名｝｝` 等を検出→AIが値生成→docxtemplater置換
  - **ハイライト方式（新）**: 過去案件の完成書類に黄色ハイライトを引く。recastが★マーク付きテキストに変換→AIが新案件のデータで値生成→置換（ハイライトも除去）
- **Word条件分岐**: `{{#出資者は法人}}...{{/出資者は法人}}` で法人/個人/組合の出し分け（docxtemplater sections）
- **Excelハイライト方式**: xlsxのセル背景色（黄色=FFFFFF00）を検出→★マーク付きテキストで値生成→置換＋背景色除去（xlsx-marker-parser.ts）
- 複数docx一括生成、人数分展開（AI配列応答→株主ごとに書類生成）
- Word: 英数字全角変換 / Excel: 全角→半角統一（数式が動くように）
- Excel: 日付（年月日を含む値）だけ全角数字に戻す
- Excel: 置換後の純数値セルを自動で数値型に変換（t="s"→数値、数式エラー防止）
- Excel: 置換値のXMLエスケープ、rPh/phoneticPr削除、calcChain削除
- 単位重複の自動除去、全角デリミタ `｛｛｝｝ 【】` → 半角 `{{}}` 自動正規化
- 入れ子段落対策: `<mc:AlternateContent>`/`<w:drawing>`/`<w:pict>`/`<wps:txbx>`/`<v:textbox>` を一時マスクして段落正規表現を壊さない（figure内の通常段落末尾のハイライトも拾える）
- 案件整理の最新テキストをmasterContent引数で直接渡せる（SSE後にfullTextを明示渡し＝setState closure遅延対策）
- チャット内右ペインでの生成書類プレビュー、生成書類の一括ZIPダウンロード
- 生成書類の保存・一覧・プレビュー・ダウンロード

### 突合せ（チェック）✅
- **原本（共通+案件フォルダ）vs 生成済み書類（docxBase64→mammothテキスト抽出）** の突合せ
- company / caseRoom / スレッド内の generatedDocuments から取得
- 表形式レポート出力（チェック観点・生成書類・問題内容・原本の正しい値・重要度）
- 生成書類がない場合はエラー表示
- 結果削除機能
- **verify のインプットはシンプル**: テンプレ注意事項・共通ルールは渡さない（原本 vs 生成書類の純粋な突合せ）
- 「テンプレの前案件の値と比較してはいけない」旨をプロンプトに明記

### 確認質問（clarify）✅
- 書類生成前に、プレースホルダー/ハイライトが求める値で情報が足りないものをAIが検出→質問カードを表示
- **ループ化**: 回答を `previousQA` として渡して再チェック、質問が尽きるまで繰り返す
- 全質問に回答するまで「生成する→」ボタンを無効化
- テンプレフォルダ内のメモ(.txt/.md)を「チェック観点の源泉」として参照
- ハイライトテンプレの場合も、フィールドの種類（日付/住所/人名/法人名/数値）を抽出して質問

### 統一ヘルパー ✅
- **`src/lib/read-case-files.ts`**: 共通フォルダ+案件フォルダ読み込みを統一。`folderPath` 優先、なければ `sub.active` フォールバック。execute/clarify/produce/verify 全て同じロジック
- **`src/lib/global-rules.ts`**: `templateBasePath` 配下を再帰読み込み（docx含む）。選択中のテンプレフォルダ自体は除外
- **`src/lib/docx-marker-parser.ts`**: Word docx のハイライト検出・★マーク付きテキスト生成・置換・ハイライト除去
- **`src/lib/xlsx-marker-parser.ts`**: Excel xlsx のセル背景色（黄色）検出・★マーク付きテキスト生成・置換・背景色除去

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

### 書類生成UIのリアルタイム更新化
- 生成後のプレビュー画面で、対話的に値を差し替えて即再レンダリング
- 置換データ（JSON）と元のdocxを分離保持して再生成コストを軽く保つ
- 「通数が誤っていた」ような構造変更もその場で反映
- **プランニング段階は挟まない**（手数が増えるため却下済み）

### 最終仕上げの動線: Claude for Word
recastは「事実→型に流し込む」まで責任を持ち、**文章の審美的仕上げは Claude for Word に委ねる**設計にする。

- 生成後のUIに導線追加（ローカル版: 「Wordで開く」 / Web版: 「ダウンロード」）
- 初回ガイド or 設定画面で「Microsoft 365 + Claude for Word があれば対話的な仕上げが可能」と誘導
- 役割分担: 事実チェック=recastのverify / 文章チェック=Claude for Word

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
- **書類生成**: AI全文生成 → **docxtemplater【プレースホルダー】置換** → **ハイライト方式併存（新）**
- **プレビュー**: Google Drive iframe → **LibreOffice PDF/HTML変換**
- **フォルダロール**: common/job 2種 → **common/job/none 3種**
- **案件フォルダ選択**: 複数選択 → **単一選択**
- **全角変換**: 書類生成時に英数字を全角に
- **Excel全角/半角**: 全角→半角統一（数式が壊れないように）。日付（年月日含む値）だけ全角に戻す
- **Excel数値型変換**: 共有文字列が純数値なら全てのセルを数値型に変換（t="s"除去）
- **単位重複除去**: プロンプト改善＋後段でstripDuplicatedUnit（テンプレ直後の単位とAI値末尾の重複を検出・除去）
- **突合せ対象**: 案件整理テキストのみ → **生成済み書類（docxBase64→mammothテキスト抽出）を原本と突合せ**
- **書類生成の品質管理**: produce側での先回り対策（ルールベース正規化など）→ **verify側のLLM判断に集約**（produce=生成、verify=品質管理の責任分割）
- **展開モデル**: 完全ローカル前提 → **UIはWeb、ファイル読み取りはクライアント側ローカル**を将来の前提に（新規コードはパス参照ではなくコンテンツ参照で書く）
- **テンプレート作成**: プレースホルダー手書き → **過去案件の完成書類にハイライト引くだけ**（+コメントで補足）で再利用可能テンプレ化
- **案件整理の責務**: テンプレ内容を見て抽出項目を推測 → **案件フォルダのみから抽出**（テンプレ内容=前案件データは混入させない）。テンプレからは**ファイル名リストと項目タイプ**のみ渡す
- **produce のデータ入力**: 抽出済みデータ（profile+案件整理）のみ → **原本ファイルも併送**（抽出漏れを AI が直接参照で補える。ただしコスト増）
- **company.masterSheet は廃止**: 会社レベルの案件整理保存は別案件のデータ汚染を引き起こすため削除。案件整理データはチャットスレッドの messages として保存（`caseRoom.masterSheet` は残る）
- **基本情報の自動再生成**: 共通フォルダのファイル mtime が変わったら自動でprofileを再生成（会社選択時・ページロード時にチェック）
- **基本情報の参照ファイル選択**: 会社ごとに「基本情報抽出に使うファイル」を明示選択可能（`company.profileSources`）

## 既知の落とし穴・重要な実装注意点

### ChatWorkflow の setState closure 遅延
`runWorkflow` 内で SSE ストリーミング中に `setThread` でメッセージを追加しても、**関数引数の `currentThread` は更新されない**。その後 `generateDocuments(currentThread, ...)` に渡すと、案件整理メッセージが見つからず `organizeContent` が空になって produce で古い `masterSheet.content` にフォールバックする恐れがある。
→ **対策**: SSE ストリームで組み立てた `fullText` を `generateDocuments` の引数で明示的に渡す。`generateDocuments` 側は `explicitOrganizeContent` 優先、次に `thread` state、最後に `currentThread` の順でフォールバック

### 案件フォルダパス（folderPath）の渡し方
ChatWorkflow のフォルダ選択カードで選んだフォルダは `thread.folderPath` に入るが、`sub.active` には反映されない。API（execute/clarify/produce/verify）は `readCaseFiles` ヘルパー経由で統一して読む（folderPath 優先、sub.active フォールバック）。**API呼び出し時には必ず `folderPath` と `disabledFiles` を body に含める**こと

### docx の入れ子段落
図形（textbox内のテキスト）・代替コンテンツ（`<mc:AlternateContent>`）・ピクト（`<w:pict>`）の中には `<w:p>` が入れ子で存在する。段落正規表現の非貪欲マッチが内側の `</w:p>` で早期終了して外側の段落を壊す。
→ **対策**: `docx-marker-parser.ts` の `stripNestedParagraphs` で事前除去（extractMarkedFields/getMarkedDocumentText）、`replaceMarkedFields` では一時マスクして処理後に復元

### Excel 黄色ハイライト方式
- `xl/styles.xml` の `<fills>` から黄色（`FFFFFF00` or `ffff00`）を持つ fillId を特定
- `<cellXfs>` の `<xf fillId="N">` でそれを参照しているスタイルインデックスを特定
- シート XML で `<c s="N">` のセルが黄色セル
- 共有文字列セル（`t="s"`）は shared string index を `sharedStrings.xml` から取得、直接値セルはそのまま
- 置換時は共有文字列側を書き換え（複数セルで同じ文字列参照している場合は1箇所の修正で反映）+ 数値セルは個別書き換え
- 黄色背景除去: `<fill>` の `FFFFFF00` を `patternType="none"` に差し替え

### AI が ★マーク★ をキーに含めて返すことがある
AI の応答 JSON のキーが `"★福田峻介★"` 形式で返ることがある（不安定）。
→ **対策**: パース時に `.replace(/★/g, "")` で除去してから照合

### clarify/produce 間で質問の意味を取り違える
clarify は「項目の型（日付・住所・人名等）」だけ渡す。テンプレのハイライト値そのもの（前案件データ）を渡すと、今回の案件データと比較して「違うから確認」という誤った質問を量産する。
→ **対策**: `extractMarkedFields` で取った値を正規表現で型推定して desc だけ渡す

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

- `claude/reverent-shannon` — 作業中（main へは PR #13〜#24 マージ済み）

## 最近の主要変更（PR #23〜#24）

- **PR#23**: ハイライトテンプレ方式（Word）、共通ルール再帰読込、案件整理のテンプレ参照
- **PR#24**: readCaseFiles統一ヘルパー、Excel黄色セル方式、produceコスト改善

### 未マージ中の追加修正（次PRで入る予定）
- docx 入れ子段落（figure内のhighlightが拾えないバグ）修正: `stripNestedParagraphs`
- company.masterSheet 廃止（別案件データ汚染源の掃除）
- produce に案件原本ファイルを直送（コストは上がるが精度確保）
- Excel xlsx-marker-parser 新規、黄色背景除去
- ChatWorkflow から produce/verify に folderPath 明示渡し
- setState closure 遅延対策（fullText を明示的に渡す）

## テスト会社
- 071.株式会社JINGS_D（進行中、第三者割当）
- 074.株式会社Aicurion_D（進行中）
- 097.株式会社HIBARI_J（終了）

## テンプレート構造
```
templateBasePath/
├ 共通ルール/                    # 全テンプレで必ず読む
│   └ 統一ルール.txt
├ 代表取締役の変更/              # テンプレフォルダ（種別ごと）
├ 会社設立/
├ 募集株式の発行/
│   ├ 1.取締役決定書.docx        # ハイライト方式
│   ├ 6-2.株主リスト.xlsx         # Excelハイライト方式
│   └ memo.txt                  # テンプレ固有の注意事項
└ 取締役の辞任/
```
