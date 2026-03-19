"use client";

import { useState, useEffect, useCallback } from "react";
import type { WorkspaceConfig } from "@/types";
import FolderSidebar from "@/components/folders/FolderSidebar";
import ChatWindow from "@/components/chat/ChatWindow";
import CompanyProfile from "@/components/CompanyProfile";

type MainTab = "chat" | "profile";

export default function Home() {
  const [tab, setTab] = useState<MainTab>("chat");
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);

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

  return (
    <main className="flex h-screen">
      <FolderSidebar />
      <div className="flex flex-1 flex-col min-w-0">
        {/* タブ */}
        <div className="flex border-b border-gray-200 bg-white">
          <button
            onClick={() => setTab("chat")}
            className={`px-6 py-3 text-sm font-medium transition-colors ${
              tab === "chat"
                ? "border-b-2 border-blue-500 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            チャット
          </button>
          <button
            onClick={() => setTab("profile")}
            className={`px-6 py-3 text-sm font-medium transition-colors ${
              tab === "profile"
                ? "border-b-2 border-blue-500 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            基本情報
          </button>
        </div>

        {/* タブ内容 */}
        <div className="flex-1 overflow-hidden">
          {tab === "chat" && <ChatWindow />}
          {tab === "profile" && (
            <CompanyProfile
              company={selectedCompany || null}
              onUpdate={fetchConfig}
            />
          )}
        </div>
      </div>
    </main>
  );
}
