"use client";

import { useState, useEffect, useCallback } from "react";
import type { Company, WorkspaceConfig, Subfolder, SubfolderRole } from "@/types";

interface FolderNode {
  id: string;
  name: string;
}

interface Breadcrumb {
  id: string;
  name: string;
}

interface Props {
  company: Company;
  provider: string;
  onBack: () => void;
  onUpdate: (config: WorkspaceConfig) => void;
}

export default function CompanyDetail({ company, provider, onBack, onUpdate }: Props) {
  const [scanning, setScanning] = useState(false);
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([
    { id: company.id, name: company.name },
  ]);

  const currentFolderId = breadcrumbs[breadcrumbs.length - 1].id;

  // フォルダを読み込む
  const loadFolders = useCallback(async (folderId: string) => {
    setScanning(true);
    try {
      const res = await fetch("/api/workspace/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId, provider }),
      });
      if (res.ok) {
        const { folders: f } = await res.json();
        setFolders(f);
      }
    } catch {
      // ignore
    } finally {
      setScanning(false);
    }
  }, [provider]);

  useEffect(() => {
    loadFolders(currentFolderId);
  }, [currentFolderId, loadFolders]);

  // フォルダを掘る
  const handleDrillDown = (folder: FolderNode) => {
    setBreadcrumbs(prev => [...prev, folder]);
  };

  // パンくずで戻る
  const handleBreadcrumb = (index: number) => {
    setBreadcrumbs(prev => prev.slice(0, index + 1));
  };

  // サブフォルダの状態を取得
  const getSubfolder = (folderId: string): Subfolder | undefined => {
    return company.subfolders.find(s => s.id === folderId);
  };

  // 共通/案件トグル
  const handleSetRole = async (folderId: string, folderName: string, role: SubfolderRole) => {
    const existing = getSubfolder(folderId);
    if (existing) {
      // 既存なら役割変更
      const res = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setSubfolderRole",
          companyId: company.id,
          subfolderId: folderId,
          role,
        }),
      });
      if (res.ok) onUpdate(await res.json());
    } else {
      // 新規追加
      const newSub: Subfolder = {
        id: folderId,
        name: folderName,
        role,
        active: role === "common",
      };
      const subfolders = [...company.subfolders, newSub];
      const res = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setSubfolders",
          companyId: company.id,
          subfolders,
        }),
      });
      if (res.ok) onUpdate(await res.json());
    }
  };

  // 案件フォルダのactive切り替え
  const handleToggleActive = async (subfolderId: string, active: boolean) => {
    const res = await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "toggleSubfolder",
        companyId: company.id,
        subfolderId,
        active,
      }),
    });
    if (res.ok) onUpdate(await res.json());
  };

  // 登録解除
  const handleRemove = async (subfolderId: string) => {
    const subfolders = company.subfolders.filter(s => s.id !== subfolderId);
    const res = await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "setSubfolders",
        companyId: company.id,
        subfolders,
      }),
    });
    if (res.ok) onUpdate(await res.json());
  };

  const commonFolders = company.subfolders.filter(s => s.role === "common");
  const jobFolders = company.subfolders.filter(s => s.role === "job");

  return (
    <aside className="flex h-full w-72 flex-col border-r border-gray-200 bg-gray-50">
      {/* ヘッダー */}
      <div className="border-b border-gray-200 p-4">
        <button
          onClick={onBack}
          className="mb-1 text-xs text-blue-600 hover:text-blue-800"
        >
          ← 会社一覧に戻る
        </button>
        <h2 className="text-sm font-bold text-gray-800 truncate" title={company.name}>
          {company.name}
        </h2>
      </div>

      {/* 登録済みフォルダ */}
      {(commonFolders.length > 0 || jobFolders.length > 0) && (
        <div className="border-b border-gray-200 p-4">
          {commonFolders.length > 0 && (
            <div className="mb-3">
              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                常時参照
              </h3>
              <ul className="space-y-0.5">
                {commonFolders.map(sub => (
                  <li key={sub.id} className="group flex items-center justify-between rounded px-1.5 py-1 hover:bg-gray-200">
                    <span className="text-xs text-gray-700 truncate">{sub.name}</span>
                    <button
                      onClick={() => handleRemove(sub.id)}
                      className="hidden text-[10px] text-red-400 hover:text-red-600 group-hover:block"
                    >
                      解除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {jobFolders.length > 0 && (
            <div>
              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                案件フォルダ
              </h3>
              <ul className="space-y-0.5">
                {jobFolders.map(sub => (
                  <li key={sub.id} className="group flex items-center justify-between rounded px-1.5 py-1 hover:bg-gray-200">
                    <label className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={sub.active}
                        onChange={e => handleToggleActive(sub.id, e.target.checked)}
                        className="rounded text-blue-600"
                      />
                      <span className={sub.active ? "text-gray-700" : "text-gray-400"}>
                        {sub.name}
                      </span>
                    </label>
                    <button
                      onClick={() => handleRemove(sub.id)}
                      className="hidden text-[10px] text-red-400 hover:text-red-600 group-hover:block"
                    >
                      解除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* フォルダブラウザ */}
      <div className="flex-1 overflow-y-auto">
        {/* パンくず */}
        <div className="flex flex-wrap items-center gap-1 border-b border-gray-100 px-4 py-2">
          {breadcrumbs.map((bc, i) => (
            <span key={bc.id} className="flex items-center gap-1">
              {i > 0 && <span className="text-gray-300 text-xs">/</span>}
              <button
                onClick={() => handleBreadcrumb(i)}
                className={`text-xs truncate max-w-[80px] ${
                  i === breadcrumbs.length - 1
                    ? "text-gray-700 font-medium"
                    : "text-blue-600 hover:text-blue-800"
                }`}
                title={bc.name}
              >
                {i === 0 ? bc.name.slice(0, 15) : bc.name}
              </button>
            </span>
          ))}
        </div>

        {/* フォルダ一覧 */}
        <div className="p-2">
          {scanning ? (
            <p className="px-2 py-4 text-center text-xs text-gray-400">読み込み中...</p>
          ) : folders.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-gray-400">サブフォルダなし</p>
          ) : (
            <ul className="space-y-0.5">
              {folders.map(folder => {
                const sub = getSubfolder(folder.id);
                return (
                  <li key={folder.id} className="group">
                    <div className="flex items-center rounded-lg hover:bg-gray-100">
                      {/* フォルダ名（クリックで掘る） */}
                      <button
                        onClick={() => handleDrillDown(folder)}
                        className="flex-1 flex items-center gap-2 px-2 py-1.5 text-left text-sm text-gray-700"
                      >
                        <span className="shrink-0 text-yellow-500 text-xs">&#128193;</span>
                        <span className="truncate">{folder.name}</span>
                        {sub && (
                          <span className={`shrink-0 rounded px-1 text-[10px] ${
                            sub.role === "common"
                              ? "bg-green-100 text-green-700"
                              : sub.active
                                ? "bg-blue-100 text-blue-700"
                                : "bg-gray-100 text-gray-500"
                          }`}>
                            {sub.role === "common" ? "共通" : sub.active ? "有効" : "案件"}
                          </span>
                        )}
                      </button>
                      {/* 登録ボタン */}
                      <div className="hidden shrink-0 gap-1 pr-2 group-hover:flex">
                        {(!sub || sub.role !== "common") && (
                          <button
                            onClick={() => handleSetRole(folder.id, folder.name, "common")}
                            className="rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-700 hover:bg-green-100"
                          >
                            共通
                          </button>
                        )}
                        {(!sub || sub.role !== "job") && (
                          <button
                            onClick={() => handleSetRole(folder.id, folder.name, "job")}
                            className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700 hover:bg-blue-100"
                          >
                            案件
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
