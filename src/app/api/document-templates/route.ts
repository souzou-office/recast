import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import type { DocumentTemplate } from "@/types";

const DATA_PATH = path.join(process.cwd(), "data", "document-templates.json");

async function getTemplates(): Promise<DocumentTemplate[]> {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveTemplates(templates: DocumentTemplate[]): Promise<void> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(templates, null, 2), "utf-8");
}

// 一覧取得
export async function GET() {
  const templates = await getTemplates();
  return NextResponse.json({ templates });
}

// 作成・更新
export async function POST(request: NextRequest) {
  const body = await request.json();
  const templates = await getTemplates();

  if (body.id) {
    // 更新
    const idx = templates.findIndex(t => t.id === body.id);
    if (idx >= 0) {
      templates[idx] = { ...templates[idx], ...body, createdAt: templates[idx].createdAt };
    }
  } else {
    // 新規
    templates.push({
      id: `doc_${Date.now()}`,
      name: body.name || "無題",
      category: body.category || "その他",
      content: body.content || "",
      parts: body.parts || undefined,
      createdAt: new Date().toISOString(),
    });
  }

  await saveTemplates(templates);
  return NextResponse.json({ templates });
}

// 削除
export async function DELETE(request: NextRequest) {
  const { id } = await request.json();
  let templates = await getTemplates();
  templates = templates.filter(t => t.id !== id);
  await saveTemplates(templates);
  return NextResponse.json({ templates });
}
