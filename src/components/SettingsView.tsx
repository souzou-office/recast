"use client";

import { useState, useEffect, useCallback } from "react";
import type { WorkspaceConfig } from "@/types";
import TemplateLabelsSection from "./TemplateLabelsSection";

import { Icon } from "./ui/Icon";
type SettingsSection = "basepath" | "templatepath" | "common" | "template-labels";

interface BrowseDir {
  name: string;
  path: string;
}

interface Props {
  config: WorkspaceConfig | null;
  onUpdateConfig: () => void;
}

export default function SettingsView({ config, onUpdateConfig }: Props) {
  const [section, setSection] = useState<SettingsSection>("basepath");
  const [saving, setSaving] = useState(false);
  const [patternInput, setPatternInput] = useState("");

  // フォルダブラウザ
  const [browseDirs, setBrowseDirs] = useState<BrowseDir[]>([]);
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseCurrent, setBrowseCurrent] = useState<string>("");
  const [browseLoading, setBrowseLoading] = useState(false);
  const [breadcrumbs, setBreadcrumbs] = useState<{ name: string; path: string }[]>([]);

  const sections: { id: SettingsSection; label: string }[] = [
    { id: "basepath", label: "ベースフォルダ" },
    { id: "templatepath", label: "書類テンプレート" },
    { id: "template-labels", label: "テンプレート解釈" },
    { id: "common", label: "共通パターン" },
  ];

  // フォルダブラウズ
  const browse = useCallback(async (dirPath?: string) => {
    setBrowseLoading(true);
    try {
      const params = dirPath ? `?path=${encodeURIComponent(dirPath)}` : "";
      const res = await fetch(`/api/browse-local${params}`);
      if (res.ok) {
        const data = await res.json();
        setBrowseDirs(data.dirs || []);
        setBrowseParent(data.parent);
        setBrowseCurrent(data.current || "");
      }
    } catch { /* ignore */ }
    setBrowseLoading(false);
  }, []);

  // 初回読み込み
  useEffect(() => {
    if (section === "basepath") {
      if (config?.basePath) {
        // 既存basePath → その親を表示
        browse(config.basePath);
        const parts = config.basePath.replace(/\\/g, "/").split("/").filter(Boolean);
        const crumbs: { name: string; path: string }[] = [];
        let acc = "";
        for (const p of parts) {
          acc += (acc.endsWith("\\") || acc.endsWith("/") || acc === "") ? p : `/${p}`;
          if (acc.length <= 3) acc += "\\"; // C:\ のような形
          crumbs.push({ name: p, path: acc });
        }
        setBreadcrumbs(crumbs);
      } else {
        browse();
        setBreadcrumbs([]);
      }
    }
  }, [section]);

  const navigateTo = (dirPath: string, dirName: string) => {
    browse(dirPath);
    setBreadcrumbs(prev => [...prev, { name: dirName, path: dirPath }]);
  };

  const navigateBreadcrumb = (index: number) => {
    if (index < 0) {
      browse();
      setBreadcrumbs([]);
    } else {
      const bc = breadcrumbs.slice(0, index + 1);
      setBreadcrumbs(bc);
      browse(bc[bc.length - 1].path);
    }
  };

  const navigateUp = () => {
    if (breadcrumbs.length > 1) {
      navigateBreadcrumb(breadcrumbs.length - 2);
    } else {
      navigateBreadcrumb(-1);
    }
  };

  const [selectedPaths, setSelectedPaths] = useState<string[]>(config?.basePaths || []);

  // パスを追加
  const handleAddPath = (dirPath: string) => {
    if (!selectedPaths.includes(dirPath)) {
      setSelectedPaths(prev => [...prev, dirPath]);
    }
  };

  // パスを削除
  const handleRemovePath = (dirPath: string) => {
    setSelectedPaths(prev => prev.filter(p => p !== dirPath));
  };

  // 保存（会社も同期）
  const handleSavePaths = async () => {
    setSaving(true);
    await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ basePaths: selectedPaths }),
    });
    onUpdateConfig();
    setSaving(false);
  };

  // 共通パターン
  const handleSavePatterns = async (patterns: string[]) => {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setDefaultCommonPatterns", patterns }),
    });
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "applyDefaultCommon" }),
    });
    onUpdateConfig();
  };

  const handleAddPattern = () => {
    if (!patternInput.trim()) return;
    const current = config?.defaultCommonPatterns || [];
    if (!current.includes(patternInput.trim())) {
      handleSavePatterns([...current, patternInput.trim()]);
    }
    setPatternInput("");
  };

  const handleRemovePattern = (pattern: string) => {
    const current = config?.defaultCommonPatterns || [];
    handleSavePatterns(current.filter(p => p !== pattern));
  };

  const companies = (config?.companies || []).slice().sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex h-full">
      {/* 左: メニュー */}
      <div className="w-48 border-r border-[var(--color-border)] bg-[var(--color-hover)] p-4">
        <h2 className="text-sm font-bold text-[var(--color-fg)] mb-4">設定</h2>
        <nav className="space-y-1">
          {sections.map(s => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors ${
                section === s.id
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] font-medium"
                  : "text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </div>

      {/* 右: 内容 */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {section === "basepath" && (
          <div className="flex flex-col h-full">
            <div className="px-6 pt-6 pb-3">
              <h2 className="text-lg font-semibold text-[var(--color-fg)] mb-1">ベースフォルダ</h2>
              <p className="text-xs text-[var(--color-fg-muted)]">
                会社フォルダが入っている親フォルダを選択してください（複数可）。直下の各フォルダが会社として自動登録されます。
              </p>
              {/* 選択済みパス一覧 */}
              {selectedPaths.length > 0 && (
                <div className="mt-2 space-y-1">
                  {selectedPaths.map(p => (
                    <div key={p} className="flex items-center gap-2 rounded bg-[var(--color-accent-soft)] px-2 py-1">
                      <span className="text-xs text-[var(--color-accent-fg)] truncate flex-1">{p}</span>
                      <button onClick={() => handleRemovePath(p)} className="text-xs text-red-400 hover:text-red-600 shrink-0 px-2 py-0.5 rounded hover:bg-red-50">削除</button>
                    </div>
                  ))}
                  <button
                    onClick={handleSavePaths}
                    disabled={saving}
                    className="mt-1 rounded-lg bg-[var(--color-fg)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:bg-gray-300"
                  >
                    {saving ? "反映中..." : "保存して会社を更新"}
                  </button>
                </div>
              )}
            </div>

            {/* パンくず */}
            <div className="flex flex-wrap items-center gap-1 border-y border-[var(--color-border-soft)] px-6 py-2 bg-[var(--color-hover)]">
              <button
                onClick={() => navigateBreadcrumb(-1)}
                className={`text-xs ${breadcrumbs.length === 0 ? "text-[var(--color-fg)] font-medium" : "text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]"}`}
              >
                PC
              </button>
              {breadcrumbs.map((bc, i) => (
                <span key={bc.path} className="flex items-center gap-1">
                  <span className="text-[var(--color-fg-subtle)] text-xs">/</span>
                  <button
                    onClick={() => navigateBreadcrumb(i)}
                    className={`text-xs truncate max-w-[120px] ${i === breadcrumbs.length - 1 ? "text-[var(--color-fg)] font-medium" : "text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]"}`}
                  >
                    {bc.name}
                  </button>
                </span>
              ))}
              {browseCurrent && (
                <button
                  onClick={() => handleAddPath(browseCurrent)}
                  disabled={selectedPaths.includes(browseCurrent)}
                  className="ml-auto rounded-lg bg-[var(--color-fg)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:bg-gray-300 transition-colors"
                >
                  {selectedPaths.includes(browseCurrent) ? "追加済み" : "このフォルダを追加"}
                </button>
              )}
            </div>

            {/* フォルダ一覧 */}
            <div className="flex-1 overflow-y-auto px-6 py-2">
              {browseLoading ? (
                <p className="py-4 text-center text-sm text-[var(--color-fg-subtle)]">読み込み中...</p>
              ) : (
                <ul>
                  {browseParent !== null && (
                    <li>
                      <button
                        onClick={navigateUp}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
                      >
                        <span>↑</span> 上の階層へ
                      </button>
                    </li>
                  )}
                  {browseDirs.map(dir => (
                    <li key={dir.path}>
                      <button
                        onClick={() => navigateTo(dir.path, dir.name)}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
                      >
                        <Icon name="Folder" size={13} className="text-[var(--color-fg-muted)] shrink-0" />
                        <span className="truncate">{dir.name}</span>
                      </button>
                    </li>
                  ))}
                  {browseDirs.length === 0 && !browseLoading && (
                    <li className="py-4 text-center text-sm text-[var(--color-fg-subtle)]">フォルダがありません</li>
                  )}
                </ul>
              )}
            </div>

            {/* 登録済み会社 */}
            {companies.length > 0 && (
              <div className="border-t border-[var(--color-border)] px-6 py-3 bg-[var(--color-hover)] max-h-40 overflow-y-auto">
                <p className="text-[10px] text-[var(--color-fg-subtle)] mb-1">登録済み会社（{companies.length}社）</p>
                <div className="flex flex-wrap gap-1">
                  {companies.map(c => (
                    <span key={c.id} className="text-[11px] text-[var(--color-fg-muted)] bg-[var(--color-panel)] rounded px-2 py-0.5 border border-[var(--color-border)]">
                      {c.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {section === "templatepath" && (
          <div className="flex flex-col h-full">
            <div className="px-6 pt-6 pb-3">
              <h2 className="text-lg font-semibold text-[var(--color-fg)] mb-1">書類テンプレートフォルダ</h2>
              <p className="text-xs text-[var(--color-fg-muted)]">
                書類の雛形フォルダを選択してください。各サブフォルダが書類テンプレートになります。
              </p>
              {config?.templateBasePath && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-[var(--color-fg-muted)]">現在:</span>
                  <span className="text-xs font-medium text-[var(--color-accent)] truncate">{config.templateBasePath}</span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1 border-y border-[var(--color-border-soft)] px-6 py-2 bg-[var(--color-hover)]">
              <button onClick={() => { navigateBreadcrumb(-1); }} className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]">PC</button>
              {breadcrumbs.map((bc, i) => (
                <span key={bc.path} className="flex items-center gap-1">
                  <span className="text-[var(--color-fg-subtle)] text-xs">/</span>
                  <button onClick={() => navigateBreadcrumb(i)} className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] truncate max-w-[120px]">{bc.name}</button>
                </span>
              ))}
              {browseCurrent && (
                <button
                  onClick={async () => {
                    setSaving(true);
                    await fetch("/api/workspace", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "setTemplateBasePath", templateBasePath: browseCurrent }),
                    });
                    onUpdateConfig();
                    setSaving(false);
                  }}
                  disabled={saving}
                  className="ml-auto rounded-lg bg-[var(--color-fg)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:bg-gray-300"
                >
                  {saving ? "設定中..." : "このフォルダに設定"}
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-2">
              {browseLoading ? (
                <p className="py-4 text-center text-sm text-[var(--color-fg-subtle)]">読み込み中...</p>
              ) : (
                <ul>
                  {browseParent !== null && (
                    <li><button onClick={navigateUp} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] w-full text-left">↑ 上の階層へ</button></li>
                  )}
                  {browseDirs.map(dir => (
                    <li key={dir.path}>
                      <button onClick={() => navigateTo(dir.path, dir.name)} className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-hover)] w-full text-left">
                        <Icon name="Folder" size={13} className="text-[var(--color-fg-muted)] shrink-0" /><span className="truncate">{dir.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {section === "common" && (
          <div className="p-6">
            <h2 className="text-lg font-semibold text-[var(--color-fg)] mb-2">共通フォルダパターン</h2>
            <p className="text-xs text-[var(--color-fg-muted)] mb-4">
              フォルダ名がこのパターンに一致するサブフォルダは自動的に「共通」に分類されます
            </p>
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={patternInput}
                onChange={e => setPatternInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleAddPattern()}
                placeholder="例: 定款"
                className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
              <button
                onClick={handleAddPattern}
                disabled={!patternInput.trim()}
                className="rounded-lg bg-[var(--color-fg)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:bg-gray-300"
              >
                追加
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {(config?.defaultCommonPatterns || []).map(p => (
                <span key={p} className="inline-flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-xs text-[var(--color-ok-fg)]">
                  {p}
                  <button onClick={() => handleRemovePattern(p)} className="text-[var(--color-ok-fg)] hover:text-red-500">×</button>
                </span>
              ))}
            </div>
          </div>
        )}

        {section === "template-labels" && (
          <div className="h-full">
            <TemplateLabelsSection />
          </div>
        )}
      </div>
    </div>
  );
}
