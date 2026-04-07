"use client";

import { useState, useEffect, useCallback } from "react";
import type { Company, SubfolderRole } from "@/types";

interface LiveFile {
  name: string;
  path: string;
}

interface LiveFolder {
  name: string;
  path: string;
}

interface FolderData {
  files: LiveFile[];
  subfolders: LiveFolder[];
}

interface Props {
  companies: Company[];
  selectedCompanyId: string | null;
  onSelectCompany: (companyId: string) => void;
  onToggleJob: (subfolderId: string, active: boolean) => void;
  onToggleFile: (companyId: string, subfolderId: string, filePath: string, enabled: boolean) => void;
  onSelectSingleFolder: (companyId: string, subfolderId: string, selectedPath: string, siblingPaths: string[]) => void;
  onChangeRole: (companyId: string, subfolderId: string, newRole: SubfolderRole) => void;
}

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return "📄";
  if (["doc", "docx"].includes(ext)) return "📝";
  if (["xls", "xlsx"].includes(ext)) return "📊";
  if (["jpg", "jpeg", "png", "gif"].includes(ext)) return "🖼";
  return "📎";
}

// ロール3段階切替: 共通 → 案件 → なし → 共通...
function nextRole(current: SubfolderRole): SubfolderRole {
  if (current === "common") return "job";
  if (current === "job") return "none";
  return "common";
}

function roleBadge(role: SubfolderRole) {
  if (role === "common") return { label: "共通", cls: "bg-green-100 text-green-700" };
  if (role === "job") return { label: "案件", cls: "bg-blue-100 text-blue-700" };
  return { label: "除外", cls: "bg-gray-100 text-gray-400" };
}

export default function FileSidebar({
  companies, selectedCompanyId, onSelectCompany,
  onToggleJob, onToggleFile, onSelectSingleFolder, onChangeRole,
}: Props) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [folderData, setFolderData] = useState<Record<string, FolderData>>({});
  const [companySearchOpen, setCompanySearchOpen] = useState(false);
  const [companySearch, setCompanySearch] = useState("");

  const company = companies.find(c => c.id === selectedCompanyId) || null;

  // 会社変更時のみリセット（selectedCompanyIdだけ監視）
  const [prevCompanyId, setPrevCompanyId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedCompanyId === prevCompanyId) return;
    setPrevCompanyId(selectedCompanyId);
    setFolderData({});
    const comp = companies.find(c => c.id === selectedCompanyId);
    if (comp && comp.subfolders.length > 0) {
      const parentPaths = new Set<string>();
      for (const sub of comp.subfolders) {
        const rel = sub.id.slice(comp.id.length).replace(/^[\\/]+/, "");
        const segments = rel.split(/[\\/]/);
        if (segments.length > 1) {
          const parentPath = comp.id + (comp.id.endsWith("\\") ? "" : "\\") + segments[0];
          parentPaths.add(parentPath);
        }
      }
      setExpandedFolders(parentPaths);
    } else {
      setExpandedFolders(new Set());
    }
  }, [selectedCompanyId]);

  const loadFolder = useCallback(async (folderPath: string) => {
    try {
      const res = await fetch("/api/workspace/list-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: folderPath }),
      });
      const data = await res.json();
      setFolderData(prev => ({
        ...prev,
        [folderPath]: {
          files: data.files || [],
          subfolders: data.subfolders || [],
        },
      }));
    } catch { /* ignore */ }
  }, []);

  // ウィンドウにフォーカスが戻ったら展開中フォルダを再取得
  useEffect(() => {
    const handleFocus = () => {
      expandedFolders.forEach(path => loadFolder(path));
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [expandedFolders, loadFolder]);

  const toggleFolder = (folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
        loadFolder(folderId); // 毎回再取得
      }
      return next;
    });
  };

  const sortedCompanies = companies.slice().sort((a, b) => a.name.localeCompare(b.name));
  const filteredCompanies = companySearch
    ? sortedCompanies.filter(c => c.name.toLowerCase().includes(companySearch.toLowerCase()))
    : sortedCompanies;


  // フォルダパスが属するsubfolderを特定
  const findOwnerSub = (filePath: string) => {
    if (!company) return null;
    return company.subfolders.find(s => filePath.startsWith(s.id));
  };

  // 再帰的フォルダツリー
  const renderTree = (folderPath: string, depth: number = 0) => {
    const data = folderData[folderPath];
    if (!data) return <p className="text-[10px] text-gray-400 py-1 pl-2">読み込み中...</p>;

    const ownerSub = findOwnerSub(folderPath);
    const disabledSet = new Set(ownerSub?.disabledFiles || []);

    return (
      <ul className={depth > 0 ? "ml-3 border-l border-gray-200 pl-2" : ""}>
        {data.subfolders.map(sf => {
          const isExpanded = expandedFolders.has(sf.path);
          const isFolderDisabled = disabledSet.has(sf.path);
          const siblingPaths = data.subfolders.map(s => s.path);
          return (
            <li key={sf.path}>
              <div className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={!isFolderDisabled}
                  onChange={() => {
                    if (!company || !ownerSub) return;
                    if (!isFolderDisabled) {
                      // すでにON → OFFにする（普通のトグル）
                      onToggleFile(company.id, ownerSub.id, sf.path, false);
                    } else {
                      // OFF → ON（単一選択：兄弟をOFF）
                      onSelectSingleFolder(company.id, ownerSub.id, sf.path, siblingPaths);
                    }
                  }}
                  className="shrink-0 w-3 h-3"
                />
                <button
                  onClick={() => toggleFolder(sf.path)}
                  className={`flex-1 flex items-center gap-1 rounded px-1 py-0.5 text-xs text-left hover:bg-gray-100 ${
                    isFolderDisabled ? "text-gray-400" : "text-gray-700"
                  }`}
                >
                  <span className="text-[10px]">{isExpanded ? "📂" : "📁"}</span>
                  <span className="truncate">{sf.name}</span>
                </button>
              </div>
              {isExpanded && !isFolderDisabled && renderTree(sf.path, depth + 1)}
            </li>
          );
        })}
        {data.files.map(f => {
          const isDisabled = disabledSet.has(f.path);
          return (
            <li key={f.path} className="flex items-center gap-1 py-0.5 pl-1">
              <input
                type="checkbox"
                checked={!isDisabled}
                onChange={() => {
                  if (!company || !ownerSub) return;
                  onToggleFile(company.id, ownerSub.id, f.path, isDisabled);
                }}
                className="shrink-0 w-3 h-3"
              />
              <span className="text-[10px] shrink-0">{fileIcon(f.name)}</span>
              <span className={`text-[11px] truncate ${isDisabled ? "text-gray-400 line-through" : "text-gray-600"}`}>
                {f.name}
              </span>
            </li>
          );
        })}
        {data.files.length === 0 && data.subfolders.length === 0 && (
          <li className="text-[10px] text-gray-400 py-1 pl-2">空</li>
        )}
      </ul>
    );
  };

  return (
    <aside className="shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col overflow-hidden" style={{ width: "100%" }}>
      {/* 会社セレクター */}
      <div className="border-b border-gray-200 p-2">
        <button
          onClick={() => setCompanySearchOpen(!companySearchOpen)}
          className="w-full flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs hover:border-blue-400 transition-colors"
        >
          <span className="flex-1 truncate text-left text-gray-700">
            {company ? company.name : "会社を選択"}
          </span>
          <span className="text-gray-400 text-[10px]">{companySearchOpen ? "▲" : "▼"}</span>
        </button>
        {companySearchOpen && (
          <div className="mt-1 rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
            <input
              type="text"
              value={companySearch}
              onChange={e => setCompanySearch(e.target.value)}
              placeholder="検索..."
              autoFocus
              className="w-full border-b border-gray-100 px-2.5 py-1.5 text-xs focus:outline-none"
            />
            <ul className="max-h-[250px] overflow-y-auto py-0.5">
              {filteredCompanies.length === 0 ? (
                <li className="px-2.5 py-1.5 text-[10px] text-gray-400">見つかりません</li>
              ) : (
                filteredCompanies.map(c => (
                  <li key={c.id}>
                    <button
                      onClick={() => { onSelectCompany(c.id); setCompanySearchOpen(false); setCompanySearch(""); }}
                      className={`w-full px-2.5 py-1 text-left text-xs transition-colors ${
                        c.id === selectedCompanyId ? "bg-blue-50 text-blue-700" : "text-gray-700 hover:bg-gray-100"
                      }`}
                    >
                      {c.name}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
      </div>

      {/* ファイルツリー */}
      <div className="flex-1 p-2 overflow-y-auto">
        {!company ? (
          <p className="text-[10px] text-gray-400 py-4 text-center">会社を選択してください</p>
        ) : company.subfolders.length === 0 ? (
          <p className="text-[10px] text-gray-400 py-4 text-center">サブフォルダなし</p>
        ) : (() => {
          // サブフォルダを親フォルダでグルーピング
          const companyPath = company.id;
          const groups: Record<string, typeof company.subfolders> = {};
          for (const sub of company.subfolders) {
            // sub.id からcompanyPathを引いた相対パスの最初のセグメントが親
            const rel = sub.id.slice(companyPath.length).replace(/^[\\/]+/, "");
            const segments = rel.split(/[\\/]/);
            const parentName = segments.length > 1 ? segments[0] : "";
            if (!groups[parentName]) groups[parentName] = [];
            groups[parentName].push(sub);
          }

          return (
            <ul className="space-y-0.5">
              {Object.entries(groups).map(([parentName, subs]) => {
                if (parentName === "") {
                  // 親なし（直下のサブフォルダ）
                  return subs.map(sub => renderSubfolder(sub));
                }
                // 親フォルダでグルーピング
                const parentPath = companyPath + (companyPath.endsWith("\\") ? "" : "\\") + parentName;
                const isParentExpanded = expandedFolders.has(parentPath);
                return (
                  <li key={parentPath}>
                    <button
                      onClick={() => {
                        setExpandedFolders(prev => {
                          const next = new Set(prev);
                          if (next.has(parentPath)) next.delete(parentPath);
                          else next.add(parentPath);
                          return next;
                        });
                      }}
                      className="w-full flex items-center gap-1 rounded px-1.5 py-1 text-xs text-left text-gray-700 hover:bg-white font-medium"
                    >
                      <span className="text-[10px] text-gray-400">{isParentExpanded ? "▼" : "▶"}</span>
                      <span className="truncate">{parentName}</span>
                    </button>
                    {isParentExpanded && (
                      <ul className="ml-3 border-l border-gray-200 pl-1 space-y-0.5">
                        {subs.map(sub => renderSubfolder(sub))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          );

          function renderSubfolder(sub: Company["subfolders"][0]) {
            const isExpanded = expandedFolders.has(sub.id);
            const badge = roleBadge(sub.role);
            return (
              <li key={sub.id}>
                <div className="flex items-center gap-1">
                  {sub.role === "job" && (
                    <button
                      onClick={() => onToggleJob(sub.id, !sub.active)}
                      className={`shrink-0 w-3 h-3 rounded-full border-2 transition-colors ${
                        sub.active ? "bg-blue-500 border-blue-500" : "bg-white border-gray-300"
                      }`}
                    />
                  )}
                  <button
                    onClick={() => toggleFolder(sub.id)}
                    className={`flex-1 flex items-center gap-1 rounded px-1.5 py-1 text-xs text-left transition-colors ${
                      sub.role === "none" ? "text-gray-400" : "text-gray-700 hover:bg-white"
                    }`}
                  >
                    <span className="text-[10px] text-gray-400">{isExpanded ? "▼" : "▶"}</span>
                    <span className="truncate">{sub.name}</span>
                  </button>
                  <button
                    onClick={() => company && onChangeRole(company.id, sub.id, nextRole(sub.role))}
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${badge.cls}`}
                  >
                    {badge.label}
                  </button>
                </div>
                {isExpanded && (
                  <div className="ml-4">
                    {renderTree(sub.id)}
                  </div>
                )}
              </li>
            );
          }
        })()}
      </div>

    </aside>
  );
}
