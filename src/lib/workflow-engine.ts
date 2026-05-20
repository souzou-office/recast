import Anthropic from "@anthropic-ai/sdk";
import type { ChatThread, ThreadMessage, ActionCard, FolderSelectCard, FileSelectCard, TemplateSelectCard } from "@/types";
import { listFiles } from "./files";
import fs from "fs/promises";
import path from "path";

const client = new Anthropic();

// 新規スレッド作成時の初期メッセージ（フォルダ選択カード）
export async function createInitialMessage(companyId: string, subfolders: { id: string; name: string; role: string }[]): Promise<ThreadMessage> {
  // 各サブフォルダを並列に処理し、中のサブフォルダ一覧 + 各ファイル数まで一括取得
  type Entry = { name: string; path: string; fileCount: number; suffix: string };

  // 直下のサブフォルダ列挙のみ（中身のファイル数カウントはしない＝速い）
  const processSub = async (sub: { id: string; name: string }, suffix: string): Promise<Entry[]> => {
    const entries = await listFiles(sub.id);
    const subDirs = entries.filter(e => e.isDirectory);
    if (subDirs.length === 0) {
      return [{
        name: `${sub.name}${suffix}`,
        path: sub.id,
        fileCount: entries.filter(e => !e.isDirectory).length,
        suffix,
      }];
    }
    return subDirs.map(dir => ({
      name: `${sub.name} / ${dir.name}${suffix}`,
      path: dir.path,
      fileCount: 0,
      suffix,
    }));
  };

  const jobFolders = subfolders.filter(s => s.role === "job");
  const commonFolders = subfolders.filter(s => s.role === "common");

  // 全サブフォルダの処理を完全並列化
  const results = await Promise.all([
    ...jobFolders.map(sub => processSub(sub, "")),
    ...commonFolders.map(sub => processSub(sub, "（共通）")),
  ]);
  const folders: FolderSelectCard["folders"] = results.flat().map(e => ({
    name: e.name, path: e.path, fileCount: e.fileCount,
  }));

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

  // 再帰的にファイルを収集（fs.readdirで全ファイル表示、拡張子フィルタなし）
  async function collect(dirPath: string, prefix: string) {
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch { return; }

    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith("."));
    const fileItems = entries.filter(e => !e.isDirectory() && !e.name.startsWith("."));

    // このフォルダ直下のファイルを先に追加
    for (const f of fileItems) {
      files.push({
        name: prefix ? `  ${f.name}` : f.name,
        path: path.join(dirPath, f.name),
        enabled: true,
      });
    }

    // サブフォルダを順番に処理
    for (const dir of dirs) {
      const folderLabel = prefix ? `${prefix}/${dir.name}` : dir.name;
      files.push({ name: `📁 ${folderLabel}`, path: path.join(dirPath, dir.name), enabled: true });
      await collect(path.join(dirPath, dir.name), folderLabel);
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
export async function onFilesConfirmed(templateBasePath: string, folderName?: string): Promise<ThreadMessage> {
  if (!templateBasePath) {
    return {
      id: `msg_${Date.now()}`,
      role: "assistant",
      content: "書類テンプレートフォルダが設定されていません。設定画面から指定してください。\n\nテンプレートなしで案件整理だけ実行しますか？",
      cards: [],
      timestamp: new Date().toISOString(),
    };
  }

  const { isCommonRuleFolderName } = await import("./global-rules");
  const entries = await listFiles(templateBasePath);
  const templates: TemplateSelectCard["templates"] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    // 共通ルールフォルダは書類テンプレではないので選択肢から外す
    if (isCommonRuleFolderName(entry.name)) continue;
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

  // Haikuでテンプレートを推奨
  let suggestedPath: string | undefined;
  if (folderName && templates.length > 1) {
    try {
      const templateList = templates.map(t => `${t.name}: ${t.path}`).join("\n");
      const res = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: `案件フォルダ名「${folderName}」に最適なテンプレートのパスを1つ選んでください。\n\nテンプレート一覧:\n${templateList}\n\nパスのみ返してください。` }],
      });
      const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
      const found = templates.find(t => text.includes(t.path) || text.includes(t.name));
      if (found) suggestedPath = found.path;
    } catch { /* ignore */ }
  }

  return {
    id: `msg_${Date.now()}`,
    role: "assistant",
    content: suggestedPath ? "テンプレートを推奨しました。変更もできます" : "書類テンプレートを選んでください",
    cards: [{
      type: "template-select",
      templates,
      selectedPath: suggestedPath,
    }],
    timestamp: new Date().toISOString(),
  };
}
