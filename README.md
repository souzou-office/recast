# recast（リキャスト）

バックオフィス業務を効率化するソフトウェア。「起きた事実を、相手の要求仕様に合う型に流し込み直す」＝**書類がマスターデータになる**ことを目指します。

各自の PC でローカルサーバを立てて使う構成です（Local‑First：顧客データはサーバに保存せず、各 PC のローカルに留まります）。設計思想・仕様の詳細は [`CLAUDE.md`](./CLAUDE.md) を参照してください。

---

## 必要なもの

- **Node.js 20 以上**（推奨 20 / 22）
- **Anthropic API キー**（`ANTHROPIC_API_KEY`）
- （任意）**LibreOffice** … Word / Excel のプレビュー機能を使う場合のみ。無くても起動・基本機能は動きます

## セットアップ

```bash
# 1. コードを取得（private リポジトリ。clone するにはアクセス権が必要）
git clone https://github.com/souzou-office/recast.git
cd recast

# 2. 依存をインストール
npm install

# 3. API キーを設定（example をコピーして編集）
cp .env.example .env.local
#   → .env.local を開いて ANTHROPIC_API_KEY=sk-ant-... を記入
```

## 起動

```bash
npm run dev
```

ブラウザで <http://localhost:3000> を開く。

日常的に使うなら、開発モード（`dev`）より本番ビルドのほうが速くて安定します:

```bash
npm run build
npm run start
```

## 最初の一歩

1. 右上の設定（⚙）で**ベースフォルダ**（顧問先フォルダの親）を指定 → 会社が自動検出される
2. サイドバーで会社を選ぶ
3. 基本情報タブで「参照ファイル」を確認 →「基本情報を生成」

---

## 配るとき / 別 PC で使うときの注意

- **`.env.local` はリポジトリに含まれません**（API キーを含むため git 管理外）。各自で作成してください。1 つのキーを共有しても動きます（使用量はそのキーに合算課金）。
- **LibreOffice は npm では入りません**。Word / Excel プレビューを使うなら各自インストールしてください。
- **`data/folders.json` には作成者の環境のフォルダパスが入っている場合があります**。
  - 同じ共有ドライブを**同じドライブ文字**でマウントしていれば、そのまま会社一覧が見えて動くことがあります。
  - 環境が違う場合は、サイドバー（設定）からベースフォルダを選び直してください。
- 顧客データ（ファイル本体）は各 PC のローカルに留まり、サーバには保存されません。

## うまく動かないとき

- **`http://localhost:3000` が開けない / ポートが使用中**：別プロセスが 3000 を使っていると 3001 等にずれます。古いプロセスを終了して 3000 を空けるか、表示された URL を開いてください。
- **API キーが読み込まれない**：`.env.local` を保存し直してサーバを再起動。詳しい回避策（PowerShell で env を注入してから起動）は `CLAUDE.md` の「環境変数 / 起動の注意点」参照。

## 開発コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバ（自動リロード） |
| `npm run build` | 本番ビルド |
| `npm run start` | 本番サーバ（要 `build`） |
| `npm run lint` | Lint |

## 技術スタック

Next.js 15 / React 19 / TypeScript / Tailwind CSS 4 / Anthropic Claude API
