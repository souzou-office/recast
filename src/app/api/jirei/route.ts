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
import { pendingQuestions, buildFillMap, requiredDocuments, activeSlots } from "@/lib/event-filing/select";
import { produceJireiDocuments } from "@/lib/event-filing/produce";
import {
  findSourceFiles,
  extractFactsFromSources,
  SourceFileInput,
} from "@/lib/event-filing/source-facts";
import { promises as fs } from "fs";
import path from "path";
import type { StructuredProfile } from "@/types";

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

    // --- fact の出所を決める ---
    // requiredSources が宣言された木 = 原本直読みモード（定款・登記情報そのものを読む）。
    // 宣言が無い木 = 従来どおり保存済みの基本情報から。
    let structured: Record<string, unknown> | undefined;
    let evidence: Record<string, string> = {};
    let sourceMeta: { files: string[]; cached: boolean } | null = null;

    if (jirei.requiredSources && jirei.requiredSources.length > 0) {
      // クライアントからドロップされた原本（base64）
      const dropped: SourceFileInput[] = (body.sources || [])
        .filter((s: { name?: string; base64?: string }) => s?.name && s?.base64)
        .map((s: { name: string; base64: string }) => ({
          name: s.name,
          buffer: Buffer.from(s.base64, "base64"),
        }));

      // 共通フォルダから自動発見
      const { found } = await findSourceFiles(company, jirei.requiredSources);

      // 原本の受付状況（種類ごと）。ドロップが自動発見より優先（取り寄せ直した最新を使う意図）
      const droppedFor = (src: (typeof jirei.requiredSources)[number]) =>
        dropped.find((d) => src.patterns.some((p) => d.name.includes(p)));
      const status = jirei.requiredSources.map((src) => {
        const drop = droppedFor(src);
        if (drop) return { label: src.label, optional: !!src.optional, kind: "dropped" as const, name: drop.name };
        const hit = found.find((f) => f.source.key === src.key);
        if (hit) return { label: src.label, optional: !!src.optional, kind: "found" as const, name: hit.name };
        return { label: src.label, optional: !!src.optional, kind: "missing" as const, name: null };
      });
      const missingRequired = status.filter((s) => s.kind === "missing" && !s.optional);

      // ★実務の順番★: 事由を選んだらまず「必要書類の受付」を出す。
      // ユーザーが資料を確認して「この資料で読み取る」を押すまで（sourcesConfirmed）先へ進まない。
      if (body.sourcesConfirmed !== true || missingRequired.length > 0) {
        return NextResponse.json({
          phase: "sources",
          jireiName: jirei.name,
          sources: status,
          ready: missingRequired.length === 0,
        });
      }

      // 読み取り対象を確定（ドロップ優先。ドロップでカバーされた種類の自動発見分は使わない）
      const files: SourceFileInput[] = [...dropped];
      for (const f of found) {
        if (droppedFor(f.source)) continue;
        if (files.some((x) => x.name === f.name)) continue;
        files.push({ name: f.name, buffer: await fs.readFile(f.path) });
      }

      const extracted = await extractFactsFromSources(files);
      structured = extracted.structured;
      evidence = extracted.evidence;
      sourceMeta = { files: extracted.sourceNames, cached: extracted.cached };
    } else {
      structured = company.profile?.structured as Record<string, unknown> | undefined;
      if (!structured) {
        return NextResponse.json(
          { error: "基本情報がありません。先に「基本情報」タブで生成してください" },
          { status: 400 }
        );
      }
    }

    const facts = profileToFacts(structured as Partial<StructuredProfile>);

    // 資料から自動で埋まった値（UI で「読めた値」として見せる）。when を満たすスロットだけ。
    // evidenceByLabel = 解釈を含む値の根拠（定款の条文引用）。人が原文で確認できる。
    const autoFilled: Record<string, string> = {};
    const evidenceByLabel: Record<string, string> = {};
    for (const [label, binding] of activeSlots(jirei, answers)) {
      if (binding.type === "fact" && facts[binding.key]) {
        autoFilled[label] = facts[binding.key];
        if (evidence[binding.key]) evidenceByLabel[label] = evidence[binding.key];
      }
    }

    const pending = pendingQuestions(jirei, answers);
    if (pending.length > 0) {
      return NextResponse.json({
        phase: "questions",
        jireiName: jirei.name,
        questions: pending,
        autoFilled,
        evidenceByLabel,
        sourceMeta,
      });
    }

    // 全て揃った → 生成（when を満たす書類だけ）
    const { filled, unresolved } = buildFillMap(jirei, facts, answers);
    const docsToMake = requiredDocuments(jirei, answers);

    const templates = new Map<string, Buffer>();
    for (const doc of docsToMake) {
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
      documents: docsToMake,
      templates,
      filled,
      getList: (key) => factList(structured as Partial<StructuredProfile>, key),
    });

    return NextResponse.json({
      phase: "done",
      jireiName: jirei.name,
      documents,
      filled,
      unresolved, // 値が決まらなかった穴（テンプレの文言がそのまま残る）
      sourceMeta,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "生成に失敗しました" },
      { status: 500 }
    );
  }
}
