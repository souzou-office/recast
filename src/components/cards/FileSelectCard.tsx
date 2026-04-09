"use client";

import { useState } from "react";
import type { FileSelectCard, ActionCard } from "@/types";

interface Props {
  card: FileSelectCard;
  onAction: (data: Partial<ActionCard>) => void;
}

interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children: TreeNode[];
  fileIndex: number; // filesの中のindex（フォルダは-1）
}

function buildTree(files: FileSelectCard["files"]): TreeNode[] {
  const roots: TreeNode[] = [];
  let currentFolder: TreeNode | null = null;
  let currentSubFolder: TreeNode | null = null;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.name.startsWith("📁 ")) {
      const label = f.name.replace("📁 ", "");
      const depth = (label.match(/\//g) || []).length;
      const node: TreeNode = { name: label.split("/").pop() || label, path: f.path, isFolder: true, children: [], fileIndex: i };

      if (depth === 0) {
        roots.push(node);
        currentFolder = node;
        currentSubFolder = null;
      } else if (currentFolder) {
        currentFolder.children.push(node);
        currentSubFolder = node;
      }
    } else {
      const node: TreeNode = { name: f.name.trimStart(), path: f.path, isFolder: false, children: [], fileIndex: i };
      if (currentSubFolder) {
        currentSubFolder.children.push(node);
      } else if (currentFolder) {
        currentFolder.children.push(node);
      } else {
        roots.push(node);
      }
    }
  }
  return roots;
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

  // フォルダ内の全ファイルインデックスを再帰で取得
  const getAllFileIndices = (node: TreeNode): number[] => {
    const indices: number[] = [];
    for (const child of node.children) {
      if (child.isFolder) {
        indices.push(...getAllFileIndices(child));
      } else {
        indices.push(child.fileIndex);
      }
    }
    return indices;
  };

  const toggleFolderFiles = (node: TreeNode) => {
    if (isLocked) return;
    const indices = getAllFileIndices(node);
    if (indices.length === 0) return;
    const allEnabled = indices.every(i => files[i].enabled);
    const updated = [...files];
    for (const i of indices) updated[i] = { ...updated[i], enabled: !allEnabled };
    setFiles(updated);
  };

  const confirm = () => {
    onAction({ files, confirmed: true } as Partial<ActionCard>);
  };

  const tree = buildTree(files);

  const renderNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    if (node.isFolder) {
      const isOpen = expandedFolders.has(node.path);
      const childFileIndices = getAllFileIndices(node);
      const hasFiles = childFileIndices.length > 0;
      const allEnabled = hasFiles && childFileIndices.every(i => files[i].enabled);
      const noneEnabled = hasFiles && childFileIndices.every(i => !files[i].enabled);

      return (
        <div key={node.path} style={{ marginLeft: depth * 16 }}>
          <div className="flex items-center gap-1 rounded hover:bg-white px-1 py-0.5">
            <input
              type="checkbox"
              checked={allEnabled}
              ref={el => { if (el) el.indeterminate = hasFiles && !allEnabled && !noneEnabled; }}
              onChange={() => toggleFolderFiles(node)}
              disabled={isLocked || !hasFiles}
              className="w-3.5 h-3.5 shrink-0"
            />
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFolder(node.path); }}
              type="button"
              className="flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-blue-600 cursor-pointer"
            >
              <span className="text-[10px]">{isOpen ? "▼" : "▶"}</span>
              <span>📁 {node.name}</span>
              <span className="text-[9px] text-gray-400">({childFileIndices.length})</span>
            </button>
          </div>
          {isOpen && (
            <div>
              {node.children.map(child => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    // ファイル
    return (
      <label key={node.path} className="flex items-center gap-2 rounded px-2 py-0.5 hover:bg-white cursor-pointer" style={{ marginLeft: depth * 16 }}>
        <input
          type="checkbox"
          checked={files[node.fileIndex].enabled}
          onChange={() => toggle(node.fileIndex)}
          disabled={isLocked}
          className="w-3.5 h-3.5"
        />
        <span className={`text-xs ${files[node.fileIndex].enabled ? "text-gray-700" : "text-gray-400 line-through"}`}>{node.name}</span>
      </label>
    );
  };

  return (
    <div className={`rounded-lg border p-3 ${isLocked ? "bg-gray-50 border-gray-200" : "border-blue-200 bg-blue-50"}`}>
      <p className="text-xs font-medium text-gray-600 mb-2">使用するファイルを確認してください</p>
      <div className="max-h-72 overflow-y-auto mb-2">
        {tree.map(node => renderNode(node, 0))}
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
