// 事由駆動型 申請書生成 API。
//
//   GET  /api/jirei                  … 事由の一覧（事由ボタン用）
//   POST /api/jirei                  … { companyId, jireiId, answers }
//     - 未回答の質問が残っている → { phase: "questions", questions, autoFilled }
//     - 全部揃った               → { phase: "done", documents, unresolved }
//
// AI 呼び出しなし・officecli なし。木(データ) + 基本情報(事実) + 回答 から決定論で生成する。

import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceConfig } from "@/lib/folders";
import { listJirei, loadJirei } from "@/lib/jirei/loader";
import { profileToFacts, factList } from "@/lib/event-filing/facts";
import { pendingQuestions, buildFillMap } from "@/lib/event-filing/select";
import { produceJireiDocuments } from "@/lib/event-filing/produce";
import { promises as fs } from "fs";
import path from "path";

const TEMPLATE_DIR = path.join(process.cwd(), "data", "jirei-templates");

export async function GET() {
  const jirei = await listJirei();
  return NextResponse.json({
    jirei: jirei.map((j) => ({
      id: j.id,
      name: j.name,
      description: j.description || "",
      questions: j.questions,
    })),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const companyId: string | undefined = body.companyId;
    const jireiId: string | undefined = body.jireiId;
    const answers: Record<string, string> = body.answers || {};

    if (!companyId) return NextResponse.json({ error: "companyId は必須です" }, { status: 400 });
    if (!jireiId) return NextResponse.json({ error: "jireiId は必須です" }, { status: 400 });

    const config = await getWorkspaceConfig();
    const company = config.companies.find((c) => c.id === companyId);
    if (!company) return NextResponse.json({ error: "会社が見つかりません" }, { status: 404 });

    const jirei = await loadJirei(jireiId);
    if (!jirei) return NextResponse.json({ error: "事由が見つかりません" }, { status: 404 });

    const structured = company.profile?.structured;
    if (!structured) {
      return NextResponse.json(
        { error: "基本情報がありません。先に「基本情報」タブで生成してください" },
        { status: 400 }
      );
    }

    const facts = profileToFacts(structured);

    // 資料から自動で埋まった値（UI で「読めた値」として見せる）
    const autoFilled: Record<string, string> = {};
    for (const [label, binding] of Object.entries(jirei.slots)) {
      if (binding.type === "fact" && facts[binding.key]) {
        autoFilled[label] = facts[binding.key];
      }
    }

    const pending = pendingQuestions(jirei, answers);
    if (pending.length > 0) {
      return NextResponse.json({
        phase: "questions",
        jireiName: jirei.name,
        questions: pending,
        autoFilled,
      });
    }

    // 全て揃った → 生成
    const { filled, unresolved } = buildFillMap(jirei, facts, answers);

    const templates = new Map<string, Buffer>();
    for (const doc of jirei.documents) {
      try {
        templates.set(doc.templateFile, await fs.readFile(path.join(TEMPLATE_DIR, doc.templateFile)));
      } catch {
        return NextResponse.json(
          { error: `テンプレが見つかりません: ${doc.templateFile}（data/jirei-templates/ に置いてください）` },
          { status: 500 }
        );
      }
    }

    const documents = produceJireiDocuments({
      jirei,
      templates,
      filled,
      getList: (key) => factList(structured, key),
    });

    return NextResponse.json({
      phase: "done",
      jireiName: jirei.name,
      documents,
      filled,
      unresolved, // 値が決まらなかった穴（テンプレの文言がそのまま残る）
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "生成に失敗しました" },
      { status: 500 }
    );
  }
}
