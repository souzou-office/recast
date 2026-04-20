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
    <div className={`rounded-2xl border p-4 ${isLocked ? "bg-[var(--color-hover)] border-[var(--color-border)]" : "border-[var(--color-accent-soft)] bg-[var(--color-accent-soft)]"}`}>
      <p className="text-xs font-medium text-[var(--color-fg-muted)] mb-2">案件フォルダを選んでください</p>
      <div className="space-y-1">
        {card.folders.map(f => (
          <button
            key={f.path}
            onClick={() => !isLocked && onAction({ selectedPath: f.path } as Partial<ActionCard>)}
            disabled={isLocked}
            className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-left transition-colors ${
              card.selectedPath === f.path
                ? "bg-[var(--color-panel)] text-[var(--color-accent-fg)] border border-[var(--color-accent)]/30"
                : isLocked
                  ? "text-[var(--color-fg-subtle)]"
                  : "hover:bg-[var(--color-panel)] text-[var(--color-fg)]"
            }`}
          >
            <Icon name={card.selectedPath === f.path ? "FolderOpen" : "Folder"} size={13} className="text-[var(--color-fg-muted)] shrink-0" />
            <span className="flex-1 truncate">{f.name}</span>
            <span className="text-[10px] text-[var(--color-fg-subtle)]">{f.fileCount}ファイル</span>
          </button>
        ))}
      </div>
    </div>
  );
}
