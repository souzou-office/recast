// 事由（登記等の手続き）の定義 = 「分岐の木」。
//
// ★これは「データ」であって「コード」ではない。★
//   新しい事由を足す = data/jirei/<id>.json を 1 枚足すだけ。エンジン（コード）は無改修。
//   司法書士等の専門家が、木（必要書類・聞くこと・穴の値の出所）を編集する。
//
// 全体の流れ:
//   事由ボタンを押す → この木をたどる
//     → 必要書類(documents) を決める
//     → 資料(事実ベース)で埋まらない所だけ質問(questions)する
//     → 各書類の穴(slots) を facts / answers から埋める
//   穴埋め自体は既存エンジン(docx/xlsx marker parser)を再利用。木はその「前段の判断」。

// 条件（分岐）。「この質問の回答が anyOf のいずれかのとき有効」。
// 例: 役員変更で { questionId: "kind", anyOf: ["取締役の就任"] } → 就任のときだけ。
// questions / documents / slots のどれにでも付けられる。付いていなければ常に有効。
export interface JireiCondition {
  questionId: string;
  anyOf: string[];
}

// 穴(スロット)に入れる値の出所
export type SlotBinding = (
  | { type: "fact"; key: string }            // 事実ベースから読む (profileToFacts のキー)
  // ユーザーの回答から。lineField を指定すると「各行を separator で分割して n 番目だけ」を
  // 改行で連結した値になる（例: 回答が「氏名／住所」の行リストで、氏名の一覧だけ欲しいとき）
  | { type: "answer"; questionId: string; lineField?: number; separator?: string }
  | { type: "const"; value: string }         // 固定値
) & { when?: JireiCondition };               // 条件を満たすときだけ有効な穴

// 聞く分岐（資料で決まらない所だけ）
export interface JireiQuestion {
  id: string;
  label: string;                 // 例: 「変更後の事業目的（全文）を教えてください」
  kind?: "text" | "date" | "choice";
  choices?: string[];
  when?: JireiCondition;         // 条件を満たすときだけ聞く（分岐の下の質問）
}

// 必要書類（このテンプレを使う）
export interface JireiDocument {
  templateFile: string;          // data/jirei-templates/ 配下のファイル名
  kind: "docx" | "xlsx";
  // 事実の配列 1 件につき 1 行 展開する場合のキー（省略時 = 単一）
  // 例: "株主" → 株主リストを株主の人数分の行に展開
  repeatOverFactList?: string;
  // xlsx の黄色データ行の「セル文言 → factList のフィールド名」対応。
  // 例: { "株主氏名": "氏名", "株主株式数": "株式数" }
  // テンプレの黄色行のセルに書かれた文言をキーに、その列に入れる値のフィールドを引く。
  rowSlots?: Record<string, string>;
  // 【プレースホルダー】方式（事務所の既存テンプレ規約）の対応表。
  //   キー   = テンプレに書かれた【…】の中の文言（空白は無視して照合）
  //   値     = スロットのラベル（slots のキー）
  // 例: { "令和　　年　　月　　日": "辞任日", "辞任する取締役の氏名": "対象取締役氏名" }
  // これがあれば実物テンプレを黄色マーカー化せず無加工で使える。
  placeholders?: Record<string, string>;
  // repeatOverFactList の絞り込み。一覧の各要素のフィールド値で「この書類を作る対象」を選ぶ。
  // 例: 提案書兼同意書_個人 は { field: "種別", anyOf: ["個人"] }、_法人 は ["法人"]。
  // 同じ一覧に対して種別ごとに別テンプレを出し分けるのに使う（統一ルール③）。
  itemFilter?: { field: string; anyOf: string[] };
  // ★回答から作る一覧★で「1件につき1ファイル」展開（例: 新任取締役ごとの就任承諾書）。
  // 回答の1行 = 1件。行を separator（既定 "／"）で分割し、fields の順にフィールド名を与える。
  // 例: { questionId: "new_directors", fields: ["氏名", "住所"] }
  //     回答「山田太郎／東京都○○」→ { 氏名: "山田太郎", 住所: "東京都○○" }
  repeatOverAnswerList?: { questionId: string; fields: string[]; separator?: string };
  when?: JireiCondition;         // 条件を満たすときだけ必要な書類
}

// 事由が必要とする原本（添付書類の実務知識）。
// 宣言されていると、fact は保存済みの基本情報ではなく「この原本をその場で読んだ結果」から来る。
// 共通フォルダから patterns でファイル名検索し、見つからなければユーザーにドロップを求める。
export interface JireiSource {
  key: string;        // "touki" / "teikan" / "kabunushi"
  label: string;      // "登記情報（履歴事項全部証明書）"
  patterns: string[]; // ファイル名にこのいずれかを含めば該当
  optional?: boolean; // true なら無くても進める（該当 fact は質問に落ちる）
}

// 事由（木）本体
export interface Jirei {
  id: string;                    // "mokuteki-henkou"
  name: string;                  // "目的変更"
  description?: string;
  requiredSources?: JireiSource[]; // 必要な原本（宣言があれば原本直読みモード）
  questions: JireiQuestion[];    // 聞く分岐
  documents: JireiDocument[];    // 必要書類
  // ガード: 条件を満たすとき（when 省略時は常に）にユーザーへ伝える注意・制止。
  // 例: 「実開催用の議事録の雛形が未登録」「辞任で取締役が0名になります」。
  // 書類は出さない・値も埋めない、木に載る「専門家の注意書き」の一般形。
  guards?: { when?: JireiCondition; message: string }[];
  // 穴のラベル -> 値の出所。
  // 配列を書くと「when を満たす最初の出所」が使われる（同じ穴でも分岐によって出所が変わるとき用。
  // 例: 委任状の日付は 就任なら総会日 / 辞任なら辞任日）
  slots: Record<string, SlotBinding | SlotBinding[]>;
}
