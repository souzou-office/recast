"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { WorkspaceConfig, Company } from "@/types";
import CloudStatus from "./CloudStatus";
import CompanyMainView from "./CompanyMainView";

export default function FolderSidebar() {
  const [config, setConfig] = useState<WorkspaceConfig>({
    baseFolders: [],
    globalCommon: [],
    defaultCommonPatterns: [],
    companies: [],
    selectedCompanyId: null,
  });
  const [companyDropdownOpen, setCompanyDropdownOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchConfig = useCallback(async () => {
    const res = await fetch("/api/workspace");
    if (res.ok) setConfig(await res.json());
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  // ドロップダウン外クリックで閉じる
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setCompanyDropdownOpen(false);
        setSearchQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selectedCompany = config.companies.find(c => c.id === config.selectedCompanyId);

  // --- API helpers ---
  const patchConfig = async (body: object) => {
    const res = await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) { const data = await res.json(); setConfig(data); return data; }
    return null;
  };

  // スキャンキャンセル
  // 会社選択
  const handleSelectCompany = async (companyId: string) => {
    const data = await patchConfig({ action: "selectCompany", companyId });
    setCompanyDropdownOpen(false);
    setSearchQuery("");

    // 未設定の会社を自動セットアップ
    const company = (data || config).companies.find((c: Company) => c.id === companyId);
    if (company && company.subfolders.length === 0 && config.defaultCommonPatterns.length > 0) {
      await patchConfig({ action: "autoSetupCompany", companyId });
    }
  };

  // 案件フォルダのactive切替
  const handleToggleJob = async (subfolderId: string, active: boolean) => {
    await patchConfig({
      action: "toggleSubfolder",
      companyId: config.selectedCompanyId,
      subfolderId,
      active,
    });
  };

  // フォルダ再スキャン（force）
  const handleRescanCompany = async (companyId: string) => {
    await patchConfig({ action: "autoSetupCompany", companyId, force: true });
  };

  // フィルタリング（全ルートの会社をまとめて表示）
  const filteredCompanies = config.companies
    .filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  // --- メイン画面 ---
  return (
    <aside className="flex h-full w-72 flex-col border-r border-gray-200 bg-gray-50">
      {/* ヘッダー */}
      <div className="border-b border-gray-200 px-4 py-2 flex justify-center">
        <img src="/logo.png" alt="Recast" className="h-11" />
      </div>

      {config.companies.length === 0 ? (
        <>
          <div className="flex-1 p-4">
            <p className="text-center text-xs text-gray-400 py-4">
              設定タブから会社を登録してください
            </p>
          </div>
          <div className="border-t border-gray-200 px-3 py-2">
            <CloudStatus />
          </div>
        </>
      ) : (
        <>
          {/* 会社セレクター */}
          <div className="border-b border-gray-200 p-3" ref={dropdownRef}>
            <div className="relative">
              <button
                onClick={() => setCompanyDropdownOpen(!companyDropdownOpen)}
                className="w-full flex items-center justify-between rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-left hover:border-blue-400 transition-colors"
              >
                <span className="truncate">
                  {selectedCompany ? selectedCompany.name : "会社を選択..."}
                </span>
                <span className="shrink-0 text-gray-400 text-xs ml-2">
                  {companyDropdownOpen ? "▲" : "▼"}
                </span>
              </button>

              {companyDropdownOpen && (
                <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg"
                     style={{ maxHeight: "300px" }}>
                  {/* 検索 */}
                  <div className="border-b border-gray-100 p-2">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      placeholder="会社名で検索..."
                      autoFocus
                      className="w-full rounded border border-gray-200 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none"
                    />
                  </div>
                  <ul className="max-h-[240px] overflow-y-auto py-1">
                    {filteredCompanies.length === 0 ? (
                      <li className="px-3 py-2 text-xs text-gray-400">見つかりません</li>
                    ) : (
                      filteredCompanies.map(c => (
                        <li key={c.id}>
                          <button
                            onClick={() => handleSelectCompany(c.id)}
                            className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${
                              c.id === config.selectedCompanyId
                                ? "bg-blue-50 text-blue-700"
                                : "text-gray-700 hover:bg-gray-100"
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
          </div>

          {/* 選択中の会社の内容 */}
          {selectedCompany ? (
            <CompanyMainView
              company={selectedCompany}
              config={config}
              onToggleJob={handleToggleJob}
              onRescan={handleRescanCompany}
              onUpdate={setConfig}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center p-4">
              <p className="text-xs text-gray-400">会社を選択してください</p>
            </div>
          )}

          {/* クラウド接続（常時表示） */}
          <div className="border-t border-gray-200 px-3 py-2">
            <CloudStatus />
          </div>

        </>
      )}

    </aside>
  );
}
