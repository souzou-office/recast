import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

const TEMPLATE_PATH = path.join(process.cwd(), "data", "profile-template.json");

const DEFAULT_ITEMS = [
  "会社法人等番号",
  "商号",
  "本店所在地",
  "設立年月日",
  "事業目的",
  "資本金",
  "発行可能株式総数",
  "発行済株式総数",
  "株式の譲渡制限（承認機関も記載）",
  "役員（役職・氏名・住所・就任日・任期満了）",
  "新株予約権",
  "公告方法",
  "決算期",
  "役員の任期（定款の規定）",
  "株主構成（氏名・住所・持株数・持株比率）",
  "備考",
];

// 取得
export async function GET() {
  try {
    const raw = await fs.readFile(TEMPLATE_PATH, "utf-8");
    const data = JSON.parse(raw);
    return NextResponse.json({ items: data.items || DEFAULT_ITEMS });
  } catch {
    return NextResponse.json({ items: DEFAULT_ITEMS });
  }
}

// 保存
export async function POST(request: NextRequest) {
  const { items } = await request.json();
  if (!items || !Array.isArray(items)) {
    return NextResponse.json({ error: "items は配列で指定してください" }, { status: 400 });
  }

  await fs.mkdir(path.dirname(TEMPLATE_PATH), { recursive: true });
  await fs.writeFile(TEMPLATE_PATH, JSON.stringify({ items }, null, 2), "utf-8");

  return NextResponse.json({ items });
}
