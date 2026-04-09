"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { WorkspaceConfig } from "@/types";
import ChatSidebar from "@/components/ChatSidebar";
import ChatWorkflow from "@/components/ChatWorkflow";
import CompanyProfile from "@/components/CompanyProfile";
import SettingsView from "@/components/SettingsView";
import ChatWindow from "@/components/chat/ChatWindow";

type MainView = "chat" | "profile" | "search" | "settings";

export default function Home() {
  const [view, setView] = useState<MainView>("chat");
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const resizing = useRef(false);

  const handleMouseDown = useCallback(() => {
    resizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      setSidebarWidth(Math.max(160, Math.min(400, e.clientX)));
    };
    const handleMouseUp = () => {
      resizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  const fetchConfig = useCallback(async () => {
    const res = await fetch("/api/workspace");
    if (res.ok) setConfig(await res.json());
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const selectedCompany = config?.companies.find(c => c.id === config.selectedCompanyId);

  const handleSelectCompany = async (companyId: string) => {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "selectCompany", companyId }),
    });
    setSelectedThreadId(null);
    await fetchConfig();
  };

  const handleNewThread = async () => {
    if (!config?.selectedCompanyId) return;
    const res = await fetch("/api/chat-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId: config.selectedCompanyId }),
    });
    if (res.ok) {
      const data = await res.json();
      setSelectedThreadId(data.thread.id);
      setView("chat");
    }
  };

  const handleNavigateToCompany = async (targetCompanyId: string) => {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "selectCompany", companyId: targetCompanyId }),
    });
    await fetchConfig();
    setView("profile");
  };

  return (
    <main className="flex h-screen flex-col">
      {/* ヘッダー */}
      <div className="flex items-center border-b border-gray-200 bg-white">
        <div className="px-4 shrink-0">
          <img src="/logo.png" alt="Recast" className="h-10" />
        </div>

        <div className="flex-1" />

        {/* 基本情報ボタン */}
        <button
          onClick={() => setView(view === "profile" ? "chat" : "profile")}
          className={`px-4 py-3 text-sm font-medium transition-colors ${
            view === "profile" ? "border-b-2 border-blue-500 text-blue-600" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          基本情報
        </button>

        {/* 右端: 横断検索・設定 */}
        <div className="flex items-center gap-1 px-3 shrink-0">
          <button
            onClick={() => setView(view === "search" ? "chat" : "search")}
            className={`rounded-lg p-2 transition-colors ${
              view === "search" ? "bg-blue-100 text-blue-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            }`}
            title="横断検索"
          >
            🔍
          </button>
          <button
            onClick={() => setView(view === "settings" ? "chat" : "settings")}
            className={`rounded-lg p-2 transition-colors ${
              view === "settings" ? "bg-blue-100 text-blue-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            }`}
            title="設定"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* メインコンテンツ */}
      <div className="flex flex-1 overflow-hidden">
        {/* サイドバー */}
        {view !== "settings" && (
          <div className="flex shrink-0" style={{ width: sidebarWidth }}>
            <ChatSidebar
              companies={config?.companies || []}
              selectedCompanyId={config?.selectedCompanyId || null}
              onSelectCompany={handleSelectCompany}
              selectedThreadId={selectedThreadId}
              onSelectThread={(id) => { setSelectedThreadId(id); setView("chat"); }}
              onNewThread={handleNewThread}
            />
            <div
              onMouseDown={handleMouseDown}
              className="w-1.5 cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors"
            />
          </div>
        )}

        {/* メイン */}
        <div className="flex-1 overflow-hidden">
          {view === "chat" && (
            <ChatWorkflow
              company={selectedCompany || null}
              threadId={selectedThreadId}
              onThreadUpdate={() => {}}
            />
          )}
          {view === "profile" && (
            <CompanyProfile
              key={config?.selectedCompanyId || "none"}
              company={selectedCompany || null}
              onUpdate={fetchConfig}
            />
          )}
          {view === "search" && (
            <ChatWindow
              key="search"
              companyId="__search__"
              companies={config?.companies.map(c => ({ id: c.id, name: c.name })) || []}
              onLoadingChange={setChatLoading}
              onNavigateToCompany={handleNavigateToCompany}
            />
          )}
          {view === "settings" && (
            <SettingsView config={config} onUpdateConfig={fetchConfig} />
          )}
        </div>
      </div>
    </main>
  );
}
