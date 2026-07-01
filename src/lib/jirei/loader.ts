// 事由（木）のローダー。data/jirei/<id>.json を読むだけ。
//
// ★事由を足す = data/jirei に JSON を 1 枚置くだけ。このローダーも含めコードは無改修。★

import { promises as fs } from "fs";
import path from "path";
import type { Jirei } from "@/types/jirei";

const JIREI_DIR = path.join(process.cwd(), "data", "jirei");

// 全事由（事由ボタンの一覧用）。壊れた JSON はスキップ。
export async function listJirei(): Promise<Jirei[]> {
  let files: string[];
  try {
    files = await fs.readdir(JIREI_DIR);
  } catch {
    return []; // ディレクトリが無ければ空
  }
  const out: Jirei[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(JIREI_DIR, f), "utf-8");
      out.push(JSON.parse(raw) as Jirei);
    } catch {
      // 壊れた木は無視して続行
    }
  }
  return out;
}

export async function loadJirei(id: string): Promise<Jirei | null> {
  try {
    const raw = await fs.readFile(path.join(JIREI_DIR, `${id}.json`), "utf-8");
    return JSON.parse(raw) as Jirei;
  } catch {
    return null;
  }
}
