// memo-notes.ts
// テンプレフォルダ + 案件フォルダ内の .txt/.md メモ（作成者・担当者が残した指示）を読んで、
// AI プロンプトに添える 1 ブロックの文字列にする。
//
// ★なぜ必要か★
//   テンプレフォルダの メモ.txt はこれまで一切読まれていなかった (analyze/analyze-questions は
//   .txt をスキップ、produce-v2 は docx/xlsx のみ処理)。案件フォルダの .txt は execute(案件整理)
//   が「案件ルール」として読むが、質問生成・穴埋め生成には verbatim で渡っていなかった。
//   この関数を質問生成(analyze-questions)と穴埋め生成(analyze)の両方で使い、メモを確実に効かせる。

import { readAllFilesInFolder } from "./files";

export async function loadMemoNotes(
  templateFolderPath?: string | null,
  caseFolderPath?: string | null
): Promise<string> {
  const notes: string[] = [];
  const pick = async (dir: string | null | undefined, label: string): Promise<void> => {
    if (!dir) return;
    try {
      const files = await readAllFilesInFolder(dir);
      for (const f of files) {
        if (!/\.(txt|md)$/i.test(f.name)) continue;
        const c = (f.content || "").trim();
        if (!c || c.startsWith("[")) continue; // 空 / base64・スキップ等のマーカーは除外
        notes.push(`### ${label}: ${f.name}\n${c}`);
      }
    } catch {
      /* 読めないフォルダは無視 */
    }
  };
  await pick(templateFolderPath, "テンプレ群メモ");
  await pick(caseFolderPath, "案件フォルダメモ");
  if (notes.length === 0) return "";
  return `\n\n## メモ・注意事項 (テンプレ作成者/案件担当者がファイルに残した指示。反映すること)\n${notes.join("\n\n")}`;
}
