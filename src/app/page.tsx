"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { WorkspaceConfig } from "@/types";
import ChatSidebar from "@/components/ChatSidebar";
import ChatWorkflow from "@/components/ChatWorkflow";
import CompanyProfile from "@/components/CompanyProfile";
import SettingsView from "@/components/SettingsView";
import ChatWindow from "@/components/chat/ChatWindow";
import { Icon } from "@/components/ui/Icon";

type MainView = "chat" | "profile" | "search" | "settings";

export default function Home() {
  const [view, setView] = useState<MainView>("chat");
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadsRefreshKey, setThreadsRefreshKey] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const resizing = useRef(false);

  // カードから「テンプレ解釈を確認する」が押されたら、設定タブに遷移してテンプレ解釈を開く。
  // SettingsView は sessionStorage の "recast-settings-target" を見て該当セクションに飛ぶ。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { section?: string; templateFolderPath?: string } | undefined;
      if (detail) {
        try { sessionStorage.setItem("recast-settings-target", JSON.stringify(detail)); } catch { /* ignore */ }
      }
      setView("settings");
    };
    window.addEventListener("recast:open-settings", handler);
    return () => window.removeEventListener("recast:open-settings", handler);
  }, []);

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

  // 共通フォルダ変更検知 → 基本情報を自動再生成（バックグラウンド）
  const autoRefreshProfile = useCallback(async (companyId: string) => {
    try {
      const check = await fetch(`/api/workspace/profile?companyId=${encodeURIComponent(companyId)}`);
      if (!check.ok) return;
      const { isStale } = await check.json();
      if (!isStale) return;
      const gen = await fetch("/api/workspace/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      if (gen.ok) fetchConfig();
    } catch { /* ignore */ }
  }, [fetchConfig]);

  // 初期ロード後、選択中の会社について鮮度チェック
  useEffect(() => {
    const id = config?.selectedCompanyId;
    if (id) autoRefreshProfile(id);
  }, [config?.selectedCompanyId, autoRefreshProfile]);

  const handleSelectCompany = async (companyId: string) => {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "selectCompany", companyId }),
    });
    setSelectedThreadId(null);
    await fetchConfig();
    // 鮮度チェックはselectedCompanyId変更のuseEffectで自動実行される
  };

  const handleNewThread = async () => {
    if (!config?.selectedCompanyId) return;
    // 画面はすぐチャットビューに切り替える
    setView("chat");
    const res = await fetch("/api/chat-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId: config.selectedCompanyId }),
    });
    if (res.ok) {
      const data = await res.json();
      setSelectedThreadId(data.thread.id);
      setThreadsRefreshKey(k => k + 1);
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
      <div className="flex items-center border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="px-4 shrink-0">
          <img src="/logo.png" alt="Recast" className="h-10" />
        </div>

        <div className="flex-1" />

        {/* タブ: チャット / 基本情報 */}
        <nav className="flex items-center gap-1">
          <button
            onClick={() => setView("chat")}
            className={`px-3.5 h-8 rounded-full text-[13px] transition-colors ${
              view === "chat" || view === "search"
                ? "bg-[var(--color-panel)] shadow-sm text-[var(--color-fg)] font-medium"
                : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            }`}
          >
            チャット
          </button>
          <button
            onClick={() => setView("profile")}
            className={`px-3.5 h-8 rounded-full text-[13px] transition-colors ${
              view === "profile"
                ? "bg-[var(--color-panel)] shadow-sm text-[var(--color-fg)] font-medium"
                : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            }`}
          >
            基本情報
          </button>
        </nav>

        {/* 右端: 横断検索・設定 */}
        <div className="flex items-center gap-1 px-3 shrink-0">
          <button
            onClick={() => setView(view === "search" ? "chat" : "search")}
            className={`rounded-lg p-2 transition-colors ${
              view === "search" ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]" : "text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
            }`}
            title="横断検索"
          >
            <Icon name="Search" size={14} />
          </button>
          <button
            onClick={() => setView(view === "settings" ? "chat" : "settings")}
            className={`rounded-lg p-2 transition-colors ${
              view === "settings" ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]" : "text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
            }`}
            title="設定"
          >
            <Icon name="Settings" size={15} />
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
              refreshKey={threadsRefreshKey}
            />
            <div
              onMouseDown={handleMouseDown}
              className="w-1 cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)] active:bg-[var(--color-accent-fg)] transition-colors"
            />
          </div>
        )}

        {/* メイン */}
        <div className="flex-1 overflow-hidden">
          {view === "chat" && (
            <ChatWorkflow
              company={selectedCompany || null}
              threadId={selectedThreadId}
              onThreadUpdate={() => setThreadsRefreshKey(k => k + 1)}
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
