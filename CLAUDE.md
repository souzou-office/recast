# CLAUDE.md — recast

## ★★ 2026-07-08 (続き2): 上層分岐「決議方法」+ ガード機構 — 前提を無言で焼き込まない ★★

**ユーザー指摘**: 「いきなり確定質問が出るのはおかしい。書面決議でやるか否かの選択が
その前に無いと」→ 木が雛形フォルダの前提（書面決議）を無言で飲み込んでいた。

**実装（どちらも汎用機構）**:
- 決議方法（書面決議/株主総会を開催）を choice 質問として木の最上層に追加。
  方式固有の 書類/質問/スロット に when を付け、質問は方式確定後に波状で出る。
- `Jirei.guards` 新設 — { when?, message } の配列。「実開催用の雛形が未登録」等、
  木に載る専門家の注意書きの一般形（将来の員数チェック等の受け皿）。
  UI は琥珀色で表示。pendingQuestions は guards の when が参照する質問も「先に聞く」。
- 適用: 取締役就任・代取変更・本店移転（書面決議が実装済みの枝）/ 目的変更（実開催が実装済みの枝）。
  取締役の辞任は総会不要なので分岐なし。
- コンパイラのプロンプト+スキーマにも「前提の方式を choice で顕在化し、未整備の枝は
  guards で明示」を追加（今後の事由化から自動でこの構造になる）。

**E2E**: 取締役就任の第1波 = 決議方法+方式非依存の質問のみ。書面決議選択で日付質問が出現。
実開催選択でガード表示 + 方式非依存の3枚のみ生成。

**原則（メモリにも記録済み）**: 個別対応・専用ファイルを生やさない。新要件は
「一般形は何か」から考え、汎用機構（when/itemFilter/repeatOverAnswerList/当事者マスタ
data/parties.json/guards）の拡張として実装する。corporate-reps.json と special-parties.json を
別々に生やした失敗 → data/parties.json（当事者マスタ）に統合済み。

## ★★ 2026-07-07 (続き4): 実物雛形を正に — 取締役就任・辞任分離・種別出し分け ★★

**ユーザー指摘**: 「実際のひな型でやれ。そんな簡単な穴埋めで終わるわけない。質問は
テンプレの穴埋めを前提に来るはず」→ 事由の一覧を実物テンプレフォルダに揃えた。

**事由の現況**: 代表取締役の変更 / 本店移転 / 取締役就任 / 取締役の辞任 = ★実物雛形由来★。
目的変更 = 自作雛形のまま（事務所に雛形フォルダが無い）。役員変更(自作混在)は廃止。
残り: 募集株式の発行 / 会社設立（未コンパイル。設立は docm・印鑑届など難物）。

**取締役就任で判明した実物の難所と対応（エンジン3拡張）**:
- ★提案書兼同意書が個人用/法人用の2テンプレ★（統一ルール③の実装が雛形側にあった）
  → `JireiDocument.itemFilter { field, anyOf }` + factList 株主に 種別（名称から機械判定、
  組合は法人扱い）。法人には法人用テンプレ（本店/商号マップ）が自動で出る。
- ★就任承諾書は「新任者ごと」に1枚★（現任役員一覧では作れない、案件データ）
  → `JireiDocument.repeatOverAnswerList { questionId, fields, separator? }`。
  質問「1行に1人、氏名／住所」→ 行ごとに1ファイル。
- ★議事録の新任者一覧は氏名だけ★ → answer binding に `lineField`（行を／で割って n 番目を
  改行連結）。同じ回答から承諾書(氏名+住所)と議事録(氏名のみ)の両方が出る。
- ★タブ区切りレイアウトで find 不一致★（w:t にタブは含まれない）→ 照合時に find/replace の
  タブを無視する正規化を template-ops に追加。
- E2E(054): 10枚一式。個人×2+法人×2の提案書、新任2名分の承諾書、全角数値、【】残りは
  【法人株主代表取締役】のみ（株主一覧に代表者名が無い既知の穴。統一ルール⑦の固定表対応は今後）。

**未対応メモ**: Deep30組合の特殊同意欄（統一ルール④）は法人書式で代用（手直し前提）/
目的変更の実物雛形化（事務所で雛形を作るなら同じ手順で差し替え）/ 募集株式・会社設立。

## 2026-07-08: 統一ルールのアプリ内化 + プレビューを本体に

- **法人株主の代表取締役が空欄になる実バグ修正**: 統一ルール⑦⑧を `data/jirei/corporate-reps.json`
  （名称→代表者名）にデータ化し、株主一覧に 代表者名 として注入。Deep30 の同意欄が完全に埋まる。
- **統一ルールをアプリ内へ**: 正 = `data/jirei/office-rules.txt`（H: の統一ルール.txt から取り込み）。
  事由コンパイラと AI チェック（verify）が常にこれを読む。設定タブ「事務所ルール」で編集可能
  （GET/PUT /api/jirei/office-rules）。
- **プレビューを本体に**: 全画面オーバーレイをやめ、左=書類リスト / 本体=プレビュー常設に
  （幅フィット済みなので本体表示で十分読める。書類を次々切り替える流れ作業向き）。
- 検討中の次候補: 募集株式の発行・会社設立のコンパイル（ユーザー指示で保留中）。

## 2026-07-08 (続き): 組合の特殊同意欄（統一ルール④）+ 会社レス運用

**組合の同意欄**（ユーザー方針「ルールに書いてあるからそこを使え」）:
- 統一ルール④の記載（主たる事務所/名称/無限責任組合員/組合員/代表取締役）を
  `data/jirei/special-parties.json` に**そのまま転記**（名簿名→同意欄の各行。全角表記もルールどおり）
- 株主の種別を 個人/法人/★組合★ の3値に（名称に「組合」を含めば組合）
- `scripts/build-kumiai-template.mjs` — 法人用テンプレの同意欄だけ差し替えた組合用変種を機械生成
  （行の追加は \n 入り置換 → produce の fixDocxLineBreaks が <w:br/> 化）
- E2E: Deep30組合に組合用が出て、同意欄がルール④の記載と一字一句一致・【】残りゼロ

**会社レス運用**:
- /api/jirei と /api/jirei/verify の companyId を任意に。会社未選択 = 原本の自動発見をスキップし
  全部ドロップで賄う（会社が誰かは登記情報が知っている）
- JireiPanel の「会社を選択してください」早期 return を撤去。会社なしでもパネルが出る
- API 直テスト: companyId なし + 原本2点ドロップ → 受付 → 抽出 → 質問 → 辞任2枚生成まで確認
- 注: 事由一覧・生成は会社レスで動くが、チャット・横断検索・基本情報タブは従来どおり会社前提

## ★★ 2026-07-07 (続き2): 原本直付け方式 + verify — 「要約に判断させない」実装 ★★

**背景（ユーザー指摘の急所）**: 基本情報は AI 要約なので、①取りこぼし ②誤抽出 が怖い。
さらに実務は「案件の頭で登記情報等を取り寄せて一新する」ので、要約の使い回しは実態と合わない。
→ **最初から原本（定款・登記情報・株主名簿）そのものを付ける**方式へ。

**原本直付け（fact の出所を原本に）**:
- `Jirei.requiredSources` — 事由が必要とする原本の宣言（label + ファイル名 patterns + optional）。
  添付書類の実務知識が木に載る。4事由すべてに 登記情報/定款/株主名簿 を宣言済み。
- `src/lib/event-filing/source-facts.ts` — findSourceFiles（共通フォルダから patterns 検索、
  **日付付き世代は名前降順=最新を選ぶ**）+ extractFactsFromSources（AI が原本から構造化抽出、
  ★解釈項目は定款条文の原文引用付き★。**ファイル内容ハッシュでキャッシュ** data/fact-cache/
  → 同じ原本なら2回目以降 AI ゼロ・決定論）。
- /api/jirei POST: requiredSources がある木は原本直読み（無い木は従来の基本情報 fallback）。
  原本不足 → phase:"sources" で不足リスト + ドロップ受付。ドロップは自動発見より優先
  （取り寄せ直した最新を使う意図）。
- UI: 「出典: 20251015_履歴事項…・電子定款…（いま読み取り/キャッシュ再利用）」表示 + 根拠表示。
- facts.ts に定款由来の判断キー追加（取締役会設置・代表取締役の選定機関・公告方法）
  → 上の層の分岐（要件判断）が fact で評価できる下地。

**verify（AI チェック・原本突合せ）**:
- /api/jirei/verify — 生成一式(docx/xlsxテキスト化) + ★原本そのもの★を AI が読み比べ、
  指摘だけ返す（書類は書き換えない）。観点: 原本不一致/書類間不整合/日付順序/置換漏れ。
- UI: 生成後に「AI チェック」ボタン → 指摘を重大度色分けで表示。
- 054 実機: 代理人欄の仮文言残り（本物の指摘）、定款の設立時割当と現在名簿の食い違い等を検出。

**ハマった点**:
- ★tool スキーマのプロパティ名に日本語不可★（API が 400）→ 英字キーで受けて日本語キーに変換
- ★PowerShell の Set-Content は BOM 付き UTF-8★ → data/jirei/*.json が全部パース不能になり
  事由一覧が0件に。loader に BOM 耐性を入れた。JSON 編集は node でやること。

## 2026-07-07 (続き3): 質問の洗練 — 「申請書を作る前提」をやめる

- **ユーザー指摘**: 管轄法務局・登記申請日を聞くのはおかしい。実物テンプレ一式に
  変更登記申請書は無い（事務所は電子申請）= 私が作った申請書テンプレが前提を間違えていた。
- 変更登記申請書_目的変更/役員就任/役員辞任/役員重任.docx を木と repo から削除。
  管轄法務局・登記申請日の質問を全事由から削除。
- **委任状の日付は案件の基準日から導出**（実物サンプル準拠: 本店移転=移転日/代取変更=決議日/
  目的変更=総会日/役員変更=就任なら総会日・辞任なら辞任日）。
- **エンジン拡張: slots の値を配列にできる**（when を満たす最初の出所を採用）。
  「同じ穴でも分岐によって出所が変わる」の一般解（役員変更の委任状日付で初使用）。
- 質問の設計原則: ①資料から取れるものは聞かない ②実物一式に無い書類のための質問をしない
  ③日付は案件の基準日から導く ④例示は形式指定（和暦）として残す。
- E2E: 目的変更=質問2つ/3枚、役員変更(辞任)=質問3つ/2枚・委任状日付に辞任日が自動で入る。

## ★★ 2026-07-07: 事由コンパイラ — テンプレフォルダを AI が読んで木を自動生成 ★★

**方向性（ユーザー明言）**: recast は登記専用ではなく法務・労務・税務の全業務対応を目指す。
事由ごとの手書きルールでは横断できない → **AI は「事由を覚える瞬間」に1回だけ働き、
判断結果を木（JSON）として固定する**。案件ごとの穴埋めは決定論のまま（旧 AI 流し込みの
崩れを繰り返さない）。「定型は木、初見は AI、AI で捌いたものは木に昇格」の2車線。

**実装**:
- `src/lib/event-filing/template-ops.ts` — 実テンプレの「値→【…】」変換 ops の適用エンジン
  （run 分割・入れ子段落対応。anchor は「近くの文言」= anchor 段落から距離順に探す。
  ★同一段落限定にすると AI の意図とズレて 0 件になる — 実測して直した★）
- `src/app/api/jirei/compile/route.ts` — GET: テンプレフォルダ一覧 / POST: フォルダ+指示
  → AI (sonnet-4-6, tool use 強制) が 木 + templateOps + warnings を生成 → ops を機械適用して
  data/jirei-templates/ に書き出し → 木を data/jirei/ に保存。置換 0 件の op は warning。
  統一ルール.txt・メモ.txt・既存の木 (honten-iten) を few-shot でプロンプトに同梱。
- UI: JireiPanel「＋テンプレフォルダから事由を追加」（フォルダ選択+追加指示+結果と警告の表示）

**実証（代表取締役の変更・実物9ファイル）**: コンパイル1回で 質問10・書類7 の木が完成、
置換漏れゼロ。E2E で 10枚一式（提案書×株主4名分含む）生成・【】残りゼロ・未充足なし。
AI の warnings が実務的（法人株主の書式、辞任者が代取兼務の場合の文言、委任状の署名者は
新代取で議事録は現代取の区別、任期確認）。コンパイルコスト ≈ AI 1回。

**PowerShell の罠**: Invoke-RestMethod は UTF-8 レスポンスを化かす。API テストは node の
fetch でやること（診断データが化けて原因究明が迷子になった）。

## 2026-07-07 (続き): 木の可視化 — ロジックツリー表示（コンソール v1）

- ユーザー要望「木構造を作るためのコンソール」= 抽象→具体のロジックツリー図のイメージ。
- `GET /api/jirei/tree?id=` — 木 JSON + テンプレ実ファイル走査（scanTemplateHoles: 【…】と
  黄色マーカー / xlsx は《…》+ rowSlots）から 事由→分岐→書類→穴+出所 のツリーを組む（AIなし）。
- `JireiTreeView.tsx` — 横方向ツリー（罫線コネクタ）。穴は出所で色分け:
  緑=資料から自動 / 橙=質問で聞く / 青=株主ごと等の一覧 / 灰=固定 / **赤=出所なし（レビュー対象）**。
  事由カード右上の Network アイコンから全画面で開く。
- 分岐（when）は 分岐質問→選択肢 の階層で表示。共通書類は「共通（どの分岐でも）」に。
- **赤（出所なし）が「木の穴」を一目で炙り出す** = レビュー画面として機能する。
- 次: コンソール v2 = ツリー上で出所を編集（fact/answer/const 切替・質問文言の編集）→ JSON 保存。

## 2026-07-03: 申請タブに案件資料ドロップ → 質問プレフィル (feat/jirei-answer-drop)

- **体験**: 質問フォームにドロップゾーン追加。お客さんからのメール等を放り込むと、
  未回答の質問だけ AI が資料から答えを抽出してプレフィル（出典ファイル名も表示）。
  **人が確認してから生成**（自動では生成しない）。入力済みの欄は上書きしない。
- **設計**: AI の役割は「木が定義した質問に案件資料から答える」入口だけ。穴埋め・生成は
  従来どおり決定論。fact（会社データ・基本情報経由）と answer（案件データ・ドロップ経由）で
  入口が相似形になった。
- **新規**: `src/app/api/jirei/extract-answers/route.ts`（sonnet-4-6 + tool use 強制、
  temperature 0、questionId は enum で縛る、「資料に無ければ空文字」厳守）。ファイルは
  base64 で受け parseBuffer 再利用（docx/xlsx/pdf テキスト、画像/スキャンPDF は block）。
- **UI**: JireiPanel の質問カード先頭にドロップゾーン（クリック選択も可）。
- **実機確認**: 054 でメール1通ドロップ → 変更後目的(6項目全文)+開催日(令和形式) 両方
  プレフィル → 生成 → docx に抽出値が正しく反映。抽出コスト ¥1/回程度。

## 2026-07-03 (続き): 目的変更を申請一式に + 役員変更（分岐の本番）実装

**目的変更の一式化**: 変更登記申請書_目的変更.docx / 委任状.docx をテンプレ追加
（scripts/build-jirei-templates-2.mjs で生成、司法書士が Word で直接編集可）。
質問に 申請日・管轄法務局 を追加。**4枚一式**（議事録/株主リスト/申請書/委任状）を実機確認。
委任状は「登記の事由」スロット入りで全事由共用（各木が const で事由名を入れる）。
代理人欄（事務所の住所・氏名）は recast の関知外 = テンプレに直接記入する固定文。

**条件分岐 (when) — 木の表現力テスト合格**: `JireiCondition { questionId, anyOf }` を
questions / documents / slots すべてに付けられるようにした（types/jirei.ts + select.ts）。
- 分岐を決める質問（when が参照する questionId）は自動的に「先に聞く」対象になる
  → 回答するたびに pendingQuestions を再評価 = **質問が波状に出る**（UI 無改修で動いた）
- when を満たさない slot は「存在しない」扱い（unresolved にも入れない）
- requiredDocuments(jirei, answers) が when で書類を絞る。produce は絞った documents を受ける
- UI: kind: "choice" の質問は select で描画

**役員変更 (yakuin-henkou.json)**: 就任/辞任/重任 の3分岐。テンプレ7枚追加
（議事録_役員選任/重任、就任承諾書、辞任届、変更登記申請書_役員就任/辞任/重任）。
- 就任: 議事録+就任承諾書+株主リスト+申請書+委任状 (5枚)
- 辞任: 辞任届+申請書+委任状 (3枚。総会不要なので議事録・株主リストが出ない)
- 重任: 議事録(重任議案)+就任承諾書+株主リスト+申請書+委任状 (5枚)
3分岐とも 054 で E2E 実機確認（未充足スロットなし・AI呼び出しゼロ）。tsc も緑。

**v1 の割り切り（司法書士レビュー前提）**: 取締役会非設置・株主総会選任前提 /
登録免許税は固定文（1億円超は要手直し）/ 代表取締役の就任・監査役は未対応 /
辞任で取締役が法定員数を割るケースのチェックなし。実様式への調整はユーザーが Word で行う。

## 2026-07-03 (続き2): 実物テンプレ（【…】方式）を無加工で jirei に組み込めるように

- **背景**: 事務所の実テンプレ (H:\...\テンプレート\取締役の辞任 等) は黄色マーカーではなく
  **【プレースホルダー】方式**（旧書類生成の規約）。しかも Word の編集履歴で
  【令和　　年　　月　　日】が 9 run に分割されている。
- **実装**: `JireiDocument.placeholders`（【内文言】→ スロットラベル。空白無視で照合）を追加。
  produce.ts の `replaceBracketPlaceholders` が段落内 <w:t> を結合したテキスト上で【…】を
  位置ベース置換（1個ずつ置換→再走査で複数穴・run分割に対応）。決定論・AIなし。
  黄色マーカー方式と併用可（両方書いてあれば両方効く）。
- **適用**: 役員変更の 辞任届.docx / 委任状_役員変更.docx を実物に差し替え
  （委任状は事務所の住所・氏名入りの実物。登記の事由は「取締役の変更」固定文）。
  辞任フロー E2E で 【…】残りゼロ・全値充足を実機確認。
- **これで実物テンプレの組み込み手順は**: ファイルを data/jirei-templates/ にコピー →
  木の documents に placeholders 対応表を書くだけ（テンプレ自体は無加工）。

## 2026-07-03 (続き3): 本店移転を実物テンプレ（書面決議方式）で事由化 — 8枚一式

- **元ネタ**: H:\...\テンプレート\本店移転(管轄内） の実物4テンプレ。値は前案件(Polaris.AI)の
  実値が入ったままだったので、`scripts/build-honten-templates.mjs` が値の部分だけ【…】に
  置き換えたコピーを生成（文言・レイアウト・書式は実物のまま。置換件数をログで検証）。
- **書面決議方式**（会社法319条1項）: 取締役決定書 → 提案書兼同意書（★株主ごとに1枚★）→
  議事録(書面決議) → 株主リスト → 委任状。
- **エンジン追加**:
  - docx の repeatOverFactList = 「1件につき1ファイル」生成（提案書兼同意書_氏名.docx ×人数分。
    統一ルール②）。per-item フィールドは placeholders で 【株主住所】→住所 等にマップ
  - 統一ルール⑤（docx の数値は全角＋全角カンマ）: facts に 総議決権数（全角）等 + factList に
    議決権数全角 を追加（xlsx は従来どおり半角）
  - 【ラベル】=スロット名ならば placeholders 対応表なしで直接引ける fallback
  - ★段落分割の入れ子対応★: テキストボックス(w:pict>w:txbxContent)内の <w:p> で
    単純正規表現が切れて後続 run が置換されないバグを修正（splitParagraphs。scripts側も同じ）
- **メモの規約を再現**: 委任状=移転後の住所 / 提案書兼同意書=移転前の住所（fact 本店所在地）
- **E2E 実機確認** (054): 8枚生成（提案書×株主4名分）・【】残りゼロ・全角数値
  （２名/４名/１０５，２６３個/５，２６３個）・AIゼロ。
- **v1 未対応**: 印鑑カード交付申請書（管轄外のみ・31行の表様式）→ 管轄内/外の分岐ごと保留。
  法人株主の同意欄書式（統一ルール③④: 本店/商号/代表取締役に書き換え）は個人書式のまま
  → 司法書士が Word で修正する前提。株主リストは自前生成テンプレを流用（実物 xlsx 未組込）。

## 2026-07-02 (別PC取り込み時): jirei の fact 導出がキー名で取りこぼす件を修正 (fix/jirei-fact-key-normalize)

- **症状**: 申請タブで 株主総数・総議決権数・代表取締役氏名 等が「値が決まらなかった穴」に残る。
- **原因**: `src/lib/event-filing/facts.ts` が `structured.株主` / `structured.役員` の正規キーを
  前提にしていたが、実際の基本情報 (AI生成) は「株主構成（氏名・住所・持株数・持株比率・メールアドレス）」の
  ような記述的キーで保存される。データはあるのにキー名で外れていた。
- **修正**: `pickArray()` で「正規キー → 前方一致 (値が配列のもの)」の順に探す。持株数が number で
  入るケースにも `toNumber` を対応。054.QuackShift_D の目的変更で全14 fact 充足・議事録/株主リスト
  正常生成を実機確認。
- **注意 (環境)**: officecli が自動アップグレードされた直後、起動中の dev サーバーからの
  `view <file> html` が System.Private.Xml 欠落の unhandled exception で落ち続けた。
  **dev サーバー再起動で解消**。プレビューが officecli エラーを出したらまず再起動。

## ★★ 2026-07-02 セッション: 事由駆動型 申請書生成 (jirei) — 新方式の縦1本を実装 ★★

**性格**: 「現行が限界だから直す」修正ではなく「これが本来あるべき姿だから作る」理想追求。
設計と議論の全経緯は `docs/事由駆動型申請書-設計と経緯.md` を読むこと。

**体験**: 新タブ「申請」→ 事由ボタン（例: 目的変更）を押す → 基本情報(資料)から埋まる値は
自動で埋まり、決まらない分だけ質問 → 答えると書類一式が生成される。
テンプレを選ばない・フォームに転記しない。**AI呼び出しゼロ・officecliゼロ・決定論**。

**構造**: 事由 = データ（コードではない）。事由を足す = 以下2つを置くだけ（コード無改修）:
- `data/jirei/<id>.json` — 木（必要書類・聞く質問・穴→値の出所 fact/answer/const）
- `data/jirei-templates/*.docx|xlsx` — 穴あきテンプレ（黄色マーカー=穴。既存パーサー規約そのまま）

**新規ファイル**:
- `src/types/jirei.ts` / `src/lib/jirei/loader.ts` — 木の型とローダー
- `src/lib/event-filing/facts.ts` — StructuredProfile → 事実キー平坦化＋派生（株主総数・総議決権数等。
  v1前提: 1株=1議決権・全員出席）
- `src/lib/event-filing/select.ts` — 必要書類/未回答質問/穴の値map（純粋関数）
- `src/lib/event-filing/produce.ts` — 既存穴埋めエンジン(replaceMarkedFields /
  expandYellowRowBlock+replaceXlsxMarkedCells / cleanup)を呼ぶだけの glue。
  docx複数行値は生成後に `<w:br/>` 化。xlsxの単発穴は「《ラベル》」セル(全文一致)、
  繰り返し行は黄色データ行(セル文言=rowSlotsキー)を人数分展開
- `src/app/api/jirei/route.ts` — GET一覧 / POST(質問フェーズ⇄生成フェーズ)
- `src/components/JireiPanel.tsx` + page.tsx タブ「申請」
- `scripts/build-jirei-templates.mjs` — 目的変更テンプレ2枚の初期生成（司法書士がWordで直接編集可）

**E2E検証済み**（テスト会社QuantumZero・株主2名）: 資料から14値自動、質問2つだけ、
生成docx/xlsxの全値埋まり・マーカー/プレースホルダー残りゼロ・株主行の自動展開OK。
`next build` も緑（既存の型エラー2件も修正: FilePreview/DocumentResultCard の
Uint8Array<ArrayBuffer>、read-case-files の FileContent import）。

**次**: 実物の様式に合わせたテンプレ調整（ユーザーがWordで確認・修正）→ 2事由目=役員変更
（木に条件分岐が入る本番。分岐表の表現力テスト）→ 条件付き必要書類(rules)を型に追加。

## ★ 進行中の大改修 (feat/officecli-integration) — 2026-05-23 開始

### 動機

今夜の changes スキーマ刷新で見つけた問題群:
- 段落番号付けが docx-marker-parser と produce-edits で暗黙にズレてた
- run 分割で anchor 検索が失敗する
- ★label★ の位置特定が脆い
- AI が op 数を最小化する傾向 (ラベル変換時に省略する)

これらを**自前で全部解決**しようとしてた。が、**OfficeCLI (https://github.com/iOfficeAI/OfficeCLI)** という AI agent 前提に作られた CLI ツールを発見。試したら recast の全ての悩みを構造的に解決できることが判明:

| recast の悩み | OfficeCLI での解決 |
|---|---|
| 段落番号ズレ | `@paraId` で一意特定 (insert/delete でも不変) |
| run 分割で anchor 失敗 | `find=` が run 境界を跨いで動作 |
| ★label★ 位置特定 | `query 'run[highlight=yellow]'` で一発取得 |
| insertAfter 順序逆転 | `--after <path>` で位置指定、順序保証 |
| 書式保持 | 自動 |
| LibreOffice 依存 | OfficeCLI に rendering engine 内蔵 → HTML/PNG 出力可 |
| verify の精度 | `view issues` + `validate` + `query` で構造的にチェック |
| AI コメント書き込み | `add comment` で Word ネイティブコメント書ける |

### 採用方針 (C 案 = AI が JSON で officecli コマンドを記述、recast が CLI 化)

AI の出力フォーマット:
```json
{
  "commands": [
    {
      "command": "set",
      "path": "/body/p[@paraId=064BAB11]",
      "props": { "find": "令和８年２月１１日", "replace": "令和８年６月１日" }
    },
    {
      "command": "remove",
      "path": "/body/p[@paraId=17F80A4A]"
    },
    {
      "command": "add",
      "parent": "/body",
      "type": "comment",
      "props": { "text": "ここマイナンバーカード記載と相違あり" }
    }
  ]
}
```

recast の処理は「JSON を officecli の CLI 引数に組み立てて exec するだけ」。Tool Use schema で形式強制、AI は officecli の用語そのまま使う、recast 側に翻訳テーブル不要。

### 実装ステップ

1. ✅ ブランチ作成
2. lib/officecli.ts: 薄いラッパー (`runOfficeCli`, `viewText`, `query` 等)
3. Phase 2 (analyze) に OfficeCLI モード追加 (env var `RECAST_ENGINE=officecli` で切替)
4. produce-v2 に OfficeCLI モード追加 (同上)
5. 1 書類動作確認 → 全書類動作確認 → 旧モードに残してマージ

### 廃止候補 (動作確認後)

- `src/lib/docx-marker-parser.ts` (★label★ 抽出 / 番号付け)
- `src/lib/produce-edits.ts` (XML 直接操作)
- `src/lib/template-labels.ts` (slot 補足)
- `Phase2Decisions.changes` 型 (1 段落 1 op スキーマ)
- LibreOffice 依存 (`preview-pdf`, `preview-html`)

### 残課題

- バイナリ配布: Windows / macOS / Linux 用バイナリを recast に同梱 or インストールガイド
- パフォーマンス: 大量の officecli コマンドを順次実行する場合のオーバーヘッド (resident mode で軽減可)
- テンプレ作成 workflow: 既存の「黄色ハイライト + ★label★」がそのまま使えるか確認

---

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
- テンプレートフォルダ方式（ドライブ上のdocx+メモファイル）
- Wordテンプレート【プレースホルダー】→AIが値生成→docxtemplater置換
- Excelテンプレート【プレースホルダー】→PizZipでXML直接置換
- 複数docx一括生成、人数分展開（配列プレースホルダーはファイル単位で判定）
- Word: 英数字全角変換 / Excel: 全角→半角統一（数式が動くように）
- Excel: 日付（年月日を含む値）だけ全角数字に戻す
- Excel: 置換後の純数値セルを自動で数値型に変換（t="s"→数値、数式エラー防止）
- Excel: 置換値のXMLエスケープ（&lt;&gt;&amp;で壊れない）
- 単位重複の自動除去（「100個個」→「100個」、テンプレ直後の単位と値末尾の重複を検出）
- プロンプトにテンプレート本文を渡し、プレースホルダー前後の文脈をAIが理解
- 案件整理の最新テキストをmasterContent引数で直接渡せる
- チャット内右ペインでの生成書類プレビュー
- 生成書類の保存・一覧・プレビュー・ダウンロード

### 突合せ（チェック）✅
- **原本（共通+案件フォルダ）vs 生成済み書類（docxBase64→mammothテキスト抽出）** の突合せ
- company / caseRoom / スレッド内の generatedDocuments から取得
- 表形式レポート出力（チェック観点・生成書類・問題内容・原本の正しい値・重要度）
- 生成書類がない場合はエラー表示
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

## 2026-04-20 UI刷新 + 要確認ループ設計（ui/phase1-tokens-fonts ブランチ）

### UI刷新（Option B デザイン適用）
- デザイントークン化: globals.css + next/font（Noto Sans JP / Noto Serif JP / Fraunces）
- 絵文字 → Lucide アイコンに全域置換（`src/components/ui/Icon.tsx` ラッパー）
- カード群刷新: FolderSelect / TemplateSelect / FileSelect / Clarification / DocumentResult
  - rounded-2xl + アイコン + Pill ボタン、文字サイズを 13px で統一
- MessageBubble: AI 吹き出し廃止 → フロー型（アバター+pl-8）、User のみ黒背景吹き出し
- ChatInput: max-w-2xl の丸角カード、accent 青の Send ボタン (9x9 rounded-xl)
- Header: タブ型（チャット/基本情報）。タブは白背景+shadow-sm
- Sidebar: スレッド選択は左1pxアクセントバー+白背景
- 幅はコンテナ比率 65%（モック artboard の比率を再現、min-w 560 / max-w 1100）
- 行間: body 1.6 / p 1.7 / h 1.3、.prose-recast に表・見出し・リスト・引用スタイル追加
- 基本情報タブ: max-w-3xl → w-[65%]、Serif 26px 見出し、rounded-2xl カード
  - 左ラベル列 w-[180px] 固定 + break-words（長いラベルで列がバラつくのを解消）
  - 株主リスト等の一覧を「カード表示」で描画（列数揃うと合計行はインライン）
- FilePreview: .docx/.docm をクライアント側 docx-preview でレンダリング（LibreOffice 不要、数十ms）

### 要確認を構造的に減らす流れ
旧: clarify が AI 判断で質問を作る → 聞き漏らし → 生成書類に（要確認）残留

新:
1. 案件整理（execute）が `| 項目 | 値 | 根拠 |` 形式の表を出す
2. 値が `*要確認*` になった行を**機械的にパース** → `knownMissing: string[]`
3. clarify は `knownMissing` を必ず質問に含める（AI 判断より優先）
4. 回答 → produce → 要確認ゼロで書類生成

### テンプレごとのラベルキャッシュ（`.labels.json`）
- 旧: ハイライト周辺文字列から機械ラベル合成 → 「令和8年1（日付）」「甲の（日付）」等のゴミラベル量産
- 中間: 汎用カテゴリ集約（「取締役決定書に記載の日付」等）→ 項目が粗すぎて取りこぼし（払込金額・資本金・資本準備金・口座情報が (要確認) に）
- 新: **Haiku がテンプレを1度解析**して各★に「意味ラベル＋記載形式＋推定出典」を付与
  - `src/lib/template-labels.ts`
  - 例: `{ label: "取締役決定書の作成日", format: "令和○年○月○日", sourceHint: "案件スケジュール表" }`
  - `<template>.labels.json` として隣に保存、sha256 で変更検知
  - 初回のみ数秒コスト、以降はキャッシュヒットでゼロコスト
- execute route は書類別の「項目・形式・出典候補」を AI に渡す

### 書類生成カードに検査結果をインライン統合
- 旧: `check-result` カードが別に出る（使われない情報カード化）
- 新: `document-result` カード内で書類ごとに ✅/🟡/🔴 バッジ + 問題内容を直下表示
  - verify が JSON で per-document issues を返す
  - マッチは fileName / baseName 複数パターン対応
  - 既存スレッドでも thread.checkResult から自動マージ

### 基本情報の扱い改善
- 抽出項目の固定リスト廃止 → 「資料にあるものを全部」方針
  - `株主構成` にメールアドレス等、資料に書いてある情報が自動で入る
  - 「抽出項目」ボタンは削除
- 案件整理で `📇基本情報` を根拠として表示可能に（execute に profile.structured を参照データで添付）
- xlsm の MIME マッピング追加（過去バグ: 拡張子対応のみで中身パース不能だった）

### その他改善
- `/api/workspace/profile/sources` が 3.3s → 91ms（中身パース廃止、listFiles のみ）
- 書類生成: 分割スロット（住所2段等）で 要確認 を出さず空文字を返す指示追加
- 要確認 を赤文字で表示（WarnHighlightMarkdown ラッパー）

## 未完了・残タスク（次回）

1. **チャット駆動の修正ループ**: 「代表取締役は三上春香にして」みたいな自然言語で修正 → labels.json / confirmedAnswers 自動更新 → 該当書類再生成
2. **書類生成カードでの個別修正**: issue 行に「[修正する]」ボタン → チャット prefill
3. **readAllFilesInFolder の並列化**: 現在は直列。Promise.all で 3-5 倍速化
4. **produce 側でも `.labels.json` を使う**: 現在は execute のみ。produce が label を受け取ればさらに精度向上
5. **dead code 整理**: FileSidebar / folders/* は未使用
6. **ProfileTemplateModal 削除**: 「抽出項目」廃止に合わせて

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
- **Excel全角/半角**: 全角→半角統一（数式が壊れないように）。日付（年月日含む値）だけ全角に戻す
- **Excel数値型変換**: 共有文字列が純数値なら全てのセルを数値型に変換（t="s"除去）
- **単位重複除去**: プロンプト改善＋後段でstripDuplicatedUnit（テンプレ直後の単位とAI値末尾の重複を検出・除去）
- **突合せ対象**: 案件整理テキストのみ → **生成済み書類（docxBase64→mammothテキスト抽出）を原本と突合せ**
- **書類生成の品質管理**: produce側での先回り対策（ルールベース正規化など）→ **verify側のLLM判断に集約**（produce=生成、verify=品質管理の責任分割）
- **展開モデル**: 完全ローカル前提 → **UIはWeb、ファイル読み取りはクライアント側ローカル**を将来の前提に（新規コードはパス参照ではなくコンテンツ参照で書く）

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

## 2026-05-22 セッション: Phase 2 を changes スキーマに刷新 + 多数の保守修正

### ★ 最重要 (直前の変更): Phase 2 を「changes 配列」スキーマに刷新（feat/changes-schema）

**背景**: 旧スキーマ (Phase 2 が 4 種類の指示配列 `slotDecisions` / `blockDeletes` / `rowInsertions` / `textReplaces` を独立で持つ) は、指示同士が干渉して衝突する設計的弱点があった。
- blockDelete 範囲内に slot fill 指示があると「fill 優先 vs delete 優先」の判定が後段で必要
- textReplaces の anchor が複数 `<w:t>` にまたがって検索失敗
- 各層を厳密化するとルール間干渉で破綻する
- 「ルールベースで厳密性を吸収できない」設計の限界に到達

**新設計**: 1 種類の `changes` 配列で全操作を表現。1 段落 1 op が**構造的に保証**される（衝突発生不可能）。

```ts
interface ChangeOp {
  idx: number;  // 段落番号 (1-indexed)
  action: "delete" | "fill" | "rewrite" | "insertAfter";
  until?: number;     // delete のとき範囲削除 (idx〜until)
  slot?: string;      // fill のとき ★label★ の中身
  value?: string;     // fill のとき置換値
  text?: string;      // rewrite / insertAfter のとき完成形テキスト
  reason?: string;    // デバッグ用
}
```

**変換マッピング**:
| 旧 | 新 changes |
|--|--|
| slotDecisions[fill] | `{ idx, action: "fill", slot, value }` |
| slotDecisions[delete-row] | `{ idx, action: "delete" }` |
| blockDeletes | `{ idx, action: "delete", until }` |
| rowInsertions | `{ idx, action: "insertAfter", text }` (text は値込みの完成形) |
| textReplaces (議案番号繰り上げ) | `{ idx, action: "rewrite", text }` |

**実装範囲**:
- `src/types/index.ts`: `ChangeOp` 型と `Phase2DocumentDecision.changes` フィールド追加。旧型は optional で残置 (互換)
- `src/app/api/document-templates/analyze/route.ts`:
  - Call 2 用 Tool `PHASE2_CHANGES_TOOL` を新規定義
  - Tool Use を `submit_phase2_changes` に切替、プロンプトも changes 形式に
  - 旧 `PHASE2_DECISIONS_TOOL` は残置 (使われない)
- `src/app/api/document-templates/produce-v2/route.ts`:
  - `decisionDoc.changes` があれば優先処理 (`changesProcessed` フラグで分岐)
  - 旧スキーマ処理は changes が無い時の互換 fallback として残置
  - auto-clear (Phase 2 が触らなかった ★label★ を空文字 fill) も changes ベース版を追加

**動作確認状況**: feat/changes-schema ブランチで dev サーバ稼働中 (http://localhost:3000)。実機テスト要。

**将来課題 (新スキーマ完成後)**:
- Call 1 (reasoning) を廃止して Call 2 のみに統合 (Tool Use 1 回で reasoning + changes を返す → コスト半減、時間半減)
- 旧スキーマ関連の死蔵コード (旧 PHASE2_DECISIONS_TOOL、旧 slotDecisions/blockDeletes/rowInsertions/textReplaces の処理パス) を削除
- types.ts から旧フィールド削除

### サイドバー高速化 (PR #92 マージ済)
- `Company.scannedSig` 追加 (会社フォルダ + 中間フォルダの mtime 連結)
- `selectCompany` は ID 切替のみ、新 action `rescanSelectedIfChanged` で mtime 差分検知
- フォーカス時の rescan を選択中 1 社だけに絞る (旧は全社直列)
- `saveWorkspaceConfig` を「同一シリアライズなら writeFile スキップ」
- `profile` 鮮度チェックを listFiles ベースに (旧は全 PDF を parse して 10s 浪費)
- フォルダ自動展開廃止、案件フォルダ選択カードの構造をサイドバーと一致、ファイル数表示撤去

### 基本情報の自動生成廃止 + 削除ボタン (PR #93 マージ済)
- 会社切替時の `autoRefreshProfile` を撤去 (共通フォルダ空でも勝手に AI が走る問題)
- `action: deleteProfile` 追加
- 基本情報タブに [削除] ボタン

### 最終チェック確認事項リスト + PDF (PR #91 マージ済)
- 書類生成 (produce-v2) と一括再生成完了後に自動 verify
- 結果は markdown チェックリスト形式で次の AI メッセージとして表示
- `CheckResultCard` に「PDFで保存」ボタン (hidden iframe で印刷ダイアログ起動)
- 書類カードからバッジ・issue 一覧・proofread/ack UI を撤去 (修正は人間が行う方針)
- verify をストリーミング表示化 (旧は完了まで何も出ず 20-30 秒待ちが見えてた)

### フォルダ選択 + ファイル選択カードを1つに統合
- 旧 5 ステップ → 新 3 ステップ
- FolderSelectCard で accordion 展開、サブフォルダ再帰、ファイルチェックボックス
- カード下部に「この内容で進む」ボタン (複数フォルダ展開可、checked から自動 active 推定のフォールバック付き)
- folder-select カードが未確定の間だけチャットエリア幅を 1100 → 1600px に拡張

### Phase 2-A 質問抽出フェーズ追加
- Phase 2 を 3 段階に分離: `analyze-questions` (テンプレ見て質問) → `clarify` (回答) → `analyze` (穴埋め決定)
- 表記揺れ (徳/德 等)・複数候補・書類間の役割重複 (取締役決定書 vs 株主総会の代取選任) を事前に質問
- 過剰質問抑制 (「資料に書いてある」「形式変換だけ」「定型項目」は質問しない)
- 旧 `clarify-procedural` ルート削除

### execute route に「共通ファイル動的読み込み」tool use
- 案件整理で AI が必要時に共通フォルダの原本ファイル (定款の細かい条文等) を読み込める
- `read_common_file(path)` tool を提供、AI が判断 (MCP 的 auto)
- 「最後の手段」と tool description で厳格化、念のため確認の連発を抑制
- 共通フォルダのファイル一覧をプロンプトに添付 (path のホワイトリスト検証も)

### labels.json の format/sourceHint 活用
- 旧: analyze が `label` だけ読んで `format` / `sourceHint` を捨ててた (死蔵)
- 新: 各テンプレ本文の直下に **slot 補足表** として渡す
  - 例: `★議決権を行使できる株主の数★ → 書式 ○名 / 出典: 基本情報の株主リスト人数`
- 「★label★ に format を埋め込む」案は AI が slot 名を改変してマッチ失敗する事故が起きたので、別表方式に
- 単位消失 (50,000 → 50,000個) や推測 fill の改善に効く

### 画像認識経路の3箇所修正
- 基本情報生成: 既存で image block 対応 (Claude vision)
- execute 初回プロンプト: 案件フォルダで選んだ JPG/PNG を image block で渡すよう修正 (旧は PDF だけだった)
- tool use (read_common_file): tool_result に image block 含めて返すよう拡張 (マイナンバーカード等が AI から見える)
- ※ tool_result の content には document 型 (PDF) は仕様上含められない。PDF はテキスト抽出経由

### pdf-parse 2.x → 1.x ダウングレード
- 2.x は内部で `pdf.worker.mjs` を require して Next.js bundler でパス解決失敗 → PDF 抽出が常時失敗してた
- 基本情報生成は Claude に base64 で PDF 直接渡してたので影響が見えてなかった
- tool use 経路で初めて顕在化
- 1.x は worker 不要、`require("pdf-parse/lib/pdf-parse.js")` で test 起動コード回避

### 既知の未解決問題 / 不安要素

1. **議事録テンプレの議案番号繰り上げ失敗** (旧スキーマ)
   - docx で「議案３」が複数 `<w:t>` に run 分割されてて、`textReplaces` の anchor 検索が失敗
   - `applyReplaces` を「段落単位で結合検索」に改修したら別経路で fill が壊れる副作用 → revert 済み
   - 新 changes スキーマでは段落番号直指定なので構造的に解決するはず

2. **AI が稀に slot 名を labels.json と微妙に違う形で出す**
   - 「議事録記名押印者（代表取締役氏名）」と書くが labels.json は「記名押印する代表取締役の氏名」
   - produce-v2 で照合失敗 → fill 当たらず空欄
   - changes スキーマでも同じ問題は出る可能性。プロンプトで「labels.json の label と完全一致」を強化済み

3. **テンプレ手書きの「★...★」**
   - 黄色マーカー or 赤フォントで囲まれた範囲だけが label として認識される
   - 手書きのプレーンテキスト「★...★」は素通り → 出力にも残る
   - 解決: テンプレ側で該当箇所に黄色マーカーをかける

4. **既知の Word docx 仕様**: run 分割 (`<w:t>` が書式境界で分割) が頻発するので、anchor 検索系は注意が必要

## 月曜 (2026-05-25) デモ向け状態

**対象**: バックオフィスサポートソフトとしてバックオフィス担当者に見せる (VC 向け市場性ピッチではない)

**動かす案件**: 027.株式会社QuantumZero / 取締役就任 案件など

**ブランチ選択**:
- `feat/changes-schema`: 新スキーマ実装。動作未検証
- `feat/unified-file-select`: 旧スキーマだが安定 (PR #94 マージ前提)
- 動作確認して changes が安定してれば feat/changes-schema、不安なら feat/unified-file-select

**デモのキーポイント (現場 hook)**:
1. フォルダ放り込むだけで基本情報出る (共通フォルダ → 基本情報タブ)
2. 案件フォルダ選択 + ファイルチェック で AI が読む (統合カード)
3. 判断要るとこだけ聞いてくる (analyze-questions)
4. 書類が一気に出来上がる (produce-v2)
5. 最終チェックリストが PDF で出せる (verify + CheckResultCard)

**デモ前に避けるべき**:
- 大規模な実装変更 (副作用リスク)
- 触ってないテンプレで動かす (未知の slot 名で AI が混乱する可能性)

## 2026-06-03 セッション: 仕分け式アーキテクチャ (feat/classification-fill) + 清書クリーンアップ

### 仕分け式アーキテクチャ (slotId 直接方式) — feat/classification-fill ブランチ

**核心思想**: 「AI 判断 vs コピペ (機械)」。AI は「各 slot に入れる値」と「テンプレの扱い (fill/loop/ai)」だけ決め、配置は recast が機械的に行う。ラベル名照合 (表記揺れで外れる) を**廃止**し slotId (番号) で直接割り当て。

**フロー**:
1. パーサー (`docx-marker-parser` / `xlsx-marker-parser`) が ★マーカー★ に slotId (連番) を振り、位置 (docx=paraId / xlsx=セル) を `slotPositions` に記録
2. Step A (`src/lib/phase2-plan.ts`): AI を 1 回呼んで `Phase2Plan` を出す。各テンプレを fill/loop/ai に仕分け、各 slot に `{slotId, value}` を割当。**全テンプレを一度に見るので同じ意味の値は全書類で統一できる** (75万円問題の解決)
3. ルール生成 (`src/lib/fill-command-generator.ts`): slotId→位置 と AI の値割当から officecli の set コマンドを機械生成
   - docx: paraId 単位でまとめ、全 slot が空値なら段落ごと remove (未使用の取締役枠を詰める)
   - xlsx: セル単位で再構築 (1 セル複数 slot の上書き事故防止)、% 書式は `normalizePercentValue` で 78.40→78.40% (7840% 事故防止)
4. ai モードのみ AI に officeCommands を直接書かせる (組合で行挿入が要る等、機械化できない場合)
5. produce-v2 officeCommands パスが exec

**有効化**: `RECAST_ENGINE=officecli` (かつ `RECAST_FILL_MODE !== "legacy"`)。`.env.local` に設定済み。

### 清書クリーンアップ (`src/lib/docx-cleanup.ts`) — 本日追加

**問題**: 組合の総数引受契約書「無限責任組合員」行 (7 文字) が `fitText` (文字幅固定=均等割り付け、`w:val="1540"`≈2-4 文字幅) に押し込まれ極小・潰れ表示。**この行は固定テンプレ文で AI/officecli が触らない**ため、生成側で fitText を外す以外に直せない。

**解決**: `cleanupGeneratedDocx(buf)` で生成 docx の XML を直接編集 (PizZip):
- `fitText` 全除去 → 可変長の値が自然な幅で流れる (列揃えは全角スペースが保つので崩れない)
- `highlight` (黄色マーカー) 全除去 → 清書に目印を残さない (ユーザー方針「マーカーは清書に絶対残らないんだから全部消せ」)
- 赤文字マーカー (FF0000) を既定色に戻す

**★officecli ではなく XML 直接編集にした理由★**: officecli の後処理 (set/query) は高負荷時 (Word プロセス枯渇, exit 0xC0000142) に**無言で失敗**し「修正したのに直らない」事故の元凶だった。XML 直接編集なら Word/officecli 非依存・決定論的。produce-v2 の旧 officecli ベース fitText クリアは廃止。

**検証済み**: `4.総数引受契約書.docx` で before/after レンダリング (officecli native screenshot)。fitText 17→0 / highlight 42→0、レイアウト崩れなし。

### 未解決 / 次の候補
- legacy (非 officeCommands) docx パスにも cleanup を適用するか (現状は classification mode のみ。低リスクだが未着手)
- 組合専用テンプレの是非 (株式会社用テンプレを ai モードで組合化すると不安定。専用テンプレ化の方が堅牢という議論が継続中)
- produce-v2 の 14 書類並列 (Promise.all) が Word を枯渇させる件 (concurrency 制限は未実装)

## 環境変数 / 起動の注意点

- `.env.local` が読み込まれない事故あり: PowerShell で明示的に env を注入してから `npm run dev` する方が確実
  ```powershell
  Get-Content .env.local | Where-Object { $_ -match '^([^#=]+)=(.*)$' } | ForEach-Object { $k, $v = $_ -split '=', 2; [System.Environment]::SetEnvironmentVariable($k, $v, 'Process') }; npm run dev
  ```
- port 3000 が他プロセスで使われてると 3001/3002 にフォールバックする。古いプロセス (PID) を kill して 3000 を空けるとブラウザ URL が変わらず楽

## 2026-06-16 セッション: officecli の致命的な落とし穴 + 質問生成の改善 (fix/agenda-block-removal)

### ★★★ 最重要: officecli は「get/view したファイルへの直後の batch」を無言で握り潰す ★★★

**症状**: `officecli get`/`view`/`validate` (read 系) したファイルに、その直後 **同じファイル** へ
`batch` (編集) すると、**全コマンドを success と報告するのに保存が一切反映されない**。
exit 0 で「成功」と返るので気付けない。resident process がファイルを掴むのが原因らしい。

**再現 (実機確認済み)**:
```
cp tpl work.docx; officecli get work.docx /body/p[@paraId=X]; officecli batch work.docx (18cmd)
  → batch は success=18/18。だが work.docx は 1 文字も変わらない ❌
cp tpl work.docx; officecli batch work.docx (18cmd)   # get 無し
  → 全部正しく反映される ✓
cp tpl work.docx; officecli get OTHER.docx ...; officecli batch work.docx (18cmd)  # get は別ファイル
  → 正しく反映される ✓ (汚染はパス固有)
```

**回避策 (鉄則)**: **batch する予定のファイルは、その前に get/view しない。**
読み取りが必要なら **別ファイル (テンプレ原本や使い捨てコピー) に対して** やる。

**これが原因だった 2 つの実バグ (本セッションで修正, commit c40cadf)**:
1. **組合の提案書兼同意書が丸ごとテンプレのまま出力** (ユーザー報告「DEEP30と投資事業有限責任
   組合の書類がまったく変わってない」)。produce-v2 は add コマンド付き書類 (組合の同意欄に
   無限責任組合員等の行を足す) だけ、add の書式継承で **workCopy を get** していた → 直後の
   batch が汚染 → 組合株主の書類だけ会社名・代表・議案・日付・株主すべて未置換 (前テンプレ案件
   = Polaris.AI のデータ) のまま出ていた。個人株主は add 無し=get 無しで正常だった。
   → 修正: 書式 get を `workCopy` → `f.path` (テンプレ原本、batch しない) に変更。
2. **verify のコメントが 1 件も保存されていなかった**。「コメント書き込み完了: 成功 N 件」と
   表示するのに comments.xml は空。view (text/issues/validate) 済みの workPath に batch して
   いたため汚染。→ 修正: view していない新コピー (原本 base64 から作成) にコメントを batch。

**教訓**: officecli の後処理 (set/query/batch) は「成功と言いつつ効いてない」事故を起こす。
docx-cleanup.ts / xlsx-cleanup.ts を PizZip 直接編集にしたのと同じ理由。read と write を
同じファイルで混ぜない。疑わしい時は「生成物を読み戻して実際に変わったか」を必ず確認する。

### 質問生成 (analyze-questions) の改善
- **画像 (マイナンバーカード等) を聞く前に必ず読む** (commit 57c33a8): 生年月日・住所は本人確認
  書類の JPG に写っている。read_common_file の対象を共通だけ→**案件フォルダも追加**、profileSources
  での絞りを撤廃。JPG は image block で渡る (スキャン PDF は tool_result に入れられず未対応=既知制約)。
- **突き合わせをユーザーに代行させない** (commit b71e073): 「カードの住所は登記と一致してますか?」
  のような確認質問を禁止。AI が両方読んで照合し、実際に食い違った時だけ両方の実値で質問する。

### 生成 xlsx の数式再計算 (commit 1f97eaf)
- officecli は数式セルを再計算しないので、合計・割合が古いキャッシュのまま出る事故があった。
  `src/lib/xlsx-cleanup.ts` で workbook.xml の calcPr に `fullCalcOnLoad="1"` を立て、Excel で
  開いた瞬間に強制再計算させる (PizZip 直接編集)。

### コメント書き込みの batch 化 (commit f03aa94)
- 旧: コメント 1 件ごとに officecli 起動 → 14 書類並列直後で Word 枯渇し固まる。
  新: 1 書類 = 1 batch (applyCommands を batch 実装に書き換え)。※ ただし上記 #2 の汚染で
  保存自体が効いていなかった。c40cadf で両方解決。

## 2026-06-17 セッション: 生年月日/組合書類の崩れ + verify を「人間の校正者」化 (fix/agenda-block-removal)

### 生年月日が <UNKNOWN> になる件 (commit dd52c40)
- 生年月日はマイナンバーカード(画像)にしか無く整理結果(テキスト)に出てこない。穴埋め工程
  (analyze/phase2-plan)は文字しか見ず案件画像を再読込しないため値が無く UNKNOWN を出していた。
- 修正: analyze が thread.folderPath の案件フォルダ画像を読み、runPhase2Planning(穴埋め AI)に
  image block で添付。「整理結果に無い値は添付画像から読め」と指示。画像が無ければ従来どおり文字のみ。

### verify を「原本突合せ」から「人間の校正者」に拡張 (commit d858b14)
- ユーザー要望: 人間が読めば当然わかる崩れ(同じ人名が2回 等)に気づいてほしい。
- 追加観点: 1書類内の重複(人名・住所)/構造の崩れ(組合なのに個人の氏名行が残る)/別案件の残骸
  (他書類は同じ社名なのに1枚だけ別社名=置換漏れ)。
- 止めた誤検知: xlsx 数式セル(=SUM)のキャッシュ合計が個別値と合わない件(開けば再計算で直る。
  d225ad6 のセル番号指定では AI に伝わらず、概念で「指摘するな」と明示し直した)/発行日的に
  どちらも正しい住所差(移転前の提案書=旧本店 等)。

### ★組合書類の崩れ = ai モードの不安定さ。原因と対策★
- **症状**: 組合(Deep30投資事業有限責任組合)の提案書が実行ごとに違う壊れ方をした:
  (a)テンプレ(Polaris)のまま / (b)組合構造が欠落(個人扱い) / (c)代表取締役 川上登福 が2箇所にダブる。
- **(a) officecli汚染**: c40cadf で解決 (get/view→同ファイルbatch の無言失敗。2026-06-16 参照)。
- **(b) 分類のブレ**: 提案書を ai に振るべき所を Step A が loop に振ることがある。同じ案件で前回 loop・
  今回 ai と**実行ごとにブレる**ことをダンプで確認 (AIの非決定性。特定入力バグではない)。決定論的に
  ai 矯正する対処を入れたが「対症療法」としてユーザーが却下 (a3677ad → 48f6277 で撤回)。
- **(c) 川上登福ダブり = 根本対策 (commit 295b6bf)**: 原因は officecli ツール説明の
  「add は列ずれするので既存段落を set find/replace で書き換えろ」という**悪いガイド**。これが
  個人→組合変換で「氏名行を代表取締役の値で set 流用」を誘発し、add した代表取締役行とダブった。
  修正: **行数が変わる構造変更は「旧領域を丸ごと remove + 新領域を add」**。旧個人行を新役割行に
  流用(set)するな(ダブる)。add 行の書式は recast が隣行から自動継承するので列ずれ心配の旧ガイドは撤回。
  1対1ラベル変更(商号→名称 等、行数不変)は従来どおり set。→ 実機で川上登福が1回だけ・組合構造どおり
  になるのを確認。

### 設計の考え方 (今後の指針)
- recast は**目隠しで一括生成**: AI はテンプレ+データから commands を出すだけで、組み上がった文書を
  見ない。Claude for Word は**文書を見て編集**するので崩れに気づける。「見る」= 文書を AI に渡す
  = トークン代。verify は recast が後付けで持つ「目」(全書類まとめ読み 1回 ≒ ¥25-30)。
- 構造が変わる所(組合の同意欄)は、バラバラ指示でなく**完成形のまとまり**を AI に書かせる(②)のが筋
  = Claude for Word 式「最初から正しい」。昔やめた全文生成とは別物 (5行の確定ブロックだけなので
  省略/改変リスクは小)。今回は新コマンド型を足さずプロンプトで実現。まだダブるなら構造的に流用不可能な
  setBlock コマンドへ格上げ予定。
- **残課題**: 分類(loop↔ai)のブレ自体は未解決。②で ai モードの生成は堅くなり verify が安全網だが、
  loop に振れると組合書類が崩れる → verify が気づく → 再生成、の形。決定論ルールは却下されている。

## 現在のブランチ

- `main` — 最新 (PR #90 までマージ済み)
- `feat/auto-verify-after-produce` — Close 済 (PR #91 → PR #94 に統合 → さらに作業継続)
- `perf/sidebar-mtime-cache` — Close 済 (PR #92 → PR #94 に統合)
- `feat/profile-manual-only` — Close 済 (PR #93 → PR #94 に統合)
- `feat/unified-file-select` — **作業継続中** (PR #94 が紐づく、上記 3 PR の統合 + フォルダ統合カード + その他改修)
- `feat/changes-schema` — 新スキーマ実装ブランチ (Phase 2 を changes 配列に刷新)
- `feat/classification-fill` — **作業継続中** (仕分け式アーキテクチャ = slotId 直接方式 + 清書クリーンアップ。OfficeCLI ベース)
