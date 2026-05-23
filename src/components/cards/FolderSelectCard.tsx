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
  // 案件フォルダとして明示的にマークされたパス（カード下部の「決定」ボタンで使う）。
  // 複数フォルダにまたがってファイルを選ぶことを許すが、「案件の本拠地」だけは1つ決める必要がある。
  const [activeFolder, setActiveFolder] = useState<string | null>(null);

  const toggleOpen = async (folderPath: string) => {
    // すでに開かれている → 閉じる
    if (folderPath in openMap) {
      setOpenMap(prev => {
        const next = { ...prev };
        delete next[folderPath];
        return next;
      });
      if (activeFolder === folderPath) setActiveFolder(null);
      return;
    }
    // 未取得 → API 叩いて取得 + active にする
    setOpenMap(prev => ({ ...prev, [folderPath]: null }));
    setActiveFolder(folderPath);
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
    let turnedOn = false;
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
        turnedOn = true;
      }
      return next;
    });
    // ON にした時だけ、案件フォルダ未指定なら自動で所属トップレベルフォルダを active に。
    // 「フォルダを閉じた後にファイルだけチェックしてボタンが disabled」を防ぐ。
    if (turnedOn && !activeFolder) {
      const top = card.folders.find(f => filePath.startsWith(f.path + "\\") || filePath.startsWith(f.path + "/"));
      if (top) setActiveFolder(top.path);
    }
  };

  // フォルダの三状態 (直下ファイルのみ評価、シンプル化)
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
    const turningOn = state !== "all";
    setChecked(prev => {
      const next = new Set(prev);
      if (state === "all") {
        for (const f of data.files) next.delete(f.path);
      } else {
        for (const f of data.files) next.add(f.path);
      }
      return next;
    });
    // ON にした時、案件フォルダ未指定なら自動でトップレベルフォルダを active に。
    // サブフォルダのチェックボックスを ON にしただけで「進む」ボタンが押せるようにする。
    if (turningOn && !activeFolder) {
      const top = card.folders.find(f => folderPath === f.path || folderPath.startsWith(f.path + "\\") || folderPath.startsWith(f.path + "/"));
      if (top) setActiveFolder(top.path);
    }
  };

  // checked に入ってるファイルから所属トップレベルフォルダを推定するヘルパー
  const inferActiveFromChecked = (): string | null => {
    for (const filePath of checked) {
      const top = card.folders.find(f => filePath.startsWith(f.path + "\\") || filePath.startsWith(f.path + "/"));
      if (top) return top.path;
    }
    return null;
  };

  const handleConfirm = () => {
    // activeFolder が無くても checked に1個でも入ってれば、所属トップフォルダから推定して進む
    const finalActive = activeFolder || inferActiveFromChecked();
    if (!finalActive) return;
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
          disabled.push(sf.path);
        }
      }
    }
    onAction({ selectedPath: finalActive, disabledFiles: disabled } as unknown as Partial<ActionCard>);
  };

  const activeFolderName = activeFolder
    ? card.folders.find(f => f.path === activeFolder)?.name || ""
    : "";

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
          const isActive = activeFolder === f.path;
          return (
            <div key={f.path}>
              <div
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${
                  selected || isActive
                    ? "bg-[var(--color-accent-soft)]"
                    : isLocked
                      ? "opacity-50"
                      : "hover:bg-[var(--color-hover)] cursor-pointer"
                }`}
                onClick={() => !isLocked && toggleOpen(f.path)}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                  selected || isActive ? "bg-[var(--color-accent-soft)]" : "bg-[var(--color-hover)]"
                }`}>
                  <Icon
                    name={isOpen || selected ? "FolderOpen" : "Folder"}
                    size={15}
                    className={selected || isActive ? "text-[var(--color-accent)]" : "text-[var(--color-fg-muted)]"}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-[13px] truncate ${selected || isActive ? "font-medium text-[var(--color-accent-fg)]" : "text-[var(--color-fg)]"}`}>
                    {f.name}
                  </div>
                </div>
                {isActive && !isLocked && (
                  <span className="shrink-0 text-[10px] text-[var(--color-accent-fg)] bg-white/60 rounded-full px-2 py-0.5">
                    案件フォルダ
                  </span>
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

      {/* カード下部の決定ボタン。activeFolder か checked が1個でもあれば押せる。 */}
      {!isLocked && (() => {
        const canProceed = !!activeFolder || checked.size > 0;
        const displayFolder = activeFolderName || (activeFolder ? activeFolder.split(/[\\/]/).pop() : "");
        return (
          <div className="border-t border-[var(--color-border-soft)] mt-1 pt-2 pb-1 px-2 flex items-center justify-between gap-3">
            <span className="text-[11px] text-[var(--color-fg-subtle)]">
              {canProceed
                ? `${displayFolder ? `案件フォルダ: ${displayFolder} / ` : ""}${checked.size}ファイル選択中`
                : "フォルダを開いて、使うファイルにチェックを入れてください"}
            </span>
            <button
              onClick={handleConfirm}
              disabled={!canProceed}
              className="shrink-0 rounded-full bg-[var(--color-fg)] px-4 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              この内容で進む
            </button>
          </div>
        );
      })()}
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
