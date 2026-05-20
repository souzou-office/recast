"use client";

import { useEffect, useState } from "react";
import type { Company } from "@/types";

interface Props {
  company: Company;
  onClose: () => void;
  onSaved?: () => void;
}

interface FileRow {
  path: string;
  name: string;
  folder: string; // サブフォルダ名（表示用）
}

export default function ProfileSourceModal({ company, onClose, onSaved }: Props) {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/workspace/profile/sources?companyId=${encodeURIComponent(company.id)}`);
        const data = await res.json();
        const rows: FileRow[] = data.files || [];
        setFiles(rows);
        const savedSelected: string[] = data.selected || [];
        const initial = savedSelected.length > 0
          ? new Set(savedSelected)
          : new Set(rows.map(r => r.path));
        setSelected(initial);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, [company]);

  const toggle = (path: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const allToggle = () => {
    if (selected.size === files.length) setSelected(new Set());
    else setSelected(new Set(files.map(f => f.path)));
  };

  const save = async () => {
    setSaving(true);
    // 全選択 = 未設定扱い（後で追加されたファイルも自動で対象に）
    const paths = selected.size === files.length ? [] : Array.from(selected);
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setProfileSources", companyId: company.id, paths }),
    });
    setSaving(false);
    onSaved?.();
    onClose();
  };

  // フォルダごとにグループ
  const grouped: Record<string, FileRow[]> = {};
  for (const f of files) {
    if (!grouped[f.folder]) grouped[f.folder] = [];
    grouped[f.folder].push(f);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-[560px] max-h-[80vh] rounded-lg bg-[var(--color-panel)] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="border-b border-[var(--color-border)] px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-medium">基本情報の参照ファイル</h3>
          <button onClick={onClose} className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)] text-xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 text-xs">
          {loading ? (
            <p className="text-[var(--color-fg-muted)]">読込中...</p>
          ) : files.length === 0 ? (
            <p className="text-[var(--color-fg-muted)]">共通フォルダにファイルがありません</p>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                <button onClick={allToggle} className="text-[var(--color-accent)] hover:underline">
                  {selected.size === files.length ? "全解除" : "全選択"}
                </button>
                <span className="text-[var(--color-fg-subtle)]">{selected.size} / {files.length} 選択中</span>
              </div>
              {Object.entries(grouped).map(([folder, rows]) => {
                const folderPaths = rows.map(r => r.path);
                const folderSelectedCount = folderPaths.filter(p => selected.has(p)).length;
                const allInFolderSelected = folderSelectedCount === folderPaths.length;
                const someInFolderSelected = folderSelectedCount > 0 && !allInFolderSelected;
                const toggleFolder = () => {
                  setSelected(prev => {
                    const next = new Set(prev);
                    if (allInFolderSelected) {
                      // 全選択中 → 全解除
                      for (const p of folderPaths) next.delete(p);
                    } else {
                      // 一部 or 未選択 → 全選択
                      for (const p of folderPaths) next.add(p);
                    }
                    return next;
                  });
                };
                return (
                  <div key={folder} className="mb-3">
                    <label className="flex items-center gap-2 cursor-pointer mb-1 hover:bg-[var(--color-hover)] px-1 py-0.5 rounded">
                      <input
                        type="checkbox"
                        checked={allInFolderSelected}
                        ref={el => { if (el) el.indeterminate = someInFolderSelected; }}
                        onChange={toggleFolder}
                        className="w-3.5 h-3.5"
                      />
                      <span className="text-[10px] font-medium text-[var(--color-fg-muted)]">📁 {folder}</span>
                      <span className="text-[10px] text-[var(--color-fg-subtle)]">({folderSelectedCount}/{folderPaths.length})</span>
                    </label>
                    <div className="space-y-0.5 ml-6">
                      {rows.map(r => (
                        <label key={r.path} className="flex items-center gap-2 cursor-pointer hover:bg-[var(--color-hover)] px-1 py-0.5 rounded">
                          <input
                            type="checkbox"
                            checked={selected.has(r.path)}
                            onChange={() => toggle(r.path)}
                            className="w-3.5 h-3.5"
                          />
                          <span className="truncate">{r.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
        <div className="border-t border-[var(--color-border)] px-4 py-3 flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-[var(--color-border)] px-4 py-1.5 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]">
            キャンセル
          </button>
          <button
            onClick={save}
            disabled={saving || loading}
            className="rounded-lg bg-[var(--color-fg)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:bg-gray-300"
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
