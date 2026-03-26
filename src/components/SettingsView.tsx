"use client";

import { useState } from "react";
import type { WorkspaceConfig, Company } from "@/types";
import CompanyRegistration from "./folders/CompanyRegistration";
import CommonPatternsModal from "./folders/CommonPatternsModal";
import ProfileTemplateModal from "./ProfileTemplateModal";
import DocumentTemplateModal from "./DocumentTemplateModal";

type SettingsSection = "companies" | "common" | "profile-items" | "doc-templates";

interface Props {
  config: WorkspaceConfig | null;
  onAddCompanies: (folders: { id: string; name: string }[]) => void;
  onRemoveCompany: (companyId: string) => void;
  onUpdateConfig: () => void;
}

export default function SettingsView({ config, onAddCompanies, onRemoveCompany, onUpdateConfig }: Props) {
  const [section, setSection] = useState<SettingsSection>("companies");
  const [scanningAll, setScanningAll] = useState(false);
  const [scanProgress, setScanProgress] = useState("");
  const scanAbortRef = useState<AbortController | null>(null);

  const sections: { id: SettingsSection; label: string }[] = [
    { id: "companies", label: "会社登録" },
    { id: "common", label: "共通フォルダ" },
    { id: "profile-items", label: "基本情報 抽出項目" },
    { id: "doc-templates", label: "書類雛形" },
  ];

  // 共通フォルダ設定の保存
  const handleSavePatterns = async (patterns: string[]) => {
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setDefaultCommonPatterns", patterns }),
    });
    onUpdateConfig();
  };

  // 共通フォルダスキャン
  const handleScanAll = async (patterns: string[], reset: boolean) => {
    await handleSavePatterns(patterns);
    setScanningAll(true);
    setScanProgress("開始中...");
    const controller = new AbortController();
    try {
      const res = await fetch("/api/workspace/scan-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset }),
        signal: controller.signal,
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
            onUpdateConfig();
          }
        }
      }
    } catch { /* abort or error */ }
    finally {
      setScanningAll(false);
      setScanProgress("");
    }
  };

  return (
    <div className="flex h-full">
      {/* 左: メニュー */}
      <div className="w-48 border-r border-gray-200 bg-gray-50 p-4">
        <h2 className="text-sm font-bold text-gray-800 mb-4">設定</h2>
        <nav className="space-y-1">
          {sections.map(s => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors ${
                section === s.id
                  ? "bg-blue-100 text-blue-700 font-medium"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </div>

      {/* 右: 内容 */}
      <div className="flex-1 overflow-hidden">
        {section === "companies" && (
          <CompanyRegistration
            companies={config?.companies || []}
            onAdd={onAddCompanies}
            onRemove={onRemoveCompany}
            onClose={() => {}} // 設定タブ内なので閉じない
          />
        )}
        {section === "common" && (
          <div className="h-full p-6">
            <CommonPatternsModal
              patterns={config?.defaultCommonPatterns || []}
              onSave={handleSavePatterns}
              onScanAll={handleScanAll}
              onCancelScan={() => {}}
              scanning={scanningAll}
              scanProgress={scanProgress}
              onClose={() => {}}
              inline
            />
          </div>
        )}
        {section === "profile-items" && (
          <div className="h-full p-6">
            <ProfileTemplateModal onClose={() => {}} inline />
          </div>
        )}
        {section === "doc-templates" && (
          <div className="h-full">
            <DocumentTemplateModal onClose={() => {}} inline />
          </div>
        )}
      </div>
    </div>
  );
}
