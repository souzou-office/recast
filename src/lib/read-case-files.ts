// read-case-files.ts
// 案件フォルダと共通フォルダのファイルを統一的に読み込むヘルパー。
// execute / clarify / produce / verify の全エンドポイントでこれを使う。

import { readAllFilesInFolder, type FileContent } from "./files";
import { isPathDisabled } from "./disabled-filter";
import type { Company } from "@/types";

export interface CaseFileSet {
  commonTexts: string[];    // 共通フォルダのテキスト
  caseTexts: string[];      // 案件フォルダのテキスト
  pdfBlocks: { name: string; base64: string; mimeType: string; tag: string }[];  // PDF content blocks
}

/**
 * 共通フォルダ + 案件フォルダのファイルを読み込む。
 * 案件フォルダは folderPath が指定されていればそれを使い、
 * なければ company.subfolders の active な job フォルダを使う。
 */
export async function readCaseFiles(
  company: Company,
  options?: {
    folderPath?: string;
    disabledFiles?: string[];
  }
): Promise<CaseFileSet> {
  const commonTexts: string[] = [];
  const caseTexts: string[] = [];
  const pdfBlocks: CaseFileSet["pdfBlocks"] = [];

  // 共通フォルダ
  for (const sub of company.subfolders) {
    if (sub.role !== "common") continue;
    const disabled = sub.disabledFiles || [];
    const files = await readAllFilesInFolder(sub.id);
    for (const fc of files) {
      if (isPathDisabled(fc.path, disabled)) continue;
      addFile(fc, "[共通]", commonTexts, pdfBlocks);
    }
  }

  // 案件フォルダ（folderPath優先、なければsub.active）
  if (options?.folderPath) {
    const disabled = options.disabledFiles || [];
    const files = await readAllFilesInFolder(options.folderPath);
    for (const fc of files) {
      if (disabled.includes(fc.path)) continue;
      addFile(fc, "[案件]", caseTexts, pdfBlocks);
    }
  } else {
    for (const sub of company.subfolders) {
      if (!(sub.role === "job" && sub.active)) continue;
      const disabled = sub.disabledFiles || [];
      const files = await readAllFilesInFolder(sub.id);
      for (const fc of files) {
        if (isPathDisabled(fc.path, disabled)) continue;
        addFile(fc, "[案件]", caseTexts, pdfBlocks);
      }
    }
  }

  console.log(`[readCaseFiles] common: ${commonTexts.length} texts, case: ${caseTexts.length} texts, PDFs: ${pdfBlocks.length}`);
  return { commonTexts, caseTexts, pdfBlocks };
}

function addFile(
  fc: FileContent,
  tag: string,
  texts: string[],
  pdfBlocks: CaseFileSet["pdfBlocks"],
) {
  if (fc.base64) {
    const mime = fc.mimeType || "application/pdf";
    if (mime === "application/pdf") {
      pdfBlocks.push({ name: fc.name, base64: fc.base64, mimeType: mime, tag });
      console.log(`[readCaseFiles] ${tag} ${fc.name}: PDF (${Math.round(fc.base64.length / 1024)}KB base64)`);
    } else {
      console.log(`[readCaseFiles] ${tag} ${fc.name}: skipped (base64 but ${mime})`);
    }
  } else if (fc.content && !fc.content.startsWith("[スキップ") && !fc.content.startsWith("[読み取れ")) {
    texts.push(`【${tag} ${fc.name}】\n${fc.content}`);
    console.log(`[readCaseFiles] ${tag} ${fc.name}: text (${fc.content.length} chars)`);
  } else {
    console.log(`[readCaseFiles] ${tag} ${fc.name}: skipped (content: "${(fc.content || "").substring(0, 50)}")`);
  }
}

/**
 * Anthropic API 用の content blocks を構築する。
 * PDF は document block、テキストは text block としてまとめる。
 */
export function buildContentBlocks(
  caseFiles: CaseFileSet,
  promptText: string,
): Array<
  | { type: "text"; text: string }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string }
> {
  const blocks: Array<
    | { type: "text"; text: string }
    | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string }
  > = [];

  // PDF を document blocks として追加
  for (const pdf of caseFiles.pdfBlocks) {
    blocks.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
      title: `${pdf.tag} ${pdf.name}`,
    });
  }

  // テキストとプロンプトをまとめて1つの text block に
  const allTexts = [...caseFiles.commonTexts, ...caseFiles.caseTexts].join("\n\n");
  const fullPrompt = allTexts
    ? `${promptText}\n\n## 原本ファイル（テキスト抽出済み）\n${allTexts}`
    : promptText;

  blocks.push({ type: "text", text: fullPrompt });

  return blocks;
}
