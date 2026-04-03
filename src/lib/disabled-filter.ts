/** disabledFilesリストにファイルまたはフォルダパスが含まれているかチェック */
export function isPathDisabled(filePath: string, disabledFiles: string[]): boolean {
  return disabledFiles.some(d =>
    filePath === d || filePath.startsWith(d + "\\") || filePath.startsWith(d + "/")
  );
}
