"use client";

import { useState } from "react";
import type { Company, WorkspaceConfig, Subfolder } from "@/types";

interface Props {
  company: Company;
  config: WorkspaceConfig;
  onToggleJob: (subfolderId: string, active: boolean) => void;
  onOpenSetup: () => void;
  onUpdate: (config: WorkspaceConfig) => void;
}

export default function CompanyMainView({ company, config, onToggleJob, onOpenSetup, onUpdate }: Props) {
  const [expandedFolder, setExpandedFolder] = useState<string | null>(null);
  const [scanningFolder, setScanningFolder] = useState<string | null>(null);
  const [subfolderData, setSubfolderData] = useState<Record<string, { files: any[]; subfolders: { id: string; name: string }[] }>>({});
  const [expandedSubfolders, setExpandedSubfolders] = useState<Set<string>>(new Set());

  const latestCompany = config.companies.find(c => c.id === company.id) || company;
  const commonSubs = latestCompany.subfolders.filter(s => s.role === "common");
  const jobSubs = latestCompany.subfolders.filter(s => s.role === "job");

  // ファイルスキャン
  const scanFiles = async (sub: Subfolder) => {
    setScanningFolder(sub.id);
    try {
      const res = await fetch("/api/workspace/scan-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id, subfolderId: sub.id }),
      });
      if (res.ok) {
        const { newFiles, subfolders: subs } = await res.json();
        if (subs && subs.length > 0) {
          setSubfolderData(prev => ({ ...prev, [sub.id]: { files: [], subfolders: subs } }));
        }
        const cfgRes = await fetch("/api/workspace");
        if (cfgRes.ok) {
          const newConfig = await cfgRes.json();
          onUpdate(newConfig);
          const updatedCompany = newConfig.companies.find((c: Company) => c.id === company.id);
          const isSub = updatedCompany?.subfolders.find((s: Subfolder) => s.id === sub.id);
          if (newFiles?.length > 0 && isSub?.role === "common" && updatedCompany?.profile) {
            fetch("/api/workspace/profile", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ companyId: company.id, newFiles }),
            }).then(async (r) => {
              if (r.ok) {
                const cfg2 = await fetch("/api/workspace");
                if (cfg2.ok) onUpdate(await cfg2.json());
              }
            });
          }
        }
      }
    } catch { /* ignore */ }
    finally { setScanningFolder(null); }
  };

  const toggleFile = async (subfolderId: string, fileId: string, enabled: boolean) => {
    const res = await fetch("/api/workspace/toggle-file", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId: company.id, subfolderId, fileId, enabled }),
    });
    if (res.ok) onUpdate(await res.json());
  };

  // サブフォルダ内のファイル・フォルダを取得
  const scanSubfolder = async (folderId: string) => {
    try {
      const res = await fetch("/api/workspace/scan-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id, subfolderId: folderId }),
      });
      if (res.ok) {
        const { files, subfolders: subs } = await res.json();
        setSubfolderData(prev => ({ ...prev, [folderId]: { files: files || [], subfolders: subs || [] } }));
      }
    } catch { /* ignore */ }
  };

  const toggleSubfolder = (folderId: string) => {
    setExpandedSubfolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
        if (!subfolderData[folderId]) scanSubfolder(folderId);
      }
      return next;
    });
  };

  const toggleExpand = (subId: string, sub: Subfolder) => {
    if (expandedFolder === subId) {
      setExpandedFolder(null);
    } else {
      setExpandedFolder(subId);
      if (!sub.files || sub.files.length === 0) scanFiles(sub);
    }
  };

  // サブフォルダ内のファイルのON/OFFを切り替え（親subfolderのfilesに追加/更新）
  const toggleNestedFile = async (parentSubId: string, fileId: string, fileName: string, mimeType: string, enabled: boolean) => {
    // まず親subfolderのfilesに存在するか確認
    const parentSub = latestCompany.subfolders.find(s => s.id === parentSubId);
    const existingFile = parentSub?.files?.find(f => f.id === fileId);

    if (existingFile) {
      // 既にあればtoggle
      await toggleFile(parentSubId, fileId, enabled);
    } else {
      // なければ追加してenabled設定
      const res = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "addFileToSubfolder",
          companyId: company.id,
          subfolderId: parentSubId,
          file: { id: fileId, name: fileName, mimeType, size: 0, modifiedTime: new Date().toISOString(), enabled },
        }),
      });
      if (res.ok) onUpdate(await res.json());
    }
  };

  // 親subfolderのIDを探す（展開中のフォルダから辿る）
  const findParentSubId = (folderId: string): string | null => {
    for (const sub of latestCompany.subfolders) {
      if (sub.id === folderId) return sub.id;
      if (subfolderData[sub.id]?.subfolders?.some(sf => sf.id === folderId)) return sub.id;
      // 再帰的に探す
      for (const [key, data] of Object.entries(subfolderData)) {
        if (data.subfolders?.some(sf => sf.id === folderId)) {
          const parent = findParentSubId(key);
          if (parent) return parent;
        }
      }
    }
    return null;
  };

  // ネストされたフォルダの表示（再帰）
  const renderNestedFolder = (folderId: string, rootSubId: string) => {
    const data = subfolderData[folderId];
    if (!data) return <p className="text-[10px] text-gray-400 py-0.5">読み込み中...</p>;

    // 親subfolderのファイルリストからenabledを確認
    const parentSub = latestCompany.subfolders.find(s => s.id === rootSubId);
    const parentFiles = parentSub?.files || [];

    return (
      <>
        {data.subfolders.map(sf => (
          <div key={sf.id}>
            <button
              onClick={() => toggleSubfolder(sf.id)}
              className="flex items-center gap-1 text-[11px] text-gray-600 hover:text-blue-600 py-0.5 w-full text-left"
            >
              <span className="text-yellow-500 text-xs">📁</span>
              <span className="truncate">{sf.name}</span>
              <span className="text-[9px] text-gray-400 ml-auto">{expandedSubfolders.has(sf.id) ? "▼" : "▶"}</span>
            </button>
            {expandedSubfolders.has(sf.id) && (
              <div className="ml-3 border-l border-gray-200 pl-2">
                {renderNestedFolder(sf.id, rootSubId)}
              </div>
            )}
          </div>
        ))}
        {data.files.length > 0 && (
          <ul className="space-y-0.5">
            {data.files.map((f: any) => {
              const parentFile = parentFiles.find(pf => pf.id === f.id);
              const isEnabled = parentFile ? parentFile.enabled : false;
              return (
                <li key={f.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={e => toggleNestedFile(rootSubId, f.id, f.name, f.mimeType, e.target.checked)}
                    className="rounded text-blue-600 w-3 h-3"
                  />
                  <span className={`text-[11px] truncate ${isEnabled ? "text-gray-700" : "text-gray-400"}`} title={f.name}>
                    {f.name}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {data.subfolders.length === 0 && data.files.length === 0 && (
          <p className="text-[10px] text-gray-400 py-0.5">空</p>
        )}
      </>
    );
  };

  const renderSubfolderFiles = (sub: Subfolder) => {
    const latestSub = latestCompany.subfolders.find(s => s.id === sub.id) || sub;
    const isExpanded = expandedFolder === sub.id;
    const isScanning = scanningFolder === sub.id;

    if (!isExpanded) return null;

    return (
      <div className="mt-1 ml-3 border-l border-gray-200 pl-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-gray-400">
            {latestSub.files ? `${latestSub.files.filter(f => f.enabled).length}/${latestSub.files.length}件` : ""}
          </span>
          <button
            onClick={() => scanFiles(latestSub)}
            disabled={isScanning}
            className="text-[10px] text-blue-500 hover:text-blue-700 disabled:text-gray-300"
          >
            {isScanning ? "更新中..." : "更新"}
          </button>
        </div>
        {isScanning && !latestSub.files?.length ? (
          <p className="text-[10px] text-gray-400 py-1">スキャン中...</p>
        ) : (
          <>
            {/* サブフォルダ */}
            {subfolderData[sub.id]?.subfolders?.map(sf => (
              <div key={sf.id}>
                <button
                  onClick={() => toggleSubfolder(sf.id)}
                  className="flex items-center gap-1 text-[11px] text-gray-600 hover:text-blue-600 py-0.5 w-full text-left"
                >
                  <span className="text-yellow-500 text-xs">📁</span>
                  <span className="truncate">{sf.name}</span>
                  <span className="text-[9px] text-gray-400 ml-auto">{expandedSubfolders.has(sf.id) ? "▼" : "▶"}</span>
                </button>
                {expandedSubfolders.has(sf.id) && (
                  <div className="ml-3 border-l border-gray-200 pl-2">
                    {renderNestedFolder(sf.id, sub.id)}
                  </div>
                )}
              </div>
            ))}
            {/* ファイル */}
            {latestSub.files && latestSub.files.length > 0 ? (
              <ul className="space-y-0.5">
                {latestSub.files.map(f => (
                  <li key={f.id} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={f.enabled}
                      onChange={e => toggleFile(sub.id, f.id, e.target.checked)}
                      className="rounded text-blue-600 w-3 h-3"
                    />
                    <span className={`text-[11px] truncate ${f.enabled ? "text-gray-700" : "text-gray-400 line-through"}`} title={f.name}>
                      {f.name}
                    </span>
                  </li>
                ))}
              </ul>
            ) : !subfolderData[sub.id]?.subfolders?.length ? (
              <p className="text-[10px] text-gray-400 py-1">ファイルなし</p>
            ) : null}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4">
          <div>
            {/* 常時参照 */}
            {commonSubs.length > 0 && (
              <div className="mb-4">
                <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-green-600">
                  常時参照
                </h3>
                <ul className="space-y-0.5">
                  {commonSubs.map(sub => (
                    <li key={sub.id}>
                      <button
                        onClick={() => toggleExpand(sub.id, sub)}
                        className={`w-full rounded px-2 py-1 text-xs text-left transition-colors ${
                          expandedFolder === sub.id ? "bg-green-100 text-green-700" : "text-gray-600 bg-green-50 hover:bg-green-100"
                        }`}
                      >
                        <span className="flex items-center justify-between">
                          {sub.name}
                          <span className="text-[10px] text-gray-400">
                            {sub.files ? `${sub.files.filter(f => f.enabled).length}件` : ""}
                            {expandedFolder === sub.id ? " ▼" : " ▶"}
                          </span>
                        </span>
                      </button>
                      {renderSubfolderFiles(sub)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 案件フォルダ */}
            {jobSubs.length > 0 && (
              <div className="mb-4">
                <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-blue-600">
                  案件
                </h3>
                <ul className="space-y-1">
                  {jobSubs.map(sub => (
                    <li key={sub.id}>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onToggleJob(sub.id, !sub.active)}
                          className={`flex-1 flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                            sub.active
                              ? "bg-blue-100 text-blue-700 border border-blue-200"
                              : "bg-white text-gray-600 border border-gray-200 hover:border-blue-300"
                          }`}
                        >
                          <span className={`shrink-0 w-2 h-2 rounded-full ${sub.active ? "bg-blue-500" : "bg-gray-300"}`} />
                          <span className="flex-1 truncate">{sub.name}</span>
                          {sub.files && (
                            <span className="text-[10px] text-gray-400">
                              {sub.files.filter(f => f.enabled).length}件
                            </span>
                          )}
                        </button>
                        <button
                          onClick={() => toggleExpand(sub.id, sub)}
                          className="shrink-0 rounded p-1.5 text-[10px] text-gray-400 hover:bg-gray-100"
                        >
                          {expandedFolder === sub.id ? "▼" : "▶"}
                        </button>
                      </div>
                      {renderSubfolderFiles(sub)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* フォルダ設定 */}
            <button
              onClick={onOpenSetup}
              className="w-full rounded-lg border border-dashed border-gray-300 py-2 text-xs text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
            >
              {latestCompany.subfolders.length === 0 ? "フォルダを設定" : "フォルダ設定を変更"}
            </button>
          </div>
      </div>
    </div>
  );
}
