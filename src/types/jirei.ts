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

// 穴(スロット)に入れる値の出所
export type SlotBinding =
  | { type: "fact"; key: string }            // 事実ベースから読む (profileToFacts のキー)
  | { type: "answer"; questionId: string }   // ユーザーの回答から
  | { type: "const"; value: string };        // 固定値

// 聞く分岐（資料で決まらない所だけ）
export interface JireiQuestion {
  id: string;
  label: string;                 // 例: 「変更後の事業目的（全文）を教えてください」
  kind?: "text" | "date" | "choice";
  choices?: string[];
}

// 必要書類（このテンプレを使う）
export interface JireiDocument {
  templateFile: string;          // data/jirei-templates/ 配下のファイル名
  kind: "docx" | "xlsx";
  // 事実の配列 1 件につき 1 行/1 通 展開する場合のキー（省略時 = 単一）
  // 例: "株主" → 株主リストを株主の人数分の行に展開
  repeatOverFactList?: string;
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
