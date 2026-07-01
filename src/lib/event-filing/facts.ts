// 事実ベース = フラットな Record<string, string>。
//
// 基本情報(StructuredProfile) を、事由の木が参照する「事実キー」に平坦化する。
// 事由のスロット binding { type: "fact", key } は、この Record を引く。
//
// ★狙い★: 「会社名」は世界に 1 個の事実。全書類の "会社名" スロットが、ここ 1 箇所を参照する。
//   様式ごとに「これは会社名」と貼り直す必要が無い（横断で 1 事実が全書類を埋める）。

import type { StructuredProfile } from "@/types";

export function profileToFacts(
  p: Partial<StructuredProfile> | null | undefined
): Record<string, string> {
  const facts: Record<string, string> = {};
  if (!p) return facts;

  if (p.商号) facts["会社名"] = p.商号;
  if (p.本店所在地) facts["本店所在地"] = p.本店所在地;
  if (p.発行済株式総数) facts["発行済株式総数"] = p.発行済株式総数;
  if (p.資本金) facts["資本金"] = p.資本金;
  if (p.会社法人等番号) facts["会社法人等番号"] = p.会社法人等番号;

  if (Array.isArray(p.事業目的) && p.事業目的.length > 0) {
    facts["現在の事業目的"] = p.事業目的.join("\n");
  }

  // 代表取締役の氏名を役員から導出（役職に「代表取締役」を含む先頭）
  const rep = (p.役員 || []).find((o) => (o.役職 || "").includes("代表取締役"));
  if (rep?.氏名) facts["代表取締役氏名"] = rep.氏名;

  // 株主数 / 発行済株式総数から派生する定型値は、必要になった事由で足す。
  return facts;
}

// 配列の事実（loop 用）。株主リストのように「1 件 = 1 行」で展開する書類が使う。
export function factList(
  p: Partial<StructuredProfile> | null | undefined,
  key: string
): Record<string, string>[] {
  if (!p) return [];
  if (key === "株主") {
    return (p.株主 || []).map((s) => ({
      氏名: s.氏名 || "",
      住所: s.住所 || "",
      株式数: s.持株数 || "",
      議決権割合: s.持株比率 || "",
    }));
  }
  if (key === "役員") {
    return (p.役員 || []).map((o) => ({
      役職: o.役職 || "",
      氏名: o.氏名 || "",
      住所: o.住所 || "",
      就任日: o.就任日 || "",
    }));
  }
  return [];
}
