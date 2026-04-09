import type { ChatThread, ThreadMessage, ActionCard, FolderSelectCard, FileSelectCard, TemplateSelectCard } from "@/types";
import { listFiles } from "./files";

// 新規スレッド作成時の初期メッセージ（フォルダ選択カード）
export async function createInitialMessage(companyId: string, subfolders: { id: string; name: string; role: string }[]): Promise<ThreadMessage> {
  // 案件フォルダの中のサブフォルダを表示（実際の案件はその中にある）
  const jobFolders = subfolders.filter(s => s.role === "job");
  const folders: FolderSelectCard["folders"] = [];

  for (const sub of jobFolders) {
    // 案件フォルダの中のサブフォルダを取得
    const entries = await listFiles(sub.id);
    const subDirs = entries.filter(e => e.isDirectory);

    if (subDirs.length > 0) {
      // サブフォルダがある場合、それぞれを選択肢に
      for (const dir of subDirs) {
        const innerEntries = await listFiles(dir.path);
        const fileCount = innerEntries.filter(e => !e.isDirectory).length;
        folders.push({ name: `${sub.name} / ${dir.name}`, path: dir.path, fileCount });
      }
    } else {
      // サブフォルダがなければ、案件フォルダ自体を選択肢に
      const fileCount = entries.filter(e => !e.isDirectory).length;
      folders.push({ name: sub.name, path: sub.id, fileCount });
    }
  }

  // 共通フォルダも含める（参照用）
  const commonFolders = subfolders.filter(s => s.role === "common");
  for (const sub of commonFolders) {
    const entries = await listFiles(sub.id);
    const subDirs = entries.filter(e => e.isDirectory);
    if (subDirs.length > 0) {
      for (const dir of subDirs) {
        const innerEntries = await listFiles(dir.path);
        folders.push({ name: `${sub.name} / ${dir.name}（共通）`, path: dir.path, fileCount: innerEntries.filter(e => !e.isDirectory).length });
      }
    } else {
      folders.push({ name: `${sub.name}（共通）`, path: sub.id, fileCount: entries.filter(e => !e.isDirectory).length });
    }
  }

  return {
    id: `msg_${Date.now()}`,
    role: "assistant",
    content: "案件フォルダを選んでください",
    cards: [{
      type: "folder-select",
      folders,
    }],
    timestamp: new Date().toISOString(),
  };
}

// フォルダ選択後→ファイル選択カードを生成（フォルダ構造付き）
export async function onFolderSelected(folderPath: string): Promise<ThreadMessage> {
  const files: FileSelectCard["files"] = [];

  // 再帰的にファイルを収集（フォルダの直下ファイルはフォルダ行の直後に配置）
  async function collect(dirPath: string, prefix: string) {
    const items = await listFiles(dirPath);
    const dirs = items.filter(e => e.isDirectory);
    const fileItems = items.filter(e => !e.isDirectory);

    // このフォルダ直下のファイルを先に追加
    for (const f of fileItems) {
      files.push({
        name: prefix ? `  ${f.name}` : f.name,
        path: f.path,
        enabled: true,
      });
    }

    // サブフォルダを順番に処理
    for (const dir of dirs) {
      const folderLabel = prefix ? `${prefix}/${dir.name}` : dir.name;
      files.push({ name: `📁 ${folderLabel}`, path: dir.path, enabled: true });
      await collect(dir.path, folderLabel);
    }
  }
  await collect(folderPath, "");

  const fileCount = files.filter(f => !f.name.startsWith("📁")).length;

  return {
    id: `msg_${Date.now()}`,
    role: "assistant",
    content: `${fileCount}件のファイルが見つかりました。外すものがあればチェックを外してください`,
    cards: [{
      type: "file-select",
      folderPath,
      files,
    }],
    timestamp: new Date().toISOString(),
  };
}

// ファイル確定後→テンプレート選択カードを生成
export async function onFilesConfirmed(templateBasePath: string): Promise<ThreadMessage> {
  if (!templateBasePath) {
    return {
      id: `msg_${Date.now()}`,
      role: "assistant",
      content: "書類テンプレートフォルダが設定されていません。設定画面から指定してください。\n\nテンプレートなしで案件整理だけ実行しますか？",
      cards: [],
      timestamp: new Date().toISOString(),
    };
  }

  const entries = await listFiles(templateBasePath);
  const templates: TemplateSelectCard["templates"] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const subEntries = await listFiles(entry.path);
    const fileCount = subEntries.filter(e => !e.isDirectory).length;
    templates.push({ name: entry.name, path: entry.path, fileCount });
  }

  if (templates.length === 0) {
    return {
      id: `msg_${Date.now()}`,
      role: "assistant",
      content: "テンプレートフォルダにテンプレートがありません。案件整理だけ実行します。",
      cards: [],
      timestamp: new Date().toISOString(),
    };
  }

  return {
    id: `msg_${Date.now()}`,
    role: "assistant",
    content: "書類テンプレートを選んでください",
    cards: [{
      type: "template-select",
      templates,
    }],
    timestamp: new Date().toISOString(),
  };
}
