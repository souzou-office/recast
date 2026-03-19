import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import type { CheckTemplate } from "@/types";

const DATA_PATH = path.join(process.cwd(), "data", "templates.json");

async function getTemplates(): Promise<CheckTemplate[]> {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveTemplates(templates: CheckTemplate[]): Promise<void> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(templates, null, 2), "utf-8");
}

// 一覧取得
export async function GET() {
  return NextResponse.json(await getTemplates());
}

// テンプレート保存（新規 or 更新）
export async function POST(request: NextRequest) {
  const template: CheckTemplate = await request.json();

  if (!template.id || !template.name || !template.items) {
    return NextResponse.json({ error: "id, name, items は必須です" }, { status: 400 });
  }

  const templates = await getTemplates();
  const idx = templates.findIndex(t => t.id === template.id);

  if (idx >= 0) {
    templates[idx] = template;
  } else {
    templates.push(template);
  }

  await saveTemplates(templates);
  return NextResponse.json(templates);
}

// テンプレート削除
export async function DELETE(request: NextRequest) {
  const { id } = await request.json();
  let templates = await getTemplates();
  templates = templates.filter(t => t.id !== id);
  await saveTemplates(templates);
  return NextResponse.json(templates);
}
