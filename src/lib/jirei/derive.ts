// ★機械導出★（deriveAnswers）— 「専門家なら客に聞かず自分で埋める値」の決定論エンジン。
//
// 質問に derive が付いていると、他の回答・事実からその質問の答えを導く。
//   - copy            : 別の回答/事実をそのまま（または和暦分解して）使う。日付の既定値の一般形。
//   - registry-office : 商業登記の管轄法務局を住所から判定（管轄表 data/jirei/houmukyoku.json）。
//                       2住所の比較（管轄内/外）と、法務局名の取得の両方に使う。
// 導出できないとき（出典未回答・住所から都道府県が読めない等）は undefined を返し、
// その質問は従来どおりユーザーに聞かれる（安全側に倒れる）。
//
// AI ゼロ・決定論。導出値は根拠（basis）付きで返し、UI が「こちらで埋めた値」として見せる。
// ユーザーが answers で明示的に答えていれば導出しない（人の上書きが常に勝つ）。

import { promises as fs } from "fs";
import path from "path";
import { condOk } from "@/lib/event-filing/select";
import type { Jirei, JireiDeriveSource } from "@/types/jirei";

const HOUMUKYOKU_PATH = path.join(process.cwd(), "data", "jirei", "houmukyoku.json");

// 管轄表。41県は「都道府県 → 識別名」の文字列。複数庁の7都道府県（東京・神奈川・静岡・
// 愛知・大阪・福岡・北海道）は { _default?, units: { 市区町村プレフィックス → 識別名 } }。
// 識別名 = 「法務局名＋半角スペース＋支局・出張所名」（本局は法務局名のみ）。
// ★管轄内/外の判定単位は都道府県ではなく登記所★（例: 文京区→港区は同じ東京都でも管轄外）。
type OfficeEntry = string | { _default?: string; units: Record<string, string> };
interface RegistryTable {
  offices: Record<string, OfficeEntry>;
}

let tableCache: RegistryTable | null | undefined;

async function loadRegistryTable(): Promise<RegistryTable | null> {
  if (tableCache !== undefined) return tableCache;
  try {
    const raw = await fs.readFile(HOUMUKYOKU_PATH, "utf-8");
    const data = JSON.parse(raw.replace(/^﻿/, ""));
    tableCache = { offices: data.offices || {} };
  } catch {
    tableCache = null; // 表が無ければ管轄導出は全部「導出できない」= 従来どおり聞く
  }
  return tableCache;
}

const toHalfWidthDigits = (s: string) =>
  s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// 「令和8年3月2日」「令和８年３月２日」「令和元年…」→ ["8","3","2"]。読めなければ null。
export function parseWarekiYmd(value: string): [string, string, string] | null {
  const s = toHalfWidthDigits(value.trim()).replace(/元年/, "1年");
  const m = s.match(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return null;
  return [m[1], m[2], m[3]];
}

// 住所 → 商業登記の管轄登記所の識別名。判定できなければ null（→ 従来どおり質問に落ちる）。
export function registryOfficeOf(address: string, table: RegistryTable): string | null {
  const addr = address.trim().replace(/\s/g, "");
  if (!addr) return null;
  const pref = Object.keys(table.offices).find((p) => addr.startsWith(p));
  if (!pref) return null;
  const entry = table.offices[pref];
  if (typeof entry === "string") return entry;
  // 複数庁の都道府県: 市区町村プレフィックスで振り分け（長い一致を優先 = 「紋別郡遠軽町」が「紋別市」等と衝突しない）
  const rest = addr.slice(pref.length);
  const unit = Object.keys(entry.units)
    .sort((a, b) => b.length - a.length)
    .find((u) => rest.startsWith(u));
  if (unit) return entry.units[unit];
  return entry._default || null;
}

// 識別名 → 法務局名（bureau）と支局・出張所名（branch。「港出張所」→「港」。本局は空）
export function splitOffice(office: string): { bureau: string; branch: string } {
  const [bureau, ...restParts] = office.split(" ");
  const branch = restParts.join(" ").replace(/(支局|出張所)$/, "");
  return { bureau, branch };
}

function resolveSource(
  src: JireiDeriveSource,
  facts: Record<string, string>,
  answers: Record<string, string>
): { value: string; label: string } | null {
  if ("answer" in src) {
    const v = (answers[src.answer] || "").trim();
    return v ? { value: v, label: src.answer } : null;
  }
  const v = (facts[src.fact] || "").trim();
  return v ? { value: v, label: src.fact } : null;
}

export interface DerivedAnswer {
  value: string;
  basis: string; // 人が確かめられる根拠（「移転日と同日」「両住所とも東京法務局の管轄」等）
}

// 質問順に評価し、導けた値は後続の導出の入力にもなる（連鎖）。
// when を満たさない質問・ユーザーが既に答えた質問は導出しない。
export async function deriveAnswers(
  jirei: Jirei,
  facts: Record<string, string>,
  answers: Record<string, string>
): Promise<Record<string, DerivedAnswer>> {
  const out: Record<string, DerivedAnswer> = {};
  const effective: Record<string, string> = { ...answers };
  const table = await loadRegistryTable();

  for (const q of jirei.questions) {
    if (!q.derive) continue;
    if ((answers[q.id] || "").trim() !== "") continue; // 人の回答が常に勝つ
    if (!condOk(q.when, effective)) continue;

    const d = q.derive;
    if (d.kind === "copy") {
      const src = resolveSource(d.from, facts, effective);
      if (!src) continue;
      if (d.format === "wareki-ymd") {
        const parts = parseWarekiYmd(src.value);
        if (!parts) continue;
        out[q.id] = { value: parts.join("／"), basis: `「${src.value}」から（${sourceLabel(d.from, jirei)}）` };
      } else {
        out[q.id] = { value: src.value, basis: `${sourceLabel(d.from, jirei)}と同じ` };
      }
      effective[q.id] = out[q.id].value;
      continue;
    }

    if (d.kind === "registry-office") {
      if (!table) continue;
      const addr = resolveSource(d.address, facts, effective);
      if (!addr) continue;
      const office = registryOfficeOf(addr.value, table);
      if (!office) continue;
      if (d.compareTo) {
        const other = resolveSource(d.compareTo, facts, effective);
        if (!other) continue;
        const otherOffice = registryOfficeOf(other.value, table);
        if (!otherOffice) continue;
        const sameOffice = office === otherOffice;
        const value = sameOffice ? d.same : d.different;
        if (!value) continue;
        out[q.id] = {
          value,
          basis: sameOffice
            ? `${sourceLabel(d.compareTo, jirei)}・${sourceLabel(d.address, jirei)}とも ${office.replace(" ", "")} の管轄`
            : `${sourceLabel(d.compareTo, jirei)}=${otherOffice.replace(" ", "")} → ${sourceLabel(d.address, jirei)}=${office.replace(" ", "")}`,
        };
      } else {
        const { bureau, branch } = splitOffice(office);
        // part: "branch" = 支局・出張所名だけ（本局なら全角スペース = 様式の欄を空欄にする）
        const value = d.part === "branch" ? branch || "　" : bureau;
        out[q.id] = {
          value,
          basis:
            d.part === "branch" && !branch
              ? `${sourceLabel(d.address, jirei)}の管轄は${bureau}の本局のため空欄`
              : `${sourceLabel(d.address, jirei)}「${addr.value.slice(0, 20)}」の商業登記管轄（${office.replace(" ", "")}）`,
        };
      }
      effective[q.id] = out[q.id].value;
    }
  }
  return out;
}

// 根拠表示用の出典名（answer は質問文の先頭、fact はキー名そのまま）
function sourceLabel(src: JireiDeriveSource, jirei: Jirei): string {
  if ("fact" in src) return src.fact;
  const q = jirei.questions.find((x) => x.id === src.answer);
  const label = q?.label || src.answer;
  return label.replace(/[（(].*$/, "").replace(/は？.*$/, "").trim() || src.answer;
}
