// 事由駆動フローの最小デモ（plain node で実行）。
//   node scripts/jirei-demo.mjs
//
// data/jirei/mokuteki-henkou.json（木＝データ）を読み、サンプル会社の基本情報から
// 「必要書類・聞くこと・穴の値」が機械的に出るのを確認する。
// ※ src/lib/event-filing/select.ts と同じロジックの JS ポート（デモ用）。

import { readFileSync } from "fs";
import path from "path";

const jirei = JSON.parse(
  readFileSync(path.join(process.cwd(), "data", "jirei", "mokuteki-henkou.json"), "utf-8")
);

// --- サンプル: QuantumZero の基本情報（本来は共通フォルダを読んで生成済み） ---
const profile = {
  商号: "株式会社QuantumZero",
  本店所在地: "東京都渋谷区神宮前一丁目2番3号",
  発行済株式総数: "1000株",
  事業目的: ["ソフトウェアの開発", "コンサルティング"],
  役員: [
    { 役職: "代表取締役", 氏名: "三上春香" },
    { 役職: "取締役", 氏名: "田中一郎" },
  ],
  株主: [
    { 氏名: "三上春香", 住所: "東京都渋谷区…", 持株数: "700株", 持株比率: "70%" },
    { 氏名: "田中一郎", 住所: "東京都新宿区…", 持株数: "300株", 持株比率: "30%" },
  ],
};

// facts.ts の profileToFacts 相当（デモ用ポート）
function profileToFacts(p) {
  const f = {};
  if (p.商号) f["会社名"] = p.商号;
  if (p.本店所在地) f["本店所在地"] = p.本店所在地;
  if (p.発行済株式総数) f["発行済株式総数"] = p.発行済株式総数;
  if (Array.isArray(p.事業目的) && p.事業目的.length) f["現在の事業目的"] = p.事業目的.join(" / ");
  const rep = (p.役員 || []).find((o) => (o.役職 || "").includes("代表取締役"));
  if (rep) f["代表取締役氏名"] = rep.氏名;
  return f;
}

// select.ts 相当（デモ用ポート）
function resolveSlot(b, facts, answers) {
  if (b.type === "fact") return facts[b.key] ?? null;
  if (b.type === "answer") return answers[b.questionId] ?? null;
  if (b.type === "const") return b.value;
  return null;
}
function pendingQuestions(j, answers) {
  const needed = new Set();
  for (const b of Object.values(j.slots)) if (b.type === "answer") needed.add(b.questionId);
  return j.questions.filter((q) => needed.has(q.id) && !(answers[q.id] && answers[q.id].trim()));
}
function buildFillMap(j, facts, answers) {
  const filled = {}, unresolved = [];
  for (const [label, b] of Object.entries(j.slots)) {
    const v = resolveSlot(b, facts, answers);
    if (v == null || v === "") unresolved.push(label);
    else filled[label] = v;
  }
  return { filled, unresolved };
}

const facts = profileToFacts(profile);

console.log(`\n■ 事由ボタン: [${jirei.name}] を押した\n`);

console.log("① 木が決めた必要書類:");
for (const d of jirei.documents) {
  console.log(`   - ${d.templateFile}${d.repeatOverFactList ? `（${d.repeatOverFactList}の人数分）` : ""}`);
}

console.log("\n② 資料で埋まった穴（聞かない）:");
for (const [label, b] of Object.entries(jirei.slots)) {
  if (b.type !== "fact") continue;
  const v = resolveSlot(b, facts, {});
  console.log(`   - ${label} = ${v ?? "（資料に無し→要確認）"}`);
}

console.log("\n③ 資料で埋まらず、聞く必要がある質問だけ:");
for (const q of pendingQuestions(jirei, {})) console.log(`   ? ${q.label}`);

// --- ユーザーが回答した後 ---
const answers = {
  new_purpose: "1. ソフトウェアの開発\n2. コンサルティング\n3. 前各号に附帯関連する一切の業務",
  meeting_date: "令和8年6月20日",
};
console.log("\n④ 回答後 → 各穴の最終値（この map を既存の穴埋めエンジンに渡す）:");
const { filled, unresolved } = buildFillMap(jirei, facts, answers);
for (const [label, v] of Object.entries(filled)) {
  console.log(`   - ${label} = ${String(v).replace(/\n/g, " / ")}`);
}
if (unresolved.length) console.log(`   ! 未解決の穴: ${unresolved.join(", ")}`);
else console.log("   ✓ 全ての穴が埋まった（要確認ゼロ）");

console.log("");
