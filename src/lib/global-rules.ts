import { readAllFilesInFolder } from "./files";

// 共通ルールフォルダのフォルダ名パターン。
// ここに該当するフォルダは「書類テンプレートの一覧」や「テンプレート解釈」一覧から除外される。
export function isCommonRuleFolderName(name: string): boolean {
  return /^(共通|共通ルール|ルール|rules?|common)/i.test(name);
}

// templateBasePath 直下（または「共通」「ルール」等の専用サブフォルダ）のテキストファイルだけを
// 共通ルールとして読み込む。
//
// 以前の実装は templateBasePath 配下を再帰的に全部読んでいたため、
// 他のテンプレフォルダ（例: 「役員辞任」）の中身まで「共通ルール」として混入し、
// 別案件でも辞任関連の質問が生成される不具合があった。
//
// 共通ルールとして扱うのは以下だけ:
//   - templateBasePath 直下のファイル (depth = 1)
//   - "共通" / "共通ルール" / "rules" / "ルール" 等の専用サブフォルダ内のファイル
export async function loadGlobalRules(
  templateBasePath: string,
  templateFolderPath?: string
): Promise<string> {
  if (!templateBasePath) return "";

  // セパレータを正規化してから比較
  const norm = (s: string): string => s.replace(/\\/g, "/");
  const basePath = norm(templateBasePath).replace(/\/$/, "");

  try {
    const allFiles = await readAllFilesInFolder(templateBasePath);
    const rules = allFiles
      .filter(f => {
        // 選択中テンプレフォルダ配下は除外（テンプレ固有メモとして別途読まれるため二重回避）
        if (templateFolderPath && norm(f.path).startsWith(norm(templateFolderPath))) return false;
        // base64 / 空コンテンツは除外
        if (!f.content || f.content.startsWith("[")) return false;

        const relPath = norm(f.path).slice(basePath.length + 1); // basePath を剥がす
        const segments = relPath.split("/").filter(Boolean);
        if (segments.length === 0) return false;

        // depth = 1（テンプレルート直下のファイル）→ 共通ルール扱い
        if (segments.length === 1) return true;

        // サブフォルダ内: 先頭セグメントが「共通」「ルール」等なら共通ルール扱い
        return isCommonRuleFolderName(segments[0]);
      })
      .map(f => `【共通ルール: ${f.name}】\n${f.content}`)
      .join("\n\n");

    return rules;
  } catch {
    return "";
  }
}
