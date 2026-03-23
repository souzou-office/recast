"use client";

import { useState, useEffect, useCallback } from "react";
import type { WorkspaceConfig, Company } from "@/types";
import FolderSidebar from "@/components/folders/FolderSidebar";
import ChatWindow from "@/components/chat/ChatWindow";
import CompanyProfile from "@/components/CompanyProfile";
import CompanyRegistration from "@/components/folders/CompanyRegistration";

type MainTab = "chat" | "profile";

export default function Home() {
  const [tab, setTab] = useState<MainTab>("chat");
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [showRegistration, setShowRegistration] = useState(false);
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

  return (
    <main className="flex h-screen">
      <FolderSidebar onOpenRegistration={() => setShowRegistration(true)} />
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
            </div>

            {/* タブ内容 */}
            <div className="flex-1 overflow-hidden">
              {tab === "chat" && <ChatWindow onLoadingChange={setChatLoading} />}
              {tab === "profile" && (
                <CompanyProfile
                  company={selectedCompany || null}
                  onUpdate={fetchConfig}
                />
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
