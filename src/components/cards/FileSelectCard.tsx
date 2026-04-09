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
            // このフォルダのパス配下にある全ファイル（フォルダ以外）を取得
            const childIndices: number[] = [];
            for (let j = i + 1; j < files.length; j++) {
              if (files[j].name.startsWith("📁") && !files[j].path.startsWith(f.path)) break;
              if (!files[j].name.startsWith("📁")) childIndices.push(j);
            }
            const hasChildren = childIndices.length > 0;
            const allEnabled = hasChildren && childIndices.every(j => files[j].enabled);
            const noneEnabled = hasChildren && childIndices.every(j => !files[j].enabled);
            return (
              <label key={f.path} className="flex items-center gap-2 mt-2 first:mt-0 px-1 cursor-pointer hover:bg-white rounded">
                <input
                  type="checkbox"
                  checked={allEnabled}
                  ref={el => { if (el) el.indeterminate = hasChildren && !allEnabled && !noneEnabled; }}
                  onChange={() => {
                    if (isLocked) return;
                    const newEnabled = !allEnabled;
                    const updated = [...files];
                    for (const j of childIndices) updated[j] = { ...updated[j], enabled: newEnabled };
                    setFiles(updated);
                  }}
                  disabled={isLocked || !hasChildren}
                  className="w-3.5 h-3.5"
                />
                <span className="text-xs font-medium text-gray-600">{f.name}</span>
              </label>
            );
          }
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
        <div className="flex gap-2">
          <button
            onClick={confirm}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            これで進める
          </button>
        </div>
      )}
    </div>
  );
}
