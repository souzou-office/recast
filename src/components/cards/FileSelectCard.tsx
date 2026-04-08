"use client";

import { useState } from "react";
import type { FileSelectCard, ActionCard } from "@/types";

interface Props {
  card: FileSelectCard;
  onAction: (data: Partial<ActionCard>) => void;
}

export default function FileSelectCardUI({ card, onAction }: Props) {
  const [files, setFiles] = useState(card.files);
  const isLocked = !!card.confirmed;

  const toggle = (index: number) => {
    if (isLocked) return;
    const updated = [...files];
    updated[index] = { ...updated[index], enabled: !updated[index].enabled };
    setFiles(updated);
  };

  const confirm = () => {
    onAction({ files, confirmed: true } as Partial<ActionCard>);
  };

  return (
    <div className={`rounded-lg border p-3 ${isLocked ? "bg-gray-50 border-gray-200" : "border-blue-200 bg-blue-50"}`}>
      <p className="text-xs font-medium text-gray-600 mb-2">使用するファイルを確認してください</p>
      <div className="space-y-0.5 max-h-64 overflow-y-auto mb-2">
        {files.map((f, i) => {
          const isFolder = f.name.startsWith("📁");
          if (isFolder) {
            return (
              <div key={f.path} className="text-xs font-medium text-gray-600 mt-2 first:mt-0 px-1">
                {f.name}
              </div>
            );
          }
          return (
            <label key={f.path} className="flex items-center gap-2 rounded px-2 py-0.5 hover:bg-white cursor-pointer">
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
