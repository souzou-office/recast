"use client";

import { useState, useEffect, useCallback } from "react";
import type { DocumentTemplate } from "@/types";

import { Icon } from "./ui/Icon";
interface Props {
  onClose: () => void;
  inline?: boolean;
}

export default function DocumentTemplateModal({ onClose, inline }: Props) {
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingPartIdx, setEditingPartIdx] = useState<number | null>(null);

  // ファイルから雛形生成
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [browseData, setBrowseData] = useState<{ dirs: { name: string; path: string }[]; files?: { name: string; mimeType: string; path?: string }[]; parent: string | null } | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<{ id: string; name: string; mimeType: string }[]>([]);
  const [generating, setGenerating] = useState(false);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch("/api/document-templates");
      if (res.ok) {
        const data = await res.json();
        setTemplates(data.templates);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const selected = templates.find(t => t.id === selectedId);

  // 雛形保存
  const handleSave = async (template: DocumentTemplate) => {
    await fetch("/api/document-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(template),
    });
    await fetchTemplates();
  };

  // 雛形削除
  const handleDelete = async (id: string) => {
    if (!confirm("この書類雛形を削除しますか？")) return;
    await fetch("/api/document-templates", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (selectedId === id) { setSelectedId(null); setEditingPartIdx(null); }
    await fetchTemplates();
  };

  // ファイルからAIで雛形生成
  const handleGenerateFromFiles = async () => {
    if (selectedFiles.length === 0) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/document-templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: selectedFiles }),
      });
      if (res.ok) {
        const { templates: generated } = await res.json();
        for (const t of generated) {
          await fetch("/api/document-templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: t.name, category: "", content: t.content }),
          });
        }
        await fetchTemplates();
        setSelectedFiles([]);
        setShowFilePicker(false);
      }
    } catch { /* ignore */ }
    finally { setGenerating(false); }
  };

  // パーツ追加（ファイルからAI生成）
  const handleAddPartFromFiles = async () => {
    if (!selected || selectedFiles.length === 0) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/document-templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: selectedFiles }),
      });
      if (res.ok) {
        const { templates: generated } = await res.json();
        const parts = [...(selected.parts || [])];
        for (const t of generated) {
          parts.push({ id: `part_${Date.now()}_${Math.random()}`, name: t.name, content: t.content });
        }
        await handleSave({ ...selected, parts });
        setSelectedFiles([]);
        setShowFilePicker(false);
      }
    } catch { /* ignore */ }
    finally { setGenerating(false); }
  };

  const content = (
      <div className={inline ? "w-full h-full flex flex-col" : "w-full max-w-4xl rounded-2xl bg-[var(--color-panel)] shadow-xl flex flex-col"} style={inline ? undefined : { maxHeight: "85vh" }}>
        {/* ヘッダー */}
        <div className="border-b border-[var(--color-border)] px-6 py-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-[var(--color-fg)]">書類雛形管理</h3>
            <p className="text-xs text-[var(--color-fg-muted)] mt-0.5">ファイルからAIが雛形を自動生成します</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowFilePicker(true); setEditingPartIdx(null); }}
              className="rounded-lg bg-[var(--color-fg)] px-3 py-1.5 text-xs text-white hover:opacity-90 transition-colors"
            >
              + ファイルから登録
            </button>
            <button onClick={onClose} className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)] text-lg leading-none">&times;</button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* 左: マスター一覧 */}
          <div className="w-1/4 border-r border-[var(--color-border)] overflow-y-auto">
            {loading ? (
              <p className="p-4 text-sm text-[var(--color-fg-subtle)] text-center">読み込み中...</p>
            ) : templates.length === 0 ? (
              <p className="p-4 text-xs text-[var(--color-fg-subtle)] text-center">「+ ファイルから登録」で<br />雛形を作成してください</p>
            ) : (
              <ul>
                {templates.map(t => (
                  <li key={t.id}>
                    <div
                      onClick={() => { setSelectedId(t.id); setEditingPartIdx(null); }}
                      className={`flex items-center justify-between px-3 py-2.5 border-b border-[var(--color-border-soft)] cursor-pointer hover:bg-[var(--color-hover)] ${
                        selectedId === t.id ? "bg-[var(--color-accent-soft)]" : ""
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-[var(--color-fg)] truncate block">{t.name}</span>
                        {t.parts && t.parts.length > 0 && (
                          <span className="text-[10px] text-[var(--color-fg-subtle)]">{t.parts.length}パーツ</span>
                        )}
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); handleDelete(t.id); }}
                        className="text-[10px] text-red-400 hover:text-red-600 shrink-0 ml-1"
                      >削除</button>
                    </div>
                    {/* パーツ一覧（選択中のマスターのみ） */}
                    {selectedId === t.id && t.parts && t.parts.length > 0 && (
                      <ul className="bg-[var(--color-hover)]">
                        {t.parts.map((p, pi) => (
                          <li
                            key={p.id}
                            onClick={() => setEditingPartIdx(pi)}
                            className={`flex items-center justify-between px-3 py-1.5 pl-6 border-b border-[var(--color-border-soft)] cursor-pointer hover:bg-[var(--color-hover)] text-xs ${
                              editingPartIdx === pi ? "bg-[var(--color-accent-soft)]" : ""
                            }`}
                          >
                            <span className="text-[var(--color-fg-muted)] truncate">└ {p.name || "無題"}</span>
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                const parts = (t.parts || []).filter((_, j) => j !== pi);
                                handleSave({ ...t, parts });
                                if (editingPartIdx === pi) setEditingPartIdx(null);
                              }}
                              className="text-[10px] text-red-400 hover:text-red-600"
                            >削除</button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 右: 編集エリア */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {selected ? (
              editingPartIdx !== null && selected.parts?.[editingPartIdx] ? (
                /* パーツ編集 */
                <>
                  <div className="border-b border-[var(--color-border)] px-4 py-2 flex items-center gap-2">
                    <button onClick={() => setEditingPartIdx(null)} className="text-xs text-[var(--color-accent)]">← {selected.name}</button>
                    <span className="text-xs text-[var(--color-fg-subtle)]">/</span>
                    <input
                      type="text"
                      value={selected.parts[editingPartIdx].name}
                      onChange={e => {
                        const parts = [...(selected.parts || [])];
                        parts[editingPartIdx] = { ...parts[editingPartIdx], name: e.target.value };
                        handleSave({ ...selected, parts });
                      }}
                      className="flex-1 rounded border border-[var(--color-border)] px-2 py-1 text-sm focus:border-[var(--color-accent)] focus:outline-none"
                    />
                  </div>
                  <textarea
                    value={selected.parts[editingPartIdx].content}
                    onChange={e => {
                      const parts = [...(selected.parts || [])];
                      parts[editingPartIdx] = { ...parts[editingPartIdx], content: e.target.value };
                      handleSave({ ...selected, parts });
                    }}
                    className="flex-1 p-4 text-sm text-[var(--color-fg)] font-mono leading-relaxed resize-none focus:outline-none"
                    spellCheck={false}
                  />
                </>
              ) : (
                /* マスター編集 */
                <>
                  <div className="border-b border-[var(--color-border)] px-4 py-2 flex items-center gap-2">
                    <input
                      type="text"
                      value={selected.name}
                      onChange={e => handleSave({ ...selected, name: e.target.value })}
                      placeholder="文書名（例: 株主総会議事録）"
                      className="flex-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-sm font-medium focus:border-[var(--color-accent)] focus:outline-none"
                    />
                    <button
                      onClick={() => { setShowFilePicker(true); }}
                      className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] shrink-0"
                    >
                      + パーツ追加
                    </button>
                  </div>
                  <textarea
                    value={selected.content}
                    onChange={e => handleSave({ ...selected, content: e.target.value })}
                    placeholder="雛形の内容"
                    className="flex-1 p-4 text-sm text-[var(--color-fg)] font-mono leading-relaxed resize-none focus:outline-none"
                    spellCheck={false}
                  />
                </>
              )
            ) : (
              <div className="flex h-full items-center justify-center">
                <div className="text-center text-[var(--color-fg-subtle)]">
                  <Icon name="FileText" size={36} className="mx-auto mb-2 text-[var(--color-fg-subtle)]" />
                  <p className="text-sm">左から雛形を選択<br />または「+ ファイルから登録」で作成</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ファイル選択オーバーレイ */}
        {showFilePicker && (
          <FilePickerOverlay
            onSelect={(files) => {
              setSelectedFiles(files);
            }}
            selectedFiles={selectedFiles}
            onGenerate={selected && editingPartIdx === null ? handleAddPartFromFiles : handleGenerateFromFiles}
            generating={generating}
            isPartMode={!!selected && editingPartIdx === null}
            onClose={() => { setShowFilePicker(false); setSelectedFiles([]); }}
          />
        )}
      </div>
  );

  if (inline) return content;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      {content}
    </div>
  );
}

// ファイル選択UI（Google Driveブラウザ簡易版）
function FilePickerOverlay({
  onSelect, selectedFiles, onGenerate, generating, isPartMode, onClose
}: {
  onSelect: (files: { id: string; name: string; mimeType: string }[]) => void;
  selectedFiles: { id: string; name: string; mimeType: string }[];
  onGenerate: () => void;
  generating: boolean;
  isPartMode: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<{ dirs: { name: string; path: string }[]; files?: { name: string; mimeType: string }[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string; name: string }[]>([]);

  const browse = async (dirPath?: string, dirName?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dirPath) params.set("path", dirPath);
      params.set("provider", "google");
      const res = await fetch(`/api/browse?${params}`);
      if (res.ok) setData(await res.json());
      if (dirName && dirPath) setBreadcrumbs(prev => [...prev, { id: dirPath, name: dirName }]);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  useEffect(() => { browse(); }, []);

  const navigateUp = () => {
    const bc = breadcrumbs.slice(0, -1);
    setBreadcrumbs(bc);
    if (bc.length === 0) {
      browse();
      setBreadcrumbs([]);
    } else {
      const last = bc[bc.length - 1];
      // re-browse without adding breadcrumb
      setLoading(true);
      const params = new URLSearchParams({ path: last.id, provider: "google" });
      fetch(`/api/browse?${params}`).then(r => r.json()).then(d => setData(d)).finally(() => setLoading(false));
    }
  };

  const toggleFile = (f: { name: string; mimeType: string }) => {
    // Google Driveのファイルにはpath/idがないのでnameで管理（簡易実装）
    const existing = selectedFiles.find(sf => sf.name === f.name);
    if (existing) {
      onSelect(selectedFiles.filter(sf => sf.name !== f.name));
    } else {
      onSelect([...selectedFiles, { id: f.name, name: f.name, mimeType: f.mimeType }]);
    }
  };

  return (
    <div className="absolute inset-0 bg-[var(--color-panel)] rounded-2xl flex flex-col">
      <div className="border-b border-[var(--color-border)] px-6 py-3 flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-[var(--color-fg)]">
            {isPartMode ? "パーツ用ファイルを選択" : "雛形用ファイルを選択"}
          </h4>
          <div className="flex items-center gap-1 text-[10px] text-[var(--color-fg-subtle)] mt-0.5">
            <button onClick={() => { setBreadcrumbs([]); browse(); }} className="hover:text-[var(--color-fg-muted)]">Google Drive</button>
            {breadcrumbs.map((bc, i) => (
              <span key={bc.id}>
                <span className="mx-0.5">/</span>
                <button onClick={() => {
                  const newBc = breadcrumbs.slice(0, i + 1);
                  setBreadcrumbs(newBc);
                  setLoading(true);
                  const params = new URLSearchParams({ path: bc.id, provider: "google" });
                  fetch(`/api/browse?${params}`).then(r => r.json()).then(d => setData(d)).finally(() => setLoading(false));
                }} className="hover:text-[var(--color-fg-muted)]">{bc.name}</button>
              </span>
            ))}
          </div>
        </div>
        <button onClick={onClose} className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)]">&times;</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <p className="text-sm text-[var(--color-fg-subtle)] text-center py-4">読み込み中...</p>
        ) : data ? (
          <ul className="space-y-0.5">
            {breadcrumbs.length > 0 && (
              <li>
                <button onClick={navigateUp} className="flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] rounded-lg w-full text-left">
                  ↑ 上の階層へ
                </button>
              </li>
            )}
            {data.dirs.map(dir => (
              <li key={dir.path}>
                <button
                  onClick={() => browse(dir.path, dir.name)}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-hover)] rounded-lg w-full text-left"
                >
                  <Icon name="Folder" size={13} className="text-[var(--color-fg-muted)] inline mr-1" /> {dir.name}
                </button>
              </li>
            ))}
            {data.files && data.files.map((f, i) => {
              const isSelected = selectedFiles.some(sf => sf.name === f.name);
              return (
                <li key={`file-${i}`}>
                  <label className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg cursor-pointer ${isSelected ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-hover)]"}`}>
                    <input type="checkbox" checked={isSelected} onChange={() => toggleFile(f)} />
                    <span className="text-[var(--color-fg-muted)]">
                      {f.mimeType.includes("pdf") ? "📄" : f.mimeType.includes("word") || f.mimeType.includes("document") ? "📝" : f.mimeType.includes("sheet") || f.mimeType.includes("excel") ? "📊" : "📎"}
                    </span>
                    <span className="text-[var(--color-fg)]">{f.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <div className="border-t border-[var(--color-border)] px-6 py-3 flex items-center justify-between">
        <span className="text-xs text-[var(--color-fg-subtle)]">{selectedFiles.length}件選択</span>
        <div className="flex gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]">キャンセル</button>
          <button
            onClick={onGenerate}
            disabled={generating || selectedFiles.length === 0}
            className="rounded-lg bg-[var(--color-fg)] px-4 py-1.5 text-xs text-white hover:opacity-90 disabled:bg-gray-300 transition-colors"
          >
            {generating ? "生成中..." : isPartMode ? "パーツとして追加" : "雛形を生成"}
          </button>
        </div>
      </div>
    </div>
  );
}
