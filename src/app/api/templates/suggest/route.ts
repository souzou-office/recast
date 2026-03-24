import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import { getWorkspaceConfig } from "@/lib/folders";
import type { CheckTemplate } from "@/types";

const client = new Anthropic();
const TEMPLATES_PATH = path.join(process.cwd(), "data", "templates.json");

// 案件フォルダ名からテンプレートを推定（Haiku）
export async function GET() {
  const config = await getWorkspaceConfig();
  const company = config.companies.find(c => c.id === config.selectedCompanyId);
  let templates: CheckTemplate[] = [];
  try {
    const raw = await fs.readFile(TEMPLATES_PATH, "utf-8");
    templates = JSON.parse(raw);
  } catch {
    return NextResponse.json({ suggested: null, templates: [], jobNames: [] });
  }

  if (!company) {
    return NextResponse.json({ suggested: null, templates, jobNames: [] });
  }

  const activeJobs = company.subfolders.filter(s => s.role === "job" && s.active);
  if (activeJobs.length === 0) {
    return NextResponse.json({ suggested: null, templates, jobNames: [] });
  }

  if (templates.length === 0) {
    return NextResponse.json({ suggested: null, templates, jobNames: activeJobs.map(j => j.name) });
  }

  const jobNames = activeJobs.map(j => j.name);
  const templateList = templates.map(t => `${t.id}: ${t.name}`).join("\n");

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{
        role: "user",
        content: `以下の案件フォルダ名から、最も適切なテンプレートのIDを1つ選んでください。
該当するものがなければ「なし」と回答してください。

案件フォルダ名:
${jobNames.map(n => `- ${n}`).join("\n")}

テンプレート一覧:
${templateList}

回答はIDのみ（例: officer-appointment）。該当なしなら「なし」。`
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
    const suggested = text !== "なし" ? templates.find(t => t.id === text) : null;

    return NextResponse.json({
      suggested: suggested || null,
      templates,
      jobNames,
    });
  } catch {
    // Haiku失敗時はテンプレート一覧だけ返す
    return NextResponse.json({ suggested: null, templates, jobNames });
  }
}
