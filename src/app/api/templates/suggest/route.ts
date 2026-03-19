import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import type { CheckTemplate } from "@/types";

const TEMPLATES_PATH = path.join(process.cwd(), "data", "templates.json");

// 案件フォルダ名からテンプレートを推定
export async function GET() {
  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === config.selectedCompanyId);
  if (!company) {
    return NextResponse.json({ error: "会社未選択" }, { status: 400 });
  }

  const activeJobs = company.subfolders.filter(s => s.role === "job" && s.active);
  if (activeJobs.length === 0) {
    return NextResponse.json({ error: "案件フォルダが未選択" }, { status: 400 });
  }

  const raw = await fs.readFile(TEMPLATES_PATH, "utf-8");
  const templates: CheckTemplate[] = JSON.parse(raw);

  // フォルダ名からキーワードマッチ
  const jobNames = activeJobs.map(j => j.name).join(" ");
  const lower = jobNames.toLowerCase();

  const keywords: Record<string, string[]> = {
    "officer-appointment": ["役員", "就任", "退任", "取締役", "選任", "重任"],
  };

  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const [id, words] of Object.entries(keywords)) {
    const score = words.filter(w => lower.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = id;
    }
  }

  const suggested = bestMatch ? templates.find(t => t.id === bestMatch) : null;

  return NextResponse.json({
    suggested: suggested || null,
    templates,
    jobNames: activeJobs.map(j => j.name),
  });
}
