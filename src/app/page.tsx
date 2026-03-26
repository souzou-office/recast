"use client";

import { useState, useEffect, useCallback } from "react";
import type { WorkspaceConfig, Company } from "@/types";
import FolderSidebar from "@/components/folders/FolderSidebar";
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
    <main className="flex h-screen">
      <FolderSidebar />
      <div className="flex flex-1 flex-col min-w-0">
          <>
            {/* タブ */}
            <div className="flex border-b border-gray-200 bg-white">
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

            {/* タブ内容 */}
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
          </>
      </div>
    </main>
  );
}
