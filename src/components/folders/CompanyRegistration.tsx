"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Company } from "@/types";

interface DirEntry {
  name: string;
  path: string;
}

interface FileEntry {
  name: string;
  mimeType: string;
}

interface BrowseResult {
  current: string;
  parent: string | null;
  dirs: DirEntry[];
  files?: FileEntry[];
}

interface Props {
  companies: Company[];
  onAdd: (folders: { id: string; name: string }[]) => void;
  onRemove: (companyId: string) => void;
  onClose: () => void;
}

export default function CompanyRegistration({ companies, onAdd, onRemove, onClose }: Props) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentName, setCurrentName] = useState("マイドライブ");
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string; name: string }[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dragOverRight, setDragOverRight] = useState(false);
  const registeredIds = new Set(companies.map(c => c.id));

  const browse = useCallback(async (dirPath?: string, dirName?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dirPath) params.set("path", dirPath);
      params.set("provider", "google");
      const res = await fetch(`/api/browse?${params}`);
      if (res.ok) {
        setData(await res.json());
        if (dirName !== undefined) setCurrentName(dirName);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { browse(); }, [browse]);

  const navigateTo = (dirPath: string, dirName: string) => {
    setBreadcrumbs(prev => [...prev, { id: dirPath, name: dirName }]);
    browse(dirPath, dirName);
  };

  const navigateBreadcrumb = (index: number) => {
    if (index < 0) {
      setBreadcrumbs([]);
      browse(undefined, "マイドライブ");
    } else {
      const bc = breadcrumbs.slice(0, index + 1);
      setBreadcrumbs(bc);
      browse(bc[bc.length - 1].id, bc[bc.length - 1].name);
    }
  };

  const navigateUp = () => {
    if (breadcrumbs.length > 0) {
      navigateBreadcrumb(breadcrumbs.length - 2);
    }
  };

  // チェックボックスで選択
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 全選択
  const selectAll = () => {
    if (!data) return;
    const allIds = data.dirs.filter(d => !registeredIds.has(d.path)).map(d => d.path);
    setSelectedIds(new Set(allIds));
  };

  // 選択解除
  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  // 選択したフォルダを登録
  const addSelected = () => {
    if (!data) return;
    const folders = data.dirs
      .filter(d => selectedIds.has(d.path))
      .map(d => ({ id: d.path, name: d.name }));
    if (folders.length > 0) {
      onAdd(folders);
      setSelectedIds(new Set());
    }
  };

  // ドラッグ開始
  const handleDragStart = (e: React.DragEvent, dir: DirEntry) => {
    e.dataTransfer.setData("application/json", JSON.stringify({ id: dir.path, name: dir.name }));
    e.dataTransfer.effectAllowed = "copy";
  };

  // ドロップ
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverRight(false);
    try {
      const folder = JSON.parse(e.dataTransfer.getData("application/json"));
      if (folder.id && folder.name && !registeredIds.has(folder.id)) {
        onAdd([folder]);
      }
    } catch { /* ignore */ }
  };

  return (
    <div className="flex h-full flex-col">
      {/* ヘッダー */}
      <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">会社フォルダ登録</h2>
          <p className="text-xs text-gray-500">左からフォルダをドラッグ、またはチェックして追加</p>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
        >
          閉じる
        </button>
      </div>

      {/* メイン */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左: フォルダブラウザ */}
        <div className="flex w-1/2 flex-col border-r border-gray-200">
          {/* パンくず */}
          <div className="flex flex-wrap items-center gap-1 border-b border-gray-100 px-4 py-2">
            <button
              onClick={() => navigateBreadcrumb(-1)}
              className={`text-xs ${breadcrumbs.length === 0 ? "text-gray-700 font-medium" : "text-blue-600 hover:text-blue-800"}`}
            >
              Google Drive
            </button>
            {breadcrumbs.map((bc, i) => (
              <span key={bc.id} className="flex items-center gap-1">
                <span className="text-gray-300 text-xs">/</span>
                <button
                  onClick={() => navigateBreadcrumb(i)}
                  className={`text-xs truncate max-w-[120px] ${i === breadcrumbs.length - 1 ? "text-gray-700 font-medium" : "text-blue-600 hover:text-blue-800"}`}
                >
                  {bc.name}
                </button>
              </span>
            ))}
          </div>

          {/* ツールバー */}
          <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-1.5">
            <button onClick={selectAll} className="text-[10px] text-blue-500 hover:text-blue-700">全選択</button>
            <button onClick={deselectAll} className="text-[10px] text-gray-400 hover:text-gray-600">解除</button>
            {selectedIds.size > 0 && (
              <button
                onClick={addSelected}
                className="ml-auto rounded bg-blue-600 px-2 py-0.5 text-[10px] text-white hover:bg-blue-700"
              >
                {selectedIds.size}件を追加 →
              </button>
            )}
          </div>

          {/* フォルダ一覧 */}
          <div className="flex-1 overflow-y-auto p-2">
            {loading ? (
              <p className="py-4 text-center text-sm text-gray-400">読み込み中...</p>
            ) : data ? (
              <ul>
                {breadcrumbs.length > 0 && (
                  <li>
                    <button
                      onClick={navigateUp}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50"
                    >
                      <span>↑</span> 上の階層へ
                    </button>
                  </li>
                )}
                {data.dirs.map(dir => {
                  const isRegistered = registeredIds.has(dir.path);
                  const isSelected = selectedIds.has(dir.path);
                  return (
                    <li
                      key={dir.path}
                      draggable={!isRegistered}
                      onDragStart={e => handleDragStart(e, dir)}
                      className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm cursor-grab ${
                        isRegistered ? "opacity-40" : "hover:bg-gray-100"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={isRegistered}
                        onChange={() => toggleSelect(dir.path)}
                        className="shrink-0"
                      />
                      <button
                        onClick={() => navigateTo(dir.path, dir.name)}
                        className="flex flex-1 items-center gap-2 text-left text-gray-700"
                      >
                        <span className="shrink-0 text-yellow-500">&#128193;</span>
                        <span className="truncate">{dir.name}</span>
                      </button>
                      {isRegistered && (
                        <span className="shrink-0 text-[10px] text-green-600">登録済</span>
                      )}
                    </li>
                  );
                })}
                {data.files && data.files.length > 0 && (
                  <>
                    <li className="border-t border-gray-100 mt-1 pt-1">
                      <span className="px-3 py-1 text-[10px] text-gray-400">ファイル</span>
                    </li>
                    {data.files.map((file, i) => (
                      <li key={`file-${i}`} className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-gray-400">
                        <span className="shrink-0 text-xs ml-5">
                          {file.mimeType.includes("pdf") ? "📄" :
                           file.mimeType.includes("word") || file.mimeType.includes("document") ? "📝" :
                           file.mimeType.includes("sheet") || file.mimeType.includes("excel") ? "📊" : "📎"}
                        </span>
                        <span className="truncate">{file.name}</span>
                      </li>
                    ))}
                  </>
                )}
              </ul>
            ) : null}
          </div>
        </div>

        {/* 右: 登録済み会社一覧 */}
        <div
          className={`flex w-1/2 flex-col ${dragOverRight ? "bg-blue-50" : "bg-gray-50"} transition-colors`}
          onDragOver={e => { e.preventDefault(); setDragOverRight(true); }}
          onDragLeave={() => setDragOverRight(false)}
          onDrop={handleDrop}
        >
          <div className="border-b border-gray-100 px-4 py-2">
            <span className="text-xs font-medium text-gray-600">
              登録済み会社（{companies.length}社）
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {companies.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-gray-400">
                  左からフォルダをドラッグ<br />または選択して追加
                </p>
              </div>
            ) : (
              <ul className="space-y-0.5">
                {companies
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(c => (
                    <li key={c.id} className="group flex items-center justify-between rounded-lg px-3 py-1.5 hover:bg-white">
                      <span className="text-sm text-gray-700 truncate">{c.name}</span>
                      <button
                        onClick={() => onRemove(c.id)}
                        className="hidden shrink-0 text-[10px] text-red-400 hover:text-red-600 group-hover:block"
                      >
                        削除
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
