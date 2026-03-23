"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { WorkspaceConfig, Company, Subfolder, SubfolderRole } from "@/types";
import CloudStatus from "./CloudStatus";
import FolderBrowser from "./FolderBrowser";
import CompanyMainView from "./CompanyMainView";
import CommonPatternsModal from "./CommonPatternsModal";

type View = "main" | "pickBase" | "setup";

export default function FolderSidebar() {
  const [config, setConfig] = useState<WorkspaceConfig>({
    baseFolders: [],
    globalCommon: [],
    defaultCommonPatterns: [],
    companies: [],
    selectedCompanyId: null,
  });
  const [view, setView] = useState<View>("main");
  const [companyDropdownOpen, setCompanyDropdownOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanningAll, setScanningAll] = useState(false);
  const [scanProgress, setScanProgress] = useState("");
  const [showPatternsModal, setShowPatternsModal] = useState(false);
  const [setupCompany, setSetupCompany] = useState<Company | null>(null);
  const [setupFolders, setSetupFolders] = useState<{ id: string; name: string }[]>([]);
  const [setupFiles, setSetupFiles] = useState<{ name: string; mimeType: string }[]>([]);
  const [setupBreadcrumbs, setSetupBreadcrumbs] = useState<{ id: string; name: string }[]>([]);
  const [setupScanning, setSetupScanning] = useState(false);
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

  // ルートフォルダ追加
  const handleAddBase = async (folderId: string, folderName?: string) => {
    const res = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId, name: folderName || folderId, provider: "google" }),
    });
    if (res.ok) {
      const data = await res.json();
      setConfig(data);
      setView("main");
      // 新しく追加したルートの会社をスキャン
      scanCompanies(folderId, "google", data);
    }
  };

  // ルートフォルダ削除
  const handleRemoveBase = async (baseFolderId: string) => {
    if (!confirm("このルートフォルダと配下の会社を削除しますか？")) return;
    await patchConfig({ action: "removeBaseFolder", baseFolderId });
  };

  // 会社一覧スキャン（1ルート分）
  const scanCompanies = async (folderId: string, provider: string, currentConfig?: WorkspaceConfig) => {
    setScanning(true);
    try {
      const res = await fetch("/api/workspace/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId, provider }),
      });
      if (res.ok) {
        const { folders } = await res.json();
        const cfg = currentConfig || config;
        const existingIds = new Set(cfg.companies.map(c => c.id));
        const newCompanies: Company[] = [...cfg.companies];
        // このルートのbaseFolderIdを特定
        const base = cfg.baseFolders.find(b => b.folderId === folderId);
        for (const f of folders) {
          if (!existingIds.has(f.id)) {
            newCompanies.push({ id: f.id, name: f.name, subfolders: [], baseFolderId: base?.id });
          }
        }
        await patchConfig({ action: "setCompanies", companies: newCompanies });
      }
    } catch { /* ignore */ }
    finally { setScanning(false); }
  };

  // 全ルートの会社を更新
  const scanAllCompanies = async () => {
    setScanning(true);
    try {
      for (const base of config.baseFolders) {
        await scanCompanies(base.folderId, base.provider, config);
      }
    } catch { /* ignore */ }
    finally { setScanning(false); }
  };

  // 共通フォルダパターン保存
  const handleSavePatterns = async (patterns: string[]) => {
    await patchConfig({ action: "setDefaultCommonPatterns", patterns });
    setShowPatternsModal(false);
  };

  // パターン保存 + 全社一括スキャン（SSE）
  const handleSavePatternsAndScanAll = async (patterns: string[], reset: boolean) => {
    await patchConfig({ action: "setDefaultCommonPatterns", patterns });
    setScanningAll(true);
    setScanProgress("開始中...");
    try {
      const res = await fetch("/api/workspace/scan-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset }),
      });
      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const match = line.match(/^data: (.+)$/m);
          if (!match) continue;
          const data = JSON.parse(match[1]);

          if (data.type === "progress") {
            setScanProgress(`${data.current}/${data.total} ${data.message}`);
          } else if (data.type === "done") {
            setConfig(data.config);
          }
        }
      }
    } catch { /* ignore */ }
    finally {
      setScanningAll(false);
      setScanProgress("");
      setShowPatternsModal(false);
    }
  };

  // 会社選択
  const handleSelectCompany = async (companyId: string) => {
    await patchConfig({ action: "selectCompany", companyId });
    setCompanyDropdownOpen(false);
    setSearchQuery("");
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

  // --- 設定モード ---
  const openSetup = (company: Company) => {
    setSetupCompany(company);
    setSetupBreadcrumbs([{ id: company.id, name: company.name }]);
    setView("setup");
    const isFirstTime = company.subfolders.length === 0;
    loadSetupFolders(company.id, isFirstTime);
  };

  const loadSetupFolders = async (folderId: string, autoApplyPatterns?: boolean) => {
    setSetupScanning(true);
    try {
      // setupCompanyのproviderを特定
      const company = setupCompany || config.companies.find(c => c.id === folderId);
      const base = config.baseFolders.find(b => b.id === company?.baseFolderId);
      const provider = base?.provider || "google";

      const res = await fetch("/api/workspace/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId, provider }),
      });
      if (res.ok) {
        const { folders, files: scannedFiles } = await res.json();
        setSetupFolders(folders);
        setSetupFiles(scannedFiles || []);

        // デフォルトパターンを自動適用
        if (autoApplyPatterns && setupCompany && config.defaultCommonPatterns?.length > 0) {
          const latest = config.companies.find(c => c.id === setupCompany.id);
          if (latest && latest.subfolders.length === 0) {
            const newSubs: Subfolder[] = [];
            for (const f of folders) {
              const isCommon = config.defaultCommonPatterns.some(
                (p: string) => f.name.toLowerCase().includes(p.toLowerCase())
              );
              newSubs.push({
                id: f.id,
                name: f.name,
                role: isCommon ? "common" : "job",
                active: isCommon,
              });
            }
            await patchConfig({ action: "setSubfolders", companyId: setupCompany.id, subfolders: newSubs });
          }
        }
      }
    } catch { /* ignore */ }
    finally { setSetupScanning(false); }
  };

  const handleSetupDrill = (folder: { id: string; name: string }) => {
    setSetupBreadcrumbs(prev => [...prev, folder]);
    loadSetupFolders(folder.id);
  };

  const handleSetupBreadcrumb = (index: number) => {
    const bc = setupBreadcrumbs.slice(0, index + 1);
    setSetupBreadcrumbs(bc);
    loadSetupFolders(bc[bc.length - 1].id);
  };

  const handleSetRole = async (folderId: string, folderName: string, role: SubfolderRole) => {
    if (!setupCompany) return;
    const latest = config.companies.find(c => c.id === setupCompany.id);
    const subs = latest?.subfolders || [];
    const existing = subs.find(s => s.id === folderId);
    if (existing) {
      await patchConfig({ action: "setSubfolderRole", companyId: setupCompany.id, subfolderId: folderId, role });
    } else {
      const newSub: Subfolder = { id: folderId, name: folderName, role, active: role === "common" };
      const subfolders = [...subs, newSub];
      await patchConfig({ action: "setSubfolders", companyId: setupCompany.id, subfolders });
    }

    // 共通に設定したとき、デフォルトパターンに追加するか確認
    if (role === "common") {
      const patterns = config.defaultCommonPatterns || [];
      const alreadyInPatterns = patterns.some(p => folderName.toLowerCase().includes(p.toLowerCase()));
      if (!alreadyInPatterns) {
        const apply = confirm(`「${folderName}」を全会社の共通フォルダに設定しますか？`);
        if (apply) {
          await patchConfig({ action: "setDefaultCommonPatterns", patterns: [...patterns, folderName] });
          await patchConfig({ action: "applyDefaultCommon" });
        }
      }
    }
  };

  const handleRemoveSub = async (subfolderId: string) => {
    if (!setupCompany) return;
    const latest = config.companies.find(c => c.id === setupCompany.id);
    const subfolders = (latest?.subfolders || []).filter(s => s.id !== subfolderId);
    await patchConfig({ action: "setSubfolders", companyId: setupCompany.id, subfolders });
  };

  // configが変わったらsetupCompanyも更新
  const currentSetupCompany = setupCompany
    ? config.companies.find(c => c.id === setupCompany.id) || setupCompany
    : null;

  // フィルタリング（全ルートの会社をまとめて表示）
  const filteredCompanies = config.companies
    .filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  // --- 設定モード画面 ---
  if (view === "setup" && currentSetupCompany) {
    const commonSubs = currentSetupCompany.subfolders.filter(s => s.role === "common");
    const jobSubs = currentSetupCompany.subfolders.filter(s => s.role === "job");

    return (
      <aside className="flex h-full w-72 flex-col border-r border-gray-200 bg-gray-50">
        <div className="border-b border-gray-200 p-4">
          <button onClick={() => setView("main")} className="mb-1 text-xs text-blue-600 hover:text-blue-800">
            ← 戻る
          </button>
          <h2 className="text-sm font-bold text-gray-800 truncate">{currentSetupCompany.name}</h2>
          <p className="text-[10px] text-gray-400">フォルダの役割を設定</p>
        </div>

        {/* 登録済み */}
        {(commonSubs.length > 0 || jobSubs.length > 0) && (
          <div className="border-b border-gray-200 px-4 py-3">
            {commonSubs.length > 0 && (
              <div className="mb-2">
                <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-green-600">常時参照</h3>
                <ul className="space-y-0.5">
                  {commonSubs.map(s => (
                    <li key={s.id} className="group flex items-center justify-between rounded px-1.5 py-0.5 hover:bg-gray-200">
                      <span className="text-xs text-gray-700">{s.name}</span>
                      <button onClick={() => handleRemoveSub(s.id)} className="hidden text-[10px] text-red-400 group-hover:block">解除</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {jobSubs.length > 0 && (
              <div>
                <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-blue-600">案件</h3>
                <ul className="space-y-0.5">
                  {jobSubs.map(s => (
                    <li key={s.id} className="group flex items-center justify-between rounded px-1.5 py-0.5 hover:bg-gray-200">
                      <span className="text-xs text-gray-700">{s.name}</span>
                      <button onClick={() => handleRemoveSub(s.id)} className="hidden text-[10px] text-red-400 group-hover:block">解除</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* パンくず */}
        <div className="flex flex-wrap items-center gap-1 border-b border-gray-100 px-4 py-2">
          {setupBreadcrumbs.map((bc, i) => (
            <span key={bc.id} className="flex items-center gap-1">
              {i > 0 && <span className="text-gray-300 text-[10px]">/</span>}
              <button
                onClick={() => handleSetupBreadcrumb(i)}
                className={`text-[10px] truncate max-w-[80px] ${i === setupBreadcrumbs.length - 1 ? "text-gray-700 font-medium" : "text-blue-600"}`}
              >{i === 0 ? "root" : bc.name}</button>
            </span>
          ))}
        </div>

        {/* フォルダ一覧 */}
        <div className="flex-1 overflow-y-auto p-2">
          {setupScanning ? (
            <p className="py-4 text-center text-xs text-gray-400">読み込み中...</p>
          ) : setupFolders.length === 0 ? (
            <p className="py-4 text-center text-xs text-gray-400">サブフォルダなし</p>
          ) : (
            <ul className="space-y-0.5">
              {setupFolders.map(folder => {
                const sub = currentSetupCompany.subfolders.find(s => s.id === folder.id);
                return (
                  <li key={folder.id} className="group flex items-center rounded-lg hover:bg-gray-100">
                    <button
                      onClick={() => handleSetupDrill(folder)}
                      className="flex-1 flex items-center gap-2 px-2 py-1.5 text-left text-sm text-gray-700"
                    >
                      <span className="shrink-0 text-yellow-500 text-xs">&#128193;</span>
                      <span className="truncate">{folder.name}</span>
                      {sub && (
                        <span className={`shrink-0 rounded px-1 text-[10px] ${sub.role === "common" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>
                          {sub.role === "common" ? "共通" : "案件"}
                        </span>
                      )}
                    </button>
                    <div className="hidden shrink-0 gap-1 pr-2 group-hover:flex">
                      {(!sub || sub.role !== "common") && (
                        <button onClick={() => handleSetRole(folder.id, folder.name, "common")} className="rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-700 hover:bg-green-100">共通</button>
                      )}
                      {(!sub || sub.role !== "job") && (
                        <button onClick={() => handleSetRole(folder.id, folder.name, "job")} className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700 hover:bg-blue-100">案件</button>
                      )}
                    </div>
                  </li>
                );
              })}
              {setupFiles.length > 0 && (
                <>
                  <li className="border-t border-gray-100 mt-1 pt-1">
                    <span className="px-2 py-1 text-[10px] text-gray-400">ファイル</span>
                  </li>
                  {setupFiles.map((file, i) => (
                    <li key={`file-${i}`}
                        className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs text-gray-400">
                      <span className="shrink-0">
                        {file.mimeType.includes("pdf") ? "📄" :
                         file.mimeType.includes("word") || file.mimeType.includes("document") ? "📝" :
                         file.mimeType.includes("sheet") || file.mimeType.includes("excel") ? "📊" :
                         file.mimeType.includes("image") ? "🖼️" : "📎"}
                      </span>
                      <span className="truncate">{file.name}</span>
                    </li>
                  ))}
                </>
              )}
            </ul>
          )}
        </div>
      </aside>
    );
  }

  // --- メイン画面 ---
  return (
    <aside className="flex h-full w-72 flex-col border-r border-gray-200 bg-gray-50">
      {/* ヘッダー */}
      <div className="border-b border-gray-200 px-4 py-2 flex justify-center">
        <img src="/logo.png" alt="Recast" className="h-11" />
      </div>

      {/* ルートフォルダ未設定 */}
      {config.baseFolders.length === 0 ? (
        <>
          <div className="flex-1 p-4">
            <button
              onClick={() => setView("pickBase")}
              className="w-full rounded-lg border border-dashed border-gray-300 py-4 text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
            >
              ルートフォルダを追加
            </button>
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
              onOpenSetup={() => openSetup(selectedCompany)}
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

          {/* ルートフォルダ一覧 */}
          <div className="border-t border-gray-200 px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-gray-400">ルートフォルダ</span>
              <button
                onClick={() => setView("pickBase")}
                className="text-[10px] text-blue-500 hover:text-blue-700"
              >
                + 追加
              </button>
            </div>
            {config.baseFolders.map(b => (
              <div key={b.id} className="group flex items-center justify-between rounded px-1.5 py-0.5 hover:bg-gray-100">
                <span className="text-[10px] text-gray-600 truncate">{b.name}</span>
                <button
                  onClick={() => handleRemoveBase(b.id)}
                  className="hidden text-[10px] text-red-400 group-hover:block"
                >
                  削除
                </button>
              </div>
            ))}
          </div>

          {/* フッター: 設定 */}
          <div className="border-t border-gray-200 p-3">
            <div className="flex gap-3">
              <button
                onClick={() => setShowPatternsModal(true)}
                className="flex-1 text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
              >
                共通フォルダ
              </button>
              <button
                onClick={scanAllCompanies}
                disabled={scanning}
                className="flex-1 text-[10px] text-gray-400 hover:text-gray-600 transition-colors disabled:text-gray-300"
              >
                {scanning ? "更新中..." : "会社更新"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* フォルダブラウザ */}
      {view === "pickBase" && (
        <FolderBrowser
          provider="google"
          onSelect={(path, name) => handleAddBase(path, name)}
          onClose={() => setView("main")}
        />
      )}

      {/* 共通フォルダ設定 */}
      {showPatternsModal && (
        <CommonPatternsModal
          patterns={config.defaultCommonPatterns || []}
          onSave={handleSavePatterns}
          onScanAll={handleSavePatternsAndScanAll}
          scanning={scanningAll}
          scanProgress={scanProgress}
          onClose={() => setShowPatternsModal(false)}
        />
      )}
    </aside>
  );
}
