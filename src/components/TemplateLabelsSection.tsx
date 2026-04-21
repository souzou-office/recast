"use client";

import { useState, useEffect, useCallback } from "react";
import { Icon } from "./ui/Icon";

interface Slot {
  slotId: number;
  oldValue: string;
  label: string;
  format: string;
  sourceHint?: string;
}

interface TemplateLabels {
  templateHash: string;
  generatedAt: string;
  slots: Slot[];
}

interface FolderFile {
  name: string;
  path: string;
  hasLabels: boolean;
  slotCount: number;
  generatedAt: string | null;
}

interface FolderEntry {
  name: string;
  path: string;
  files: FolderFile[];
}

// 1テンプレの詳細パネル: スロット一覧を表示、各スロットを編集可能
function TemplateDetail({ templatePath, onClose, onUpdated }: {
  templatePath: string;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [labels, setLabels] = useState<TemplateLabels | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<{ label: string; format: string; sourceHint: string }>({ label: "", format: "", sourceHint: "" });

  const fetchLabels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/template-labels?templatePath=${encodeURIComponent(templatePath)}`);
      if (res.ok) {
        const data = await res.json();
        setLabels(data);
      } else {
        setLabels(null);
      }
    } catch {
      setLabels(null);
    }
    setLoading(false);
  }, [templatePath]);

  useEffect(() => { fetchLabels(); }, [fetchLabels]);

  const handleRegenerate = async () => {
    if (!confirm("このテンプレのラベルを AI で再解析します（数秒かかります）。続行しますか？")) return;
    setRegenerating(true);
    try {
      const res = await fetch("/api/template-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templatePath, action: "regenerate" }),
      });
      if (res.ok) {
        const data = await res.json();
        setLabels(data);
        onUpdated();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(`再解析失敗: ${err.error || "不明なエラー"}`);
      }
    } catch (e) {
      alert(`再解析失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
    setRegenerating(false);
  };

  const startEdit = (slot: Slot) => {
    setEditingSlot(slot.slotId);
    setEditDraft({ label: slot.label, format: slot.format, sourceHint: slot.sourceHint || "" });
  };

  const saveEdit = async (slotId: number) => {
    try {
      const res = await fetch("/api/template-labels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templatePath, slotId, ...editDraft }),
      });
      if (res.ok) {
        setEditingSlot(null);
        await fetchLabels();
        onUpdated();
      } else {
        alert("保存に失敗しました");
      }
    } catch (e) {
      alert(`保存失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const fileName = templatePath.split(/[\\/]/).pop() || templatePath;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-hover)]">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={onClose} className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] shrink-0">
            <Icon name="ChevronLeft" size={16} />
          </button>
          <span className="text-sm font-medium truncate">{fileName}</span>
          {labels && (
            <span className="text-[10px] text-[var(--color-fg-subtle)] shrink-0">
              {labels.slots.length} スロット / 最終解析 {new Date(labels.generatedAt).toLocaleString("ja-JP")}
            </span>
          )}
        </div>
        <button
          onClick={handleRegenerate}
          disabled={regenerating}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-fg)] px-3 py-1 text-[10px] font-medium text-[var(--color-bg)] hover:opacity-90 disabled:opacity-50"
        >
          <Icon name="RefreshCcw" size={11} /> {regenerating ? "再解析中..." : "再解析"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 bg-[var(--color-bg)]">
        {loading ? (
          <p className="text-sm text-[var(--color-fg-subtle)] animate-pulse">読み込み中...</p>
        ) : !labels ? (
          <p className="text-sm text-[var(--color-fg-subtle)]">ラベル未生成。「再解析」を押すと AI が生成します。</p>
        ) : labels.slots.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-subtle)]">スロットがありません。</p>
        ) : (
          <div className="space-y-2">
            {labels.slots.map(slot => (
              <div key={slot.slotId} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-mono text-[var(--color-fg-subtle)] rounded bg-[var(--color-hover)] px-1.5 py-0.5">slot {slot.slotId}</span>
                  {editingSlot !== slot.slotId && (
                    <button
                      onClick={() => startEdit(slot)}
                      className="ml-auto text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] inline-flex items-center gap-1"
                    >
                      <Icon name="Pencil" size={10} /> 編集
                    </button>
                  )}
                </div>
                {editingSlot === slot.slotId ? (
                  <div className="space-y-2">
                    <div>
                      <div className="text-[10px] text-[var(--color-fg-subtle)] mb-0.5">ラベル</div>
                      <input
                        type="text"
                        value={editDraft.label}
                        onChange={(e) => setEditDraft({ ...editDraft, label: e.target.value })}
                        className="w-full text-[12px] px-2 py-1 border border-[var(--color-border)] rounded bg-[var(--color-bg)]"
                      />
                    </div>
                    <div>
                      <div className="text-[10px] text-[var(--color-fg-subtle)] mb-0.5">形式</div>
                      <input
                        type="text"
                        value={editDraft.format}
                        onChange={(e) => setEditDraft({ ...editDraft, format: e.target.value })}
                        className="w-full text-[12px] px-2 py-1 border border-[var(--color-border)] rounded bg-[var(--color-bg)]"
                      />
                    </div>
                    <div>
                      <div className="text-[10px] text-[var(--color-fg-subtle)] mb-0.5">出典ヒント</div>
                      <input
                        type="text"
                        value={editDraft.sourceHint}
                        onChange={(e) => setEditDraft({ ...editDraft, sourceHint: e.target.value })}
                        className="w-full text-[12px] px-2 py-1 border border-[var(--color-border)] rounded bg-[var(--color-bg)]"
                      />
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => saveEdit(slot.slotId)}
                        className="rounded-full bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => setEditingSlot(null)}
                        className="rounded-full bg-[var(--color-hover)] px-3 py-1 text-[11px] text-[var(--color-fg-muted)]"
                      >
                        キャンセル
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1 text-[12px]">
                    <div className="flex gap-2">
                      <span className="text-[var(--color-fg-subtle)] w-16 shrink-0">ラベル</span>
                      <span className="font-medium text-[var(--color-fg)]">{slot.label || <em className="text-[var(--color-fg-subtle)]">（未設定）</em>}</span>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-[var(--color-fg-subtle)] w-16 shrink-0">形式</span>
                      <span className="font-mono text-[var(--color-fg-muted)]">{slot.format || <em>—</em>}</span>
                    </div>
                    {slot.sourceHint && (
                      <div className="flex gap-2">
                        <span className="text-[var(--color-fg-subtle)] w-16 shrink-0">出典</span>
                        <span className="text-[var(--color-fg-muted)]">{slot.sourceHint}</span>
                      </div>
                    )}
                    <div className="flex gap-2 border-t border-[var(--color-border-soft)] pt-1.5 mt-1.5">
                      <span className="text-[var(--color-fg-subtle)] w-16 shrink-0">原文</span>
                      <span className="text-[var(--color-fg-muted)] whitespace-pre-wrap break-words">{slot.oldValue || <em>—</em>}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TemplateLabelsSection() {
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regeneratingFolder, setRegeneratingFolder] = useState<string | null>(null);

  const fetchFolders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/template-labels");
      const data = await res.json();
      if (data.error) setError(data.error);
      setFolders(data.folders || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchFolders(); }, [fetchFolders]);

  const handleRegenerateFolder = async (folderPath: string, folderName: string) => {
    if (!confirm(`フォルダ「${folderName}」内の全テンプレを AI で再解析します。ファイル数によっては数十秒かかります。続行しますか？`)) return;
    setRegeneratingFolder(folderPath);
    try {
      const res = await fetch("/api/template-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath, action: "regenerate-folder" }),
      });
      if (res.ok) {
        const data = await res.json();
        alert(`完了: ${data.succeeded} / ${data.total} 件 成功`);
        await fetchFolders();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(`再解析失敗: ${err.error || "不明なエラー"}`);
      }
    } catch (e) {
      alert(`再解析失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
    setRegeneratingFolder(null);
  };

  if (selectedPath) {
    return (
      <TemplateDetail
        templatePath={selectedPath}
        onClose={() => setSelectedPath(null)}
        onUpdated={fetchFolders}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <h2 className="text-sm font-semibold">テンプレート解釈</h2>
        <p className="text-[11px] text-[var(--color-fg-subtle)] mt-1">
          各テンプレートのプレースホルダー / ハイライトに付けられたラベル（意味）を確認・編集できます。
          recast が書類生成時に参照する「マスターデータ」です。
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 bg-[var(--color-bg)]">
        {loading ? (
          <p className="text-sm text-[var(--color-fg-subtle)] animate-pulse">読み込み中...</p>
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : folders.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-subtle)]">テンプレートフォルダが見つかりません。</p>
        ) : (
          <div className="space-y-4">
            {folders.map(folder => (
              <div key={folder.path}>
                <div className="text-[11px] font-semibold text-[var(--color-fg-muted)] mb-1.5 px-1 flex items-center gap-1.5">
                  <Icon name="Folder" size={12} /> {folder.name}
                  <span className="text-[var(--color-fg-subtle)] font-normal">
                    （{folder.files.length} ファイル、{folder.files.filter(f => f.hasLabels).length} 解析済み）
                  </span>
                  <button
                    onClick={() => handleRegenerateFolder(folder.path, folder.name)}
                    disabled={regeneratingFolder !== null}
                    className="ml-auto inline-flex items-center gap-1 rounded-full bg-[var(--color-hover)] px-2.5 py-0.5 text-[10px] font-normal text-[var(--color-fg-muted)] hover:bg-[var(--color-fg)] hover:text-[var(--color-bg)] disabled:opacity-50 transition-colors"
                    title="フォルダ内の全テンプレを再解析"
                  >
                    <Icon name="RefreshCcw" size={10} />
                    {regeneratingFolder === folder.path ? "再解析中..." : "一括再解析"}
                  </button>
                </div>
                <div className="space-y-1">
                  {folder.files.map(f => {
                    const isExcel = /\.(xlsx|xlsm|xls)$/i.test(f.name);
                    return (
                      <button
                        key={f.path}
                        onClick={() => setSelectedPath(f.path)}
                        className="w-full flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 hover:bg-[var(--color-hover)] transition-colors text-left"
                      >
                        <Icon name={isExcel ? "FileSpreadsheet" : "FileText"} size={14} className="text-[var(--color-fg-subtle)] shrink-0" />
                        <span className="flex-1 text-[13px] text-[var(--color-fg)] truncate">{f.name}</span>
                        {f.hasLabels ? (
                          <span className="text-[10px] text-[var(--color-ok-fg)] inline-flex items-center gap-1 shrink-0">
                            <Icon name="CheckCircle2" size={10} /> {f.slotCount} スロット
                          </span>
                        ) : (
                          <span className="text-[10px] text-[var(--color-warn-fg)] inline-flex items-center gap-1 shrink-0">
                            <Icon name="AlertCircle" size={10} /> 未解析
                          </span>
                        )}
                        <Icon name="ChevronRight" size={14} className="text-[var(--color-fg-subtle)] shrink-0" />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
