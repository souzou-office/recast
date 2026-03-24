"use client";

import { useState, useEffect, useCallback } from "react";
import type { WorkspaceConfig, Company } from "@/types";
import FolderSidebar from "@/components/folders/FolderSidebar";
import ChatWindow from "@/components/chat/ChatWindow";
import CompanyProfile from "@/components/CompanyProfile";
import CompanyRegistration from "@/components/folders/CompanyRegistration";
import DocumentGenerator from "@/components/DocumentGenerator";
import DocumentTemplateModal from "@/components/DocumentTemplateModal";

type MainTab = "chat" | "profile" | "search" | "documents";

export default function Home() {
  const [tab, setTab] = useState<MainTab>("chat");
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [showRegistration, setShowRegistration] = useState(false);
  const [showDocTemplates, setShowDocTemplates] = useState(false);
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
      <FolderSidebar onOpenRegistration={() => setShowRegistration(true)} onOpenDocTemplates={() => setShowDocTemplates(true)} />
      <div className="flex flex-1 flex-col min-w-0">
        {showRegistration ? (
          <CompanyRegistration
            companies={config?.companies || []}
            onAdd={handleAddCompanies}
            onRemove={handleRemoveCompany}
            onClose={() => setShowRegistration(false)}
          />
        ) : (
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
                onClick={() => !chatLoading && setTab("documents")}
                className={`px-6 py-3 text-sm font-medium transition-colors ${
                  tab === "documents"
                    ? "border-b-2 border-blue-500 text-blue-600"
                    : chatLoading ? "text-gray-300 cursor-not-allowed" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                書類生成
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
              {tab === "search" && <ChatWindow key="search" companyId="__search__" companies={config?.companies.map(c => ({ id: c.id, name: c.name })) || []} onLoadingChange={setChatLoading} onNavigateToCompany={handleNavigateToCompany} />}
              {tab === "documents" && <DocumentGenerator key={config?.selectedCompanyId || "none"} company={selectedCompany || null} />}
            </div>
          </>
        )}
      </div>

      {/* 書類雛形管理モーダル */}
      {showDocTemplates && (
        <DocumentTemplateModal onClose={() => setShowDocTemplates(false)} />
      )}
    </main>
  );
}
