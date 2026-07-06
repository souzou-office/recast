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
  | { type: "answer"; questionId: string }   // ユーザーの回答から
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
  when?: JireiCondition;         // 条件を満たすときだけ必要な書類
}

// 事由（木）本体
export interface Jirei {
  id: string;                    // "mokuteki-henkou"
  name: string;                  // "目的変更"
  description?: string;
  questions: JireiQuestion[];    // 聞く分岐
  documents: JireiDocument[];    // 必要書類
  slots: Record<string, SlotBinding>; // 穴のラベル -> 値の出所
}
