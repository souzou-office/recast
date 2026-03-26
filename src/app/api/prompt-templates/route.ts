import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

const DATA_PATH = path.join(process.cwd(), "data", "prompt-templates.json");

interface PromptTemplate {
  id: string;
  label: string;
  prompt: string;
}

const DEFAULT_TEMPLATES: PromptTemplate[] = [
  { id: "summary", label: "案件の概要を教えて", prompt: "この案件の概要を簡潔にまとめてください。" },
  { id: "officers", label: "役員構成を確認", prompt: "現在の役員構成（役職・氏名・就任日・任期満了時期）を教えてください。" },
  { id: "shareholders", label: "株主構成を確認", prompt: "株主構成（氏名・持株数・持株比率）を教えてください。" },
  { id: "schedule", label: "スケジュール確認", prompt: "この案件のスケジュール（各タスクと期限）を教えてください。" },
  { id: "documents", label: "必要書類を確認", prompt: "この案件で必要な書類一覧を教えてください。" },
  { id: "issues", label: "注意点を確認", prompt: "この案件で注意すべき点や確認が必要な事項を教えてください。" },
];

async function getTemplates(): Promise<PromptTemplate[]> {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return DEFAULT_TEMPLATES;
  }
}

async function saveTemplates(templates: PromptTemplate[]): Promise<void> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(templates, null, 2), "utf-8");
}

export async function GET() {
  const templates = await getTemplates();
  return NextResponse.json({ templates });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const templates = await getTemplates();

  if (body.id && templates.find(t => t.id === body.id)) {
    const idx = templates.findIndex(t => t.id === body.id);
    templates[idx] = { ...templates[idx], label: body.label, prompt: body.prompt };
  } else {
    templates.push({
      id: `prompt_${Date.now()}`,
      label: body.label || "無題",
      prompt: body.prompt || "",
    });
  }

  await saveTemplates(templates);
  return NextResponse.json({ templates });
}

export async function DELETE(request: NextRequest) {
  const { id } = await request.json();
  let templates = await getTemplates();
  templates = templates.filter(t => t.id !== id);
  await saveTemplates(templates);
  return NextResponse.json({ templates });
}
