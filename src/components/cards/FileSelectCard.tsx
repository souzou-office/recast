"use client";

import { useState } from "react";
import type { FileSelectCard, ActionCard } from "@/types";
import { Icon } from "@/components/ui/Icon";

interface Props {
  card: FileSelectCard;
  onAction: (data: Partial<ActionCard>) => void;
  onPreview?: (file: { filePath?: string; fileName: string }) => void;
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

export default function FileSelectCardUI({ card, onAction, onPreview }: Props) {
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
          <div className="flex items-center gap-2.5 rounded-xl hover:bg-[var(--color-hover)] px-3 py-2">
            <input
              type="checkbox"
              checked={allEnabled}
              ref={el => { if (el) el.indeterminate = hasFiles && !allEnabled && !noneEnabled; }}
              onChange={() => toggleFolderFiles(node)}
              disabled={isLocked || !hasFiles}
              className="w-4 h-4 shrink-0"
            />
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFolder(node.path); }}
              type="button"
              className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--color-fg)] hover:text-[var(--color-accent-fg)] cursor-pointer"
            >
              <Icon name={isOpen ? "ChevronDown" : "ChevronRight"} size={13} className="text-[var(--color-fg-subtle)]" />
              <Icon name={isOpen ? "FolderOpen" : "Folder"} size={15} className="text-[var(--color-fg-muted)]" />
              <span>{node.name}</span>
              <span className="text-[10.5px] text-[var(--color-fg-subtle)]">({childFileIndices.length})</span>
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
    const ext = node.name.split(".").pop()?.toLowerCase() || "";
    const fileIcon: "FileType" | "FileSpreadsheet" | "FileText" | "File" =
      ext === "pdf" ? "FileType" :
      ["xlsx", "xls", "xlsm", "csv"].includes(ext) ? "FileSpreadsheet" :
      ["doc", "docx"].includes(ext) ? "FileText" : "File";
    return (
      <label key={node.path} className="flex items-center gap-2.5 rounded-xl px-3 py-1.5 hover:bg-[var(--color-hover)] cursor-pointer" style={{ marginLeft: depth * 16 }}>
        <input
          type="checkbox"
          checked={files[node.fileIndex].enabled}
          onChange={() => toggle(node.fileIndex)}
          disabled={isLocked}
          className="w-4 h-4"
        />
        <Icon name={fileIcon} size={14} className="text-[var(--color-fg-muted)] shrink-0" />
        <span className={`text-[13px] flex-1 ${files[node.fileIndex].enabled ? "text-[var(--color-fg)]" : "text-[var(--color-fg-subtle)] line-through"}`}>{node.name}</span>
      {onPreview && (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPreview({ filePath: node.path, fileName: node.name }); }}
          className="text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] shrink-0 ml-1"
          title="プレビュー"
        ><Icon name="Eye" size={13} /></button>
      )}
      </label>
    );
  };

  return (
    <div className="mt-4 rounded-2xl border p-1.5 border-[var(--color-border)] bg-[var(--color-panel)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="px-3 py-2 flex items-center gap-2">
        <Icon name="FileText" size={13} className="text-[var(--color-fg-muted)]" />
        <span className="text-[11.5px] font-medium text-[var(--color-fg-muted)]">使用するファイル</span>
      </div>
      <div className="max-h-80 overflow-y-auto space-y-0.5">
        {tree.map(node => renderNode(node, 0))}
      </div>
      {!isLocked && (
        <div className="flex items-center pt-2.5 mt-2 border-t border-[var(--color-border-soft)] px-2">
          <button
            onClick={confirm}
            className="h-9 px-4 rounded-full text-[12.5px] font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-fg)]"
          >
            これで進める
          </button>
        </div>
      )}
    </div>
  );
}
