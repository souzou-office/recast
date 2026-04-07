"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { WorkspaceConfig } from "@/types";
import ChatWindow from "@/components/chat/ChatWindow";
import CompanyProfile from "@/components/CompanyProfile";
import CaseRoomView from "@/components/CaseRoomView";
import SettingsView from "@/components/SettingsView";
import FileSidebar from "@/components/FileSidebar";

type MainTab = "chat" | "profile" | "cases" | "search" | "settings";

export default function Home() {
  const [tab, setTab] = useState<MainTab>("chat");
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const resizing = useRef(false);

  const handleMouseDown = useCallback(() => {
    resizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const newWidth = Math.max(180, Math.min(500, e.clientX));
      setSidebarWidth(newWidth);
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
    await fetchConfig();
  };

  const handleToggleJob = async (subfolderId: string, active: boolean) => {
    if (!config?.selectedCompanyId) return;
    // 単一選択: 選んだフォルダだけON、他は全部OFF
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "selectSingleJob",
        companyId: config.selectedCompanyId,
        subfolderId,
        active,
      }),
    });
    await fetchConfig();
  };

  const handleToggleFile = async (companyId: string, subfolderId: string, filePath: string, enabled: boolean) => {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggleFile", companyId, subfolderId, filePath, enabled }),
    });
    await fetchConfig();
  };

  const handleRemoveCompany = async (companyId: string) => {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "removeCompany", companyId }),
    });
    await fetchConfig();
  };

  const handleSelectSingleFolder = async (companyId: string, subfolderId: string, selectedPath: string, siblingPaths: string[]) => {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "selectSingleFolder", companyId, subfolderId, selectedPath, siblingPaths }),
    });
    await fetchConfig();
  };

  const handleChangeRole = async (companyId: string, subfolderId: string, newRole: string) => {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setSubfolderRole", companyId, subfolderId, role: newRole }),
    });
    await fetchConfig();
  };

  const handleNavigateToCompany = async (targetCompanyId: string) => {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "selectCompany", companyId: targetCompanyId }),
    });
    await fetchConfig();
    setTab("profile");
  };

  const showSidebar = tab !== "settings" && tab !== "search";

  return (
    <main className="flex h-screen flex-col">
      {/* ヘッダー: ロゴ + タブ + アイコン */}
      <div className="flex items-center border-b border-gray-200 bg-white">
        <div className="px-4 shrink-0">
          <img src="/logo.png" alt="Recast" className="h-10" />
        </div>

        {/* タブ */}
        <div className="flex flex-1 overflow-x-auto">
          {([
            { id: "chat", label: "チャット" },
            { id: "profile", label: "基本情報" },
          ] as { id: MainTab; label: string }[]).map(t => (
            <button
              key={t.id}
              onClick={() => !chatLoading && setTab(t.id)}
              className={`px-4 py-3 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "border-b-2 border-blue-500 text-blue-600"
                  : chatLoading ? "text-gray-300 cursor-not-allowed" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={() => !chatLoading && setTab("cases")}
            className={`mx-2 my-1.5 px-4 py-1.5 text-xs font-bold rounded-lg border-2 transition-colors ${
              tab === "cases"
                ? "border-blue-500 bg-blue-600 text-white shadow-sm"
                : chatLoading ? "border-gray-200 bg-gray-100 text-gray-300 cursor-not-allowed" : "border-blue-400 bg-blue-50 text-blue-700 hover:bg-blue-100"
            }`}
          >
            案件整理 → 書類作成 → チェック
          </button>
        </div>

        {/* 右端: 横断検索・設定アイコン */}
        <div className="flex items-center gap-1 px-3 shrink-0">
          <button
            onClick={() => !chatLoading && setTab("search")}
            className={`rounded-lg p-2 transition-colors ${
              tab === "search" ? "bg-blue-100 text-blue-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            }`}
            title="横断検索"
          >
            🔍
          </button>
          <button
            onClick={() => !chatLoading && setTab("settings")}
            className={`rounded-lg p-2 transition-colors ${
              tab === "settings" ? "bg-blue-100 text-blue-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            }`}
            title="設定"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* メインコンテンツ */}
      <div className="flex flex-1 overflow-hidden">
        {/* サイドバー: 会社選択 + ファイラー */}
        {showSidebar && (
          <div className="flex shrink-0" style={{ width: sidebarWidth }}>
            <FileSidebar
              companies={config?.companies || []}
              selectedCompanyId={config?.selectedCompanyId || null}
              onSelectCompany={handleSelectCompany}
              onToggleJob={handleToggleJob}
              onToggleFile={handleToggleFile}
              onSelectSingleFolder={handleSelectSingleFolder}
              onChangeRole={handleChangeRole}
              onRemoveCompany={handleRemoveCompany}
            />
            {/* リサイズハンドル */}
            <div
              onMouseDown={handleMouseDown}
              className="w-1 cursor-col-resize hover:bg-blue-300 active:bg-blue-400 transition-colors"
            />
          </div>
        )}
        <div className="flex-1 overflow-hidden">
        {/* メインタブは非表示で保持（状態維持） */}
        <div className={tab === "chat" ? "h-full" : "hidden"}><ChatWindow key={config?.selectedCompanyId || "none"} companyId={config?.selectedCompanyId} onLoadingChange={setChatLoading} /></div>
        {tab === "profile" && (
          <CompanyProfile
            key={config?.selectedCompanyId || "none"}
            company={selectedCompany || null}
            onUpdate={fetchConfig}
          />
        )}
        <div className={tab === "cases" ? "h-full" : "hidden"}><CaseRoomView key={config?.selectedCompanyId || "none"} company={selectedCompany || null} onUpdate={fetchConfig} /></div>
        {tab === "search" && <ChatWindow key="search" companyId="__search__" companies={config?.companies.map(c => ({ id: c.id, name: c.name })) || []} onLoadingChange={setChatLoading} onNavigateToCompany={handleNavigateToCompany} />}
        {tab === "settings" && <SettingsView config={config} onUpdateConfig={fetchConfig} />}
        </div>
      </div>
    </main>
  );
}
