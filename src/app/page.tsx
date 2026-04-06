"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { WorkspaceConfig } from "@/types";
import ChatWindow from "@/components/chat/ChatWindow";
import CompanyProfile from "@/components/CompanyProfile";
import DocumentGenerator from "@/components/DocumentGenerator";
import VerificationView from "@/components/VerificationView";
import CaseOrganizer from "@/components/CaseOrganizer";
import SettingsView from "@/components/SettingsView";
import FileSidebar from "@/components/FileSidebar";

// ChatWindowは横断検索でのみ使用

type MainTab = "main" | "profile" | "search" | "verify" | "documents" | "settings";

export default function Home() {
  const [tab, setTab] = useState<MainTab>("main");
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [executeTemplateId, setExecuteTemplateId] = useState<string | null>(null);
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

  // テンプレート→フォルダ推論結果でactive切替
  const handleSuggestFolders = async (folderIds: string[]) => {
    if (!config?.selectedCompanyId) return;
    const company = config.companies.find(c => c.id === config.selectedCompanyId);
    if (!company) return;
    // 案件フォルダを全部OFF→推論結果だけON
    for (const sub of company.subfolders) {
      if (sub.role === "job") {
        const shouldBeActive = folderIds.includes(sub.id);
        if (sub.active !== shouldBeActive) {
          await fetch("/api/workspace", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "toggleSubfolder", companyId: company.id, subfolderId: sub.id, active: shouldBeActive }),
          });
        }
      }
    }
    await fetchConfig();
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
            { id: "main", label: "案件整理" },
            { id: "profile", label: "基本情報" },
            { id: "verify", label: "突合せ" },
            { id: "documents", label: "書類生成" },
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
        <div className={tab === "main" ? "h-full" : "hidden"}><CaseOrganizer key={config?.selectedCompanyId || "none"} company={selectedCompany || null} executeTemplateId={executeTemplateId} onExecuteComplete={() => setExecuteTemplateId(null)} onSuggestFolders={handleSuggestFolders} visible={tab === "main"} onUpdate={fetchConfig} /></div>
        <div className={tab === "verify" ? "h-full" : "hidden"}><VerificationView key={config?.selectedCompanyId || "none"} company={selectedCompany || null} /></div>
        {tab === "profile" && (
          <CompanyProfile
            key={config?.selectedCompanyId || "none"}
            company={selectedCompany || null}
            onUpdate={fetchConfig}
          />
        )}
        {tab === "search" && <ChatWindow key="search" companyId="__search__" companies={config?.companies.map(c => ({ id: c.id, name: c.name })) || []} onLoadingChange={setChatLoading} onNavigateToCompany={handleNavigateToCompany} />}
        {tab === "documents" && <DocumentGenerator key={config?.selectedCompanyId || "none"} company={selectedCompany || null} />}
        {tab === "settings" && <SettingsView config={config} onUpdateConfig={fetchConfig} />}
        </div>
      </div>
    </main>
  );
}
