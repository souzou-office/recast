import { readAllFilesInFolder } from "./files";

// templateBasePath 配下の全ファイルを再帰的に読み込み、共通ルールとして返す。
// templateFolderPath が指定された場合、そのフォルダ（= 選択中のテンプレフォルダ）は除外する。
export async function loadGlobalRules(
  templateBasePath: string,
  templateFolderPath?: string
): Promise<string> {
  if (!templateBasePath) return "";

  try {
    const allFiles = await readAllFilesInFolder(templateBasePath);
    const rules = allFiles
      .filter(f => {
        // テンプレフォルダ自体は除外（二重読み込み防止）
        if (templateFolderPath && f.path.startsWith(templateFolderPath)) return false;
        // テキスト抽出済みのもの（base64のみのファイルは除外）
        if (!f.content || f.content.startsWith("[")) return false;
        return true;
      })
      .map(f => `【共通ルール: ${f.name}】\n${f.content}`)
      .join("\n\n");

    return rules;
  } catch {
    return "";
  }
}
