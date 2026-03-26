"use client";

import { useState, useEffect, useCallback } from "react";
import type { WorkspaceConfig, Company } from "@/types";
import ChatWindow from "@/components/chat/ChatWindow";
import CompanyProfile from "@/components/CompanyProfile";
import DocumentGenerator from "@/components/DocumentGenerator";
import VerificationView from "@/components/VerificationView";
import CaseOrganizer from "@/components/CaseOrganizer";
import SettingsView from "@/components/SettingsView";

type MainTab = "chat" | "profile" | "organize" | "search" | "verify" | "documents" | "settings";

export default function Home() {
  const [tab, setTab] = useState<MainTab>("chat");
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [companyDropdownOpen, setCompanyDropdownOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const fetchConfig = useCallback(async () => {
    const res = await fetch("/api/workspace");
    if (res.ok) setConfig(await res.json());
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  // サイドバーの変更を検知して自動更新（2秒ごと）
  useEffect(() => {
    const interval = setInterval(fetchConfig, 2000);
    return () => clearInterval(interval);
  }, [fetchConfig]);

  const selectedCompany = config?.companies.find(c => c.id === config.selectedCompanyId);

  // 会社追加
  const handleAddCompanies = async (folders: { id: string; name: string }[]) => {
    if (!config) return;
    const existingIds = new Set(config.companies.map(c => c.id));
    const newCompanies: Company[] = folders
      .filter(f => !existingIds.has(f.id))
      .map(f => ({ id: f.id, name: f.name, subfolders: [] }));

    if (newCompanies.length === 0) return;

    const allCompanies = [...config.companies, ...newCompanies];
    const res = await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setCompanies", companies: allCompanies }),
    });
    if (res.ok) setConfig(await res.json());
  };

  // 会社削除
  const handleRemoveCompany = async (companyId: string) => {
    if (!config) return;
    const companies = config.companies.filter(c => c.id !== companyId);
    const res = await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setCompanies", companies }),
    });
    if (res.ok) setConfig(await res.json());
  };

  const handleSelectCompany = async (companyId: string) => {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "selectCompany", companyId }),
    });
    await fetchConfig();
    setCompanyDropdownOpen(false);
    setSearchQuery("");

    // 未設定の会社を自動セットアップ
    if (config) {
      const company = config.companies.find(c => c.id === companyId);
      if (company && company.subfolders.length === 0 && config.defaultCommonPatterns.length > 0) {
        await fetch("/api/workspace", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "autoSetupCompany", companyId }),
        });
        await fetchConfig();
      }
    }
  };

  const filteredCompanies = (config?.companies || [])
    .filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 横断検索から会社の基本情報に飛ぶ
  const handleNavigateToCompany = async (targetCompanyId: string) => {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "selectCompany", companyId: targetCompanyId }),
    });
    await fetchConfig();
    setTab("profile");
  };

  return (
    <main className="flex h-screen flex-col">
      {/* ヘッダー: ロゴ + 会社セレクター + タブ */}
      <div className="flex items-center border-b border-gray-200 bg-white">
        {/* ロゴ */}
        <div className="px-4 shrink-0">
          <img src="/logo.png" alt="Recast" className="h-8" />
        </div>

        {/* 会社セレクター */}
        <div className="relative shrink-0 mr-2">
          <button
            onClick={() => setCompanyDropdownOpen(!companyDropdownOpen)}
            className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm hover:border-blue-400 transition-colors"
          >
            <span className="truncate max-w-[200px]">
              {selectedCompany ? selectedCompany.name : "会社を選択"}
            </span>
            <span className="text-gray-400 text-xs">{companyDropdownOpen ? "▲" : "▼"}</span>
          </button>
          {companyDropdownOpen && (
            <div className="absolute z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg" style={{ maxHeight: "400px" }}>
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
              <ul className="max-h-[300px] overflow-y-auto py-1">
                {filteredCompanies.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-gray-400">見つかりません</li>
                ) : (
                  filteredCompanies.map(c => (
                    <li key={c.id}>
                      <button
                        onClick={() => handleSelectCompany(c.id)}
                        className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${
                          c.id === config?.selectedCompanyId
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

        {/* タブ */}
        <div className="flex flex-1 overflow-x-auto">
              <button
                onClick={() => !chatLoading && setTab("chat")}
                className={`px-6 py-3 text-sm font-medium transition-colors ${
                  tab === "chat"
                    ? "border-b-2 border-blue-500 text-blue-600"
                    : chatLoading ? "text-gray-300 cursor-not-allowed" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                チャット
              </button>
              <button
                onClick={() => !chatLoading && setTab("profile")}
                className={`px-6 py-3 text-sm font-medium transition-colors ${
                  tab === "profile"
                    ? "border-b-2 border-blue-500 text-blue-600"
                    : chatLoading ? "text-gray-300 cursor-not-allowed" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                基本情報
              </button>
              <button
                onClick={() => !chatLoading && setTab("organize")}
                className={`px-6 py-3 text-sm font-medium transition-colors ${
                  tab === "organize"
                    ? "border-b-2 border-blue-500 text-blue-600"
                    : chatLoading ? "text-gray-300 cursor-not-allowed" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                案件整理
              </button>
              <button
                onClick={() => !chatLoading && setTab("search")}
                className={`px-6 py-3 text-sm font-medium transition-colors ${
                  tab === "search"
                    ? "border-b-2 border-blue-500 text-blue-600"
                    : chatLoading ? "text-gray-300 cursor-not-allowed" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                横断検索
              </button>
              <button
                onClick={() => !chatLoading && setTab("verify")}
                className={`px-6 py-3 text-sm font-medium transition-colors ${
                  tab === "verify"
                    ? "border-b-2 border-blue-500 text-blue-600"
                    : chatLoading ? "text-gray-300 cursor-not-allowed" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                突合せ
              </button>
              <button
                onClick={() => !chatLoading && setTab("documents")}
                className={`px-6 py-3 text-sm font-medium transition-colors ${
                  tab === "documents"
                    ? "border-b-2 border-blue-500 text-blue-600"
                    : chatLoading ? "text-gray-300 cursor-not-allowed" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                書類生成
              </button>
              <button
                onClick={() => !chatLoading && setTab("settings")}
                className={`px-6 py-3 text-sm font-medium transition-colors ${
                  tab === "settings"
                    ? "border-b-2 border-blue-500 text-blue-600"
                    : chatLoading ? "text-gray-300 cursor-not-allowed" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                設定
              </button>
        </div>
      </div>

      {/* メインコンテンツ */}
      <div className="flex-1 overflow-hidden">
        {tab === "chat" && <ChatWindow key={config?.selectedCompanyId || "none"} companyId={config?.selectedCompanyId} onLoadingChange={setChatLoading} />}
        {tab === "profile" && (
          <CompanyProfile
            key={config?.selectedCompanyId || "none"}
            company={selectedCompany || null}
            onUpdate={fetchConfig}
          />
        )}
        {tab === "organize" && <CaseOrganizer key={config?.selectedCompanyId || "none"} company={selectedCompany || null} />}
        {tab === "search" && <ChatWindow key="search" companyId="__search__" companies={config?.companies.map(c => ({ id: c.id, name: c.name })) || []} onLoadingChange={setChatLoading} onNavigateToCompany={handleNavigateToCompany} />}
        {tab === "verify" && <VerificationView key={config?.selectedCompanyId || "none"} company={selectedCompany || null} />}
        {tab === "documents" && <DocumentGenerator key={config?.selectedCompanyId || "none"} company={selectedCompany || null} />}
        {tab === "settings" && <SettingsView config={config} onAddCompanies={handleAddCompanies} onRemoveCompany={handleRemoveCompany} onUpdateConfig={fetchConfig} />}
      </div>
    </main>
  );
}
