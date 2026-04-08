import type { ChatThread, ThreadMessage, ActionCard, FolderSelectCard, FileSelectCard, TemplateSelectCard } from "@/types";
import { listFiles } from "./files";

// 新規スレッド作成時の初期メッセージ（フォルダ選択カード）
export async function createInitialMessage(companyId: string, subfolders: { id: string; name: string; role: string }[]): Promise<ThreadMessage> {
  // 案件フォルダ一覧を構築
  const jobFolders = subfolders.filter(s => s.role === "job");
  const folders: FolderSelectCard["folders"] = [];

  for (const sub of jobFolders) {
    const entries = await listFiles(sub.id);
    const fileCount = entries.filter(e => !e.isDirectory).length;
    const subCount = entries.filter(e => e.isDirectory).length;
    folders.push({ name: sub.name, path: sub.id, fileCount: fileCount + subCount });
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

// フォルダ選択後→ファイル選択カードを生成
export async function onFolderSelected(folderPath: string): Promise<ThreadMessage> {
  const entries = await listFiles(folderPath);
  const files: FileSelectCard["files"] = [];

  // 再帰的にファイルを収集
  async function collect(dirPath: string, prefix: string) {
    const items = await listFiles(dirPath);
    for (const item of items) {
      if (item.isDirectory) {
        await collect(item.path, prefix ? `${prefix}/${item.name}` : item.name);
      } else {
        files.push({
          name: prefix ? `${prefix}/${item.name}` : item.name,
          path: item.path,
          enabled: true,
        });
      }
    }
  }
  await collect(folderPath, "");

  return {
    id: `msg_${Date.now()}`,
    role: "assistant",
    content: `${files.length}件のファイルが見つかりました。使用するファイルを確認してください`,
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
