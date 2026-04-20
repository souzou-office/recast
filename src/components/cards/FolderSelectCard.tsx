"use client";

import type { FolderSelectCard, ActionCard } from "@/types";
import { Icon } from "@/components/ui/Icon";

interface Props {
  card: FolderSelectCard;
  onAction: (data: Partial<ActionCard>) => void;
}

export default function FolderSelectCardUI({ card, onAction }: Props) {
  const isLocked = !!card.selectedPath;

  return (
    <div className="mt-4 rounded-2xl border p-1.5 border-[var(--color-border)] bg-[var(--color-panel)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="px-3 py-2 flex items-center gap-2">
        <Icon name="Folder" size={13} className="text-[var(--color-fg-muted)]" />
        <span className="text-[11.5px] font-medium text-[var(--color-fg-muted)]">案件フォルダ</span>
      </div>
      <div className="space-y-0.5">
        {card.folders.map(f => {
          const selected = card.selectedPath === f.path;
          return (
            <button
              key={f.path}
              onClick={() => !isLocked && onAction({ selectedPath: f.path } as Partial<ActionCard>)}
              disabled={isLocked && !selected}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                selected
                  ? "bg-[var(--color-accent-soft)]"
                  : isLocked
                    ? "opacity-50"
                    : "hover:bg-[var(--color-hover)]"
              }`}
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                selected ? "bg-[var(--color-accent-soft)]" : "bg-[var(--color-hover)]"
              }`}>
                <Icon
                  name={selected ? "FolderOpen" : "Folder"}
                  size={15}
                  className={selected ? "text-[var(--color-accent)]" : "text-[var(--color-fg-muted)]"}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-[13px] truncate ${selected ? "font-medium text-[var(--color-accent-fg)]" : "text-[var(--color-fg)]"}`}>
                  {f.name}
                </div>
                <div className="text-[10.5px] mt-0.5 text-[var(--color-fg-subtle)]">
                  {f.fileCount}ファイル
                </div>
              </div>
              {selected && (
                <div className="w-5 h-5 rounded-full bg-[var(--color-accent)] flex items-center justify-center shrink-0">
                  <Icon name="Check" size={11} className="text-white" />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
