"use client";

import { useState } from "react";
import type { FolderSelectCard, ActionCard } from "@/types";
import { Icon } from "@/components/ui/Icon";

interface Props {
  card: FolderSelectCard;
  onAction: (data: Partial<ActionCard>) => void;
}

interface LiveEntry {
  name: string;
  path: string;
}
interface LiveFolderData {
  files: LiveEntry[];
  subfolders: LiveEntry[];
}

function fileIconName(name: string): "FileType" | "FileText" | "FileSpreadsheet" | "Image" | "Paperclip" {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return "FileType";
  if (["doc", "docx", "docm"].includes(ext)) return "FileText";
  if (["xls", "xlsx", "xlsm", "csv"].includes(ext)) return "FileSpreadsheet";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "Image";
  return "Paperclip";
}

// 三状態チェックボックス: チェック ON / チェック OFF / 一部チェック (indeterminate)
function TriCheckbox({ state, onClick }: { state: "all" | "some" | "none"; onClick: (e: React.MouseEvent) => void }) {
  return (
    <input
      type="checkbox"
      checked={state === "all"}
      ref={el => { if (el) el.indeterminate = state === "some"; }}
      onChange={() => { /* onClick で処理 */ }}
      onClick={onClick}
      className="shrink-0 w-3.5 h-3.5 cursor-pointer"
    />
  );
}

export default function FolderSelectCardUI({ card, onAction }: Props) {
  const isLocked = !!card.selectedPath;
  // 開かれているフォルダごとに中身（ファイル + サブフォルダ）をキャッシュ
  const [openMap, setOpenMap] = useState<Record<string, LiveFolderData | null>>({});
  // 「使うファイル」をローカルで管理（デフォルトは何もチェックされていない）
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const toggleOpen = async (folderPath: string) => {
    // すでに開かれている → 閉じる
    if (folderPath in openMap) {
      setOpenMap(prev => {
        const next = { ...prev };
        delete next[folderPath];
        return next;
      });
      return;
    }
    // 未取得 → API 叩いて取得
    setOpenMap(prev => ({ ...prev, [folderPath]: null }));
    try {
      const res = await fetch("/api/workspace/list-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: folderPath }),
      });
      const data = await res.json();
      setOpenMap(prev => ({
        ...prev,
        [folderPath]: {
          files: data.files || [],
          subfolders: data.subfolders || [],
        },
      }));
    } catch {
      setOpenMap(prev => {
        const next = { ...prev };
        delete next[folderPath];
        return next;
      });
    }
  };

  const toggleFileCheck = (filePath: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  // フォルダの三状態 (直下ファイルのみ評価。サブフォルダ配下は再帰的には見ない、シンプル化)
  const folderCheckState = (folderPath: string): "all" | "some" | "none" => {
    const data = openMap[folderPath];
    if (!data || data.files.length === 0) return "none";
    let onCount = 0;
    for (const f of data.files) {
      if (checked.has(f.path)) onCount++;
    }
    if (onCount === 0) return "none";
    if (onCount === data.files.length) return "all";
    return "some";
  };

  const toggleFolderCheck = (folderPath: string) => {
    const data = openMap[folderPath];
    if (!data) return;
    const state = folderCheckState(folderPath);
    setChecked(prev => {
      const next = new Set(prev);
      if (state === "all") {
        // 全部 ON → 全部 OFF
        for (const f of data.files) next.delete(f.path);
      } else {
        // none or some → all
        for (const f of data.files) next.add(f.path);
      }
      return next;
    });
  };

  const handleConfirm = (folder: { path: string; name: string }) => {
    // disabledFiles = 「使わない」もの。
    // 展開済みフォルダ配下のファイルで checked じゃないもの + 展開してないサブフォルダ全部。
    const disabled: string[] = [];
    for (const [folderPath, data] of Object.entries(openMap)) {
      if (!data) continue;
      for (const f of data.files) {
        if (!checked.has(f.path)) disabled.push(f.path);
      }
      for (const sf of data.subfolders) {
        if (!(sf.path in openMap)) {
          // 展開してない = 中身知らない = 使わない（フォルダごと disabled）
          disabled.push(sf.path);
        }
      }
    }
    onAction({ selectedPath: folder.path, disabledFiles: disabled } as unknown as Partial<ActionCard>);
  };

  return (
    <div className="mt-4 rounded-2xl border p-1.5 border-[var(--color-border)] bg-[var(--color-panel)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="px-3 py-2 flex items-center gap-2">
        <Icon name="Folder" size={13} className="text-[var(--color-fg-muted)]" />
        <span className="text-[11.5px] font-medium text-[var(--color-fg-muted)]">案件フォルダ（クリックで開いて、使うファイルにチェック）</span>
      </div>
      <div className="space-y-0.5">
        {card.folders.map(f => {
          const selected = card.selectedPath === f.path;
          const isOpen = f.path in openMap;
          const data = openMap[f.path];
          return (
            <div key={f.path}>
              <div
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${
                  selected
                    ? "bg-[var(--color-accent-soft)]"
                    : isLocked
                      ? "opacity-50"
                      : "hover:bg-[var(--color-hover)] cursor-pointer"
                }`}
                onClick={() => !isLocked && toggleOpen(f.path)}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                  selected ? "bg-[var(--color-accent-soft)]" : "bg-[var(--color-hover)]"
                }`}>
                  <Icon
                    name={isOpen || selected ? "FolderOpen" : "Folder"}
                    size={15}
                    className={selected ? "text-[var(--color-accent)]" : "text-[var(--color-fg-muted)]"}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-[13px] truncate ${selected ? "font-medium text-[var(--color-accent-fg)]" : "text-[var(--color-fg)]"}`}>
                    {f.name}
                  </div>
                </div>
                {!isLocked && isOpen && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleConfirm(f); }}
                    className="shrink-0 rounded-full bg-[var(--color-fg)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90"
                  >
                    このフォルダで進む
                  </button>
                )}
                {selected && (
                  <div className="w-5 h-5 rounded-full bg-[var(--color-accent)] flex items-center justify-center shrink-0">
                    <Icon name="Check" size={11} className="text-white" />
                  </div>
                )}
              </div>

              {/* accordion 展開: フォルダの中身 */}
              {isOpen && !isLocked && (
                <div className="ml-12 mr-2 mb-2 mt-1 border-l border-[var(--color-border-soft)] pl-3">
                  {data === null ? (
                    <p className="text-[11px] py-1 text-[var(--color-fg-subtle)]">読み込み中...</p>
                  ) : (
                    <FolderContents
                      data={data}
                      checked={checked}
                      onToggleFile={toggleFileCheck}
                      onOpenFolder={toggleOpen}
                      openMap={openMap}
                      folderCheckState={folderCheckState}
                      onToggleFolderCheck={toggleFolderCheck}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 再帰的に中身を出すコンポーネント。サブフォルダもクリックで展開できる。
function FolderContents({
  data,
  checked,
  onToggleFile,
  onOpenFolder,
  openMap,
  folderCheckState,
  onToggleFolderCheck,
}: {
  data: LiveFolderData;
  checked: Set<string>;
  onToggleFile: (p: string) => void;
  onOpenFolder: (p: string) => void;
  openMap: Record<string, LiveFolderData | null>;
  folderCheckState: (p: string) => "all" | "some" | "none";
  onToggleFolderCheck: (p: string) => void;
}) {
  if (data.files.length === 0 && data.subfolders.length === 0) {
    return <p className="text-[11px] py-1 text-[var(--color-fg-subtle)]">空のフォルダ</p>;
  }
  return (
    <ul className="space-y-0.5 py-1">
      {data.subfolders.map(sf => {
        const isOpen = sf.path in openMap;
        const subData = openMap[sf.path];
        const subState = isOpen ? folderCheckState(sf.path) : "none";
        return (
          <li key={sf.path}>
            <div className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-[var(--color-hover)]">
              {isOpen ? (
                <TriCheckbox
                  state={subState}
                  onClick={(e) => { e.stopPropagation(); onToggleFolderCheck(sf.path); }}
                />
              ) : (
                <span className="w-3.5 h-3.5 shrink-0" />
              )}
              <button
                onClick={() => onOpenFolder(sf.path)}
                className="flex-1 flex items-center gap-1.5 text-[12px] text-left text-[var(--color-fg-muted)]"
              >
                <Icon name={isOpen ? "ChevronDown" : "ChevronRight"} size={11} />
                <Icon name={isOpen ? "FolderOpen" : "Folder"} size={12} className="text-[var(--color-fg-subtle)]" />
                <span className="truncate">{sf.name}</span>
              </button>
            </div>
            {isOpen && (
              <div className="ml-3 border-l border-[var(--color-border-soft)] pl-2">
                {subData === null
                  ? <p className="text-[10.5px] py-1 text-[var(--color-fg-subtle)]">読み込み中...</p>
                  : (
                    <FolderContents
                      data={subData}
                      checked={checked}
                      onToggleFile={onToggleFile}
                      onOpenFolder={onOpenFolder}
                      openMap={openMap}
                      folderCheckState={folderCheckState}
                      onToggleFolderCheck={onToggleFolderCheck}
                    />
                  )}
              </div>
            )}
          </li>
        );
      })}
      {data.files.map(f => {
        const isChecked = checked.has(f.path);
        return (
          <li key={f.path} className="flex items-center gap-2 py-0.5 pl-1">
            <input
              type="checkbox"
              checked={isChecked}
              onChange={() => onToggleFile(f.path)}
              className="shrink-0 w-3.5 h-3.5 cursor-pointer"
            />
            <Icon name={fileIconName(f.name)} size={12} className="text-[var(--color-fg-subtle)] shrink-0" />
            <span className={`text-[12px] truncate ${isChecked ? "text-[var(--color-fg)]" : "text-[var(--color-fg-subtle)]"}`}>
              {f.name}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
