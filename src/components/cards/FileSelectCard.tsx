"use client";

import { useState } from "react";
import type { FileSelectCard, ActionCard } from "@/types";

interface Props {
  card: FileSelectCard;
  onAction: (data: Partial<ActionCard>) => void;
}

export default function FileSelectCardUI({ card, onAction }: Props) {
  const [files, setFiles] = useState(card.files);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const isLocked = !!card.confirmed;

  const toggle = (index: number) => {
    if (isLocked) return;
    const updated = [...files];
    updated[index] = { ...updated[index], enabled: !updated[index].enabled };
    setFiles(updated);
  };

  const toggleFolder = (folderPath: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  // フォルダの配下ファイルインデックスを取得
  const getChildIndices = (folderIndex: number) => {
    const f = files[folderIndex];
    const indices: number[] = [];
    for (let j = folderIndex + 1; j < files.length; j++) {
      if (files[j].name.startsWith("📁") && !files[j].path.startsWith(f.path)) break;
      if (!files[j].name.startsWith("📁")) indices.push(j);
    }
    return indices;
  };

  const confirm = () => {
    onAction({ files, confirmed: true } as Partial<ActionCard>);
  };

  // フォルダ行が展開されているかチェック（そのフォルダのパスがexpandedに含まれるか）
  const isFileVisible = (fileIndex: number) => {
    // ファイルの親フォルダを逆順で探す
    for (let j = fileIndex - 1; j >= 0; j--) {
      if (files[j].name.startsWith("📁")) {
        return expandedFolders.has(files[j].path);
      }
    }
    return true; // トップレベルのファイル
  };

  // サブフォルダが展開されているか
  const isSubFolderVisible = (folderIndex: number) => {
    // 親フォルダを探す
    const f = files[folderIndex];
    for (let j = folderIndex - 1; j >= 0; j--) {
      if (files[j].name.startsWith("📁") && f.path.startsWith(files[j].path) && f.path !== files[j].path) {
        return expandedFolders.has(files[j].path);
      }
    }
    return true; // トップレベルのフォルダ
  };

  return (
    <div className={`rounded-lg border p-3 ${isLocked ? "bg-gray-50 border-gray-200" : "border-blue-200 bg-blue-50"}`}>
      <p className="text-xs font-medium text-gray-600 mb-2">使用するファイルを確認してください</p>
      <div className="space-y-0 max-h-72 overflow-y-auto mb-2">
        {files.map((f, i) => {
          const isFolder = f.name.startsWith("📁");

          if (isFolder) {
            if (!isSubFolderVisible(i)) return null;
            const isOpen = expandedFolders.has(f.path);
            const childIndices = getChildIndices(i);
            const hasChildren = childIndices.length > 0;
            const allEnabled = hasChildren && childIndices.every(j => files[j].enabled);
            const noneEnabled = hasChildren && childIndices.every(j => !files[j].enabled);

            return (
              <div key={f.path} className="flex items-center gap-1 mt-1 first:mt-0 rounded hover:bg-white px-1 py-0.5">
                <input
                  type="checkbox"
                  checked={allEnabled}
                  ref={el => { if (el) el.indeterminate = hasChildren && !allEnabled && !noneEnabled; }}
                  onChange={(e) => {
                    e.stopPropagation();
                    if (isLocked) return;
                    const newEnabled = !allEnabled;
                    const updated = [...files];
                    for (const j of childIndices) updated[j] = { ...updated[j], enabled: newEnabled };
                    setFiles(updated);
                  }}
                  disabled={isLocked || !hasChildren}
                  className="w-3.5 h-3.5 shrink-0"
                />
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFolder(f.path); }}
                  className="flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-blue-600 cursor-pointer"
                  type="button"
                >
                  <span className="text-[10px]">{isOpen ? "▼" : "▶"}</span>
                  <span>📁 {f.name.replace("📁 ", "")}</span>
                </button>
              </div>
            );
          }

          // ファイル：親フォルダが展開されていなければ非表示
          if (!isFileVisible(i)) return null;

          return (
            <label key={f.path} className="flex items-center gap-2 rounded px-4 py-0.5 hover:bg-white cursor-pointer">
              <input
                type="checkbox"
                checked={f.enabled}
                onChange={() => toggle(i)}
                disabled={isLocked}
                className="w-3.5 h-3.5"
              />
              <span className={`text-xs ${f.enabled ? "text-gray-700" : "text-gray-400 line-through"}`}>{f.name.trimStart()}</span>
            </label>
          );
        })}
      </div>
      {!isLocked && (
        <button
          onClick={confirm}
          className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
        >
          これで進める
        </button>
      )}
    </div>
  );
}
