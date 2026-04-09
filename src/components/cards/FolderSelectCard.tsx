"use client";

import type { FolderSelectCard, ActionCard } from "@/types";

interface Props {
  card: FolderSelectCard;
  onAction: (data: Partial<ActionCard>) => void;
}

export default function FolderSelectCardUI({ card, onAction }: Props) {
  const isLocked = !!card.selectedPath;

  return (
    <div className={`rounded-lg border p-3 ${isLocked ? "bg-gray-50 border-gray-200" : "border-blue-200 bg-blue-50"}`}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-gray-600">案件フォルダを選んでください</p>
        {isLocked && (
          <button
            onClick={() => onAction({ selectedPath: undefined } as Partial<ActionCard>)}
            className="text-[10px] text-blue-500 hover:text-blue-700"
          >
            ← 選び直す
          </button>
        )}
      </div>
      <div className="space-y-1">
        {card.folders.map(f => (
          <button
            key={f.path}
            onClick={() => !isLocked && onAction({ selectedPath: f.path } as Partial<ActionCard>)}
            disabled={isLocked}
            className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-left transition-colors ${
              card.selectedPath === f.path
                ? "bg-blue-100 text-blue-700 border border-blue-300"
                : isLocked
                  ? "text-gray-400"
                  : "hover:bg-white text-gray-700"
            }`}
          >
            <span>📁</span>
            <span className="flex-1 truncate">{f.name}</span>
            <span className="text-[10px] text-gray-400">{f.fileCount}ファイル</span>
          </button>
        ))}
      </div>
    </div>
  );
}
