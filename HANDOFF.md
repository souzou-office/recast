# recast Phase 1/2/3 設計 — セッション引き継ぎ

## 0. 概要

recast の書類生成フローを「**実体判断 / 手続き整理 / 実生成**」の3フェーズに分離する設計と実装の途中状態。Phase 1, 2, **Phase 2 clarify まで実装済み**。

- **ブランチ**: `claude/review-workflow-BV1UD`
- **最新コミット**: `5a4d3d1` (feat: Phase 2 clarify を実装)
- **作業中のローカル**: `K:\recast` (Windows PowerShell)
- **作業フロー**: 私 (sandbox) → push → GitHub → ユーザー pull の片方向

---

## 1. 設計の核心（このセッションで決まったこと）

### 旧設計の問題

- 案件整理がテンプレ駆動の「| 項目 | 値 | 根拠 |」表
- テンプレに無い事実が落ちる
- 値抽出のミスが下流に伝染
- 議案の取捨判断（例: 役員報酬議案を消す）を扱う場所がない

### 新設計: 3フェーズ分離

| フェーズ | 役割 | 出力 | 値抽出する？ |
|---|---|---|---|
| **Phase 1: 実体上の整理** (= organize) | 案件構造・議案取捨・整合性の **判断** | セクション付き md + ⚠要確認事項 | **しない** |
| Phase 1 clarify | 実体の質問・回答 | confirmedAnswers | - |
| **Phase 2: 手続き上の整理** (= analyze) | テンプレ vs Phase 1 判断の**突き合わせ分析** | md レポート (齟齬/統一性/穴) + ⚠Phase 2 要確認事項 | **しない**（分析のみ） |
| Phase 2 clarify | 書面の質問・回答 | confirmedAnswers (追加) | - |
| **Phase 3: 実生成** (= produce) | 値抽出 + 議案削除 + docx 生成 | 完成 docx | **する**（案件ファイル再読込） |
| verify / proofread | 既存通り | - | - |

**重要原則**：

1. **Phase 1 は値抽出しない**。値の精密抽出（金額・氏名スペル・住所）は Phase 3 が責任を持って案件ファイルを直接再読込して取得
2. **Phase 2 は生成しない**。レポートだけ。実際の操作は Phase 3
3. **判断は Phase 1、書面化は Phase 2 で確認、生成は Phase 3** の責任分担
4. **API コスト前提を解いた**。人件費 ¥5000/h と比較すれば API ¥500/案件は全然ペイする
5. **1 ステップで動かし、問題出たら 3 ステップ（per-doc 構造決め / per-doc 値埋め / 横串整合性）に分割**する漸進方針
6. **ユーザー（司法書士）の認知に沿う**: 「事実 → 書面ルール上の確認 → 生成」が人間の自然な流れ

### Phase 1 の出力イメージ

```markdown
今回の手続き要約: ○○株式会社の第三者割当増資。

## 案件構造の判断
- 募集方法: 第三者割当
- 必要な決議: 取締役会 + 株主総会特別決議

## 議題構成の判断
- 募集事項の決定: 必要
- 役員報酬議案: 今回該当なし

## 整合性チェック
- 取締役会決議日: ⚠ 食い違い検出
  - 投資契約書: 令和8年5月20日
  - スケジュール表: 令和8年5月22日

## ⚠ 要確認事項
1. 取締役会決議日: 5/20 vs 5/22 どちらが正？
2. ...
```

### Phase 2 の出力イメージ

```markdown
# Phase 2 テンプレ整理結果

## ① テンプレ vs 実体判断の齟齬
- 「議事録.docx」第3号議案 役員報酬の決定の件 → 削除推奨

## ② 統一性チェック
- 会社名: 全書類で統一 ✓
- 引受人名: 4書類で使用、Phase 1 で要確認 ⚠

## ③ 穴の確認
### 議事録.docx (11 スロット)
- 確定可能: 8
- 要確認: 3

## ⚠ Phase 2 要確認事項
1. 第3号議案を削除でよい？
2. 引受人正式商号は「××株式会社」「株式会社××」どちらに統一？
```

---

## 2. 実装済み（コミット履歴）

```
d0e2f14 feat: Phase 2 = テンプレ突き合わせ分析エンドポイント + UI 組み込み
8f93baa feat: Phase 2 = produce に議案ブロック削除 + 値再抽出指示を追加
53ff8a8 fix: 要確認事項の見出しを clarify 側の参照と統一
cef49ae feat: 案件整理を Phase 1 (実体判断) 中心に書き換え
373b4ce feat: produce プロンプトに構造化docx情報 (位置順×議案セクション) を併記
795d8c1 feat: 構造化docxパーサー + 仕様書生成モジュール (検証結果反映)
```

### 主要ファイル

| ファイル | 内容 |
|---|---|
| `src/lib/docx-structure-parser.ts` | 新規。docx を段落・見出し・表セル・議案セクション付きアンカー列に分解 (`parseDocxStructure` / `formatStructureForAI`) |
| `src/lib/spec-generator.ts` | 新規。検証で効いた「試行3」プロンプト戦略を構造化（現状未使用、将来 Phase 3 で活用余地） |
| `src/app/api/templates/execute/route.ts` | Phase 1 改修済。テンプレ本体・ラベルを渡さない、判断中心、md+⚠要確認事項出力 |
| `src/app/api/document-templates/analyze/route.ts` | 新規。Phase 2 = テンプレ突き合わせ分析エンドポイント |
| `src/app/api/document-templates/produce/route.ts` | Phase 3 改修済。`removeBlocks` 受け付け → `applyProofreadEditsDocx` で議案削除、Phase 1 が判断のみであることを前提にプロンプト調整 |
| `src/components/ChatWorkflow.tsx` | `runAnalyze` ヘルパー追加。clarify 完了後・produce 前に自動実行 |
| `src/types/index.ts` | `CaseAiMessage.stage` に `"analyze"` 追加 |

---

## 3. 未実装（次のセッションでやる）

### ~~最優先: Phase 2 clarify~~ ✅ 実装済 (commit 5a4d3d1)

`/api/document-templates/clarify-procedural` を新規追加し、analyze の `## ⚠ Phase 2 要確認事項` リストを UI 質問に変換するステップを挟むようにした。

**実装内容**:
- 新ルート `src/app/api/document-templates/clarify-procedural/route.ts`
  - 既存 clarify route とほぼ同じ作り。会話履歴から analyze ターンを読む
  - previousQA で Phase 1 / 過去 Phase 2 の回答済みは除外
- 型追加
  - `CaseAiMessage.stage` に `"clarify-procedural"`
  - `ClarificationCard.kind?: "substantive" | "procedural"`
- `ChatWorkflow.tsx`
  - `runClarifyProcedural` ヘルパー追加
  - 両 generateDocuments 呼び出し箇所 (runWorkflow / clarification handler) に挟む
  - clarification カードのクリック時、`card.kind === "procedural"` なら clarify-procedural を再呼び出し、終わったら直接 produce

**今の流れ**:
```
organize → clarify (Phase 1) → analyze → clarify-procedural (Phase 2) → produce
```

### 仕上げ系（後回し）

- Phase 1 / Phase 2 出力の **折り畳み表示**（デフォルト畳んだ状態でトグル展開）
- 議案削除の精度確認（実運用でどのくらい当たるか）
- 整合性チェック専任ロール（per-doc 並列処理になった場合に必要）
- 既存 `templates.json` の案件整理テンプレートは使ってない（廃止検討）

### Phase 1/2 整合性の落とし穴

- Phase 1 の `## ⚠ 要確認事項` と Phase 2 の `## ⚠ Phase 2 要確認事項` で**重複質問しない**ように、Phase 2 clarify は「Phase 1 clarify で既に答えた内容」を読み飛ばす必要がある
- 既存 clarify ルートが「previousQA」を受け取って重複回避してるので、同じパターンで実装可能

---

## 4. ユーザーの実務感覚（重要・忘れずに）

ユーザー = 司法書士。実務での書類作成プロセスを言語化した結果：

- **前案件を渡されて「これやっとけ」と言われる** のが現実。案件ファイル単体で動くわけじゃない
- 人間がやっている処理は3層
  1. **スロット**（名前・日付・金額）= テンプレの穴埋め
  2. **ブロック**（議案単位）= 事実次第で議案ごと ON/OFF
  3. **自由作文** = テンプレに無い時だけ
- 優先順位は **(1) > (2) >>> (3)**。**検証コストが層によって全然違う**から
- だから議案の取捨判断は **Phase 1 で済ませる**、Phase 3 では機械的に削除するだけ

### ユーザーが指摘した重要な気付き

- **AI に値抽出させると怖い**（本来抽出すべきものが落ちる）→ Phase 1 は値抽出から手を引く、値は Phase 3 で案件ファイル直接再読込
- **セクション構造は事実判断後に決める**（事前 skeleton 固定じゃない、AI が事実次第で柔軟に）
- **思考フェーズは最終的に畳んでもいい**（毎回読むものじゃない、監査用）
- **既存の案件整理テンプレート (`data/templates.json`) は不要**。AI に任せる

### ユーザーの好み

- **テンポ良く進めたい**。長い設計だけの議論より、動かして反応見ながら進める
- **大事な判断は確認する**。勝手に進めず聞く
- 答えは**短く**、ただし**必要な詳細は出す**

---

## 5. Claude for Word 検証の結論（重要）

このセッション中盤で、ユーザーが Claude for Word を手動で試した結果：

| 試行 | 何を渡したか | 結果 |
|---|---|---|
| 1 | recast の修正内容そのまま | 箇条書きに化けた（指示と素材を AI が混同） |
| 2 | 「議事録保持、固有名詞だけ変えて」 | マシ、でも不要項目も書かれる |
| 3 | recast に「テンプレ見て、上から固有名詞順に、必要最低限で書き出して」 | **ほぼ完璧** |

**結論**: ボトルネックは編集環境じゃなく**仕様書の質**。Claude for Word を独自再実装する必要はなく、**recast 側で仕様書をしっかり作る**方向が正解。

この知見が `spec-generator.ts` の前身。今は使ってないけど、Phase 3 が伸び悩んだら参照する想定。

---

## 6. 動作確認の手順

```powershell
cd K:\recast
git pull
# dev サーバー Ctrl+C で停止 → 再起動
npm run dev
```

ブラウザで **新規スレッド**作って案件整理 → 書類生成。期待される流れ：

1. 案件整理 (Phase 1) → セクション付き md + ⚠ 要確認事項
2. clarify → 質問カード
3. 回答 → 続行
4. analyze (Phase 2) → md レポート
5. clarify-procedural → 書面ルール上の確認カード (議案削除可否・表記揺れの統一等)
6. 回答 → 続行
7. produce → 書類生成（議案削除も適用される）

ログで `POST /api/document-templates/clarify-procedural 200` が出てれば Phase 2 clarify 動いてる。

---

## 7. 次の会話で最初にやること

```
このプロジェクトは recast (司法書士事務所向け書類作成ツール)。
Claude for Word への置き換えではなく、recast 側で書類生成フローを
3 フェーズに分離する設計を進行中。

直近の状況: Phase 1 (案件整理 = 実体判断), Phase 2 (analyze = テンプレ
突き合わせ分析), Phase 2 clarify (書面確認質問) **すべて実装済み**。

次やるべき: 実運用で議案削除・表記揺れ統一の精度を観察し、必要に応じて
プロンプト調整。仕上げ系 (折り畳み表示等) も残あり。
詳細はリポジトリの `claude/review-workflow-BV1UD` ブランチ最新を見て。
直近の commit: 5a4d3d1
```

これを新セッションの最初に貼り付けて、必要に応じてこの md 全体も貼れば文脈引き継げる。
