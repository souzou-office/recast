"use client";

import { useState, useEffect, useCallback } from "react";
import type { Company, ChatThread } from "@/types";

interface ThreadSummary {
  id: string;
  displayName: string;
  updatedAt: string;
  folderPath?: string;
  generatedDocuments?: { templateName: string }[];
  checkResult?: string;
}

interface Props {
  companies: Company[];
  selectedCompanyId: string | null;
  onSelectCompany: (companyId: string) => void;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
}

function timeGroup(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "今日";
  if (diffDays === 1) return "昨日";
  if (diffDays < 7) return "今週";
  if (diffDays < 30) return "今月";
  return "それ以前";
}

export default function ChatSidebar({
  companies, selectedCompanyId, onSelectCompany,
  selectedThreadId, onSelectThread, onNewThread,
}: Props) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [companySearchOpen, setCompanySearchOpen] = useState(false);
  const [companySearch, setCompanySearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const company = companies.find(c => c.id === selectedCompanyId) || null;

  // スレッド一覧を取得
  const loadThreads = useCallback(async () => {
    if (!selectedCompanyId) { setThreads([]); return; }
    try {
      const res = await fetch(`/api/chat-threads?companyId=${encodeURIComponent(selectedCompanyId)}`);
      if (res.ok) {
        const data = await res.json();
        setThreads(data.threads || []);
      }
    } catch { /* ignore */ }
  }, [selectedCompanyId]);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  // 名前変更
  const handleRename = async (threadId: string) => {
    if (!editName.trim() || !selectedCompanyId) return;
    await fetch(`/api/chat-threads/${threadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId: selectedCompanyId, displayName: editName.trim() }),
    });
    setEditingId(null);
    loadThreads();
  };

  // 削除
  const handleDelete = async (threadId: string) => {
    if (!confirm("このチャットを削除しますか？") || !selectedCompanyId) return;
    await fetch(`/api/chat-threads/${threadId}?companyId=${encodeURIComponent(selectedCompanyId)}`, {
      method: "DELETE",
    });
    loadThreads();
  };

  const sortedCompanies = companies.slice().sort((a, b) => a.name.localeCompare(b.name));
  const filteredCompanies = companySearch
    ? sortedCompanies.filter(c => c.name.toLowerCase().includes(companySearch.toLowerCase()))
    : sortedCompanies;

  // 日付グルーピング
  const grouped: Record<string, ThreadSummary[]> = {};
  for (const t of threads) {
    const group = timeGroup(t.updatedAt);
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(t);
  }

  return (
    <aside className="shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col overflow-hidden" style={{ width: "100%" }}>
      {/* 会社セレクター */}
      <div className="border-b border-gray-200 p-2">
        <button
          onClick={() => setCompanySearchOpen(!companySearchOpen)}
          className="w-full flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs hover:border-blue-400 transition-colors"
        >
          <span className="flex-1 truncate text-left text-gray-700">
            {company ? company.name : "会社を選択"}
          </span>
          <span className="text-gray-400 text-[10px]">{companySearchOpen ? "▲" : "▼"}</span>
        </button>
        {companySearchOpen && (
          <div className="mt-1 rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
            <input
              type="text"
              value={companySearch}
              onChange={e => setCompanySearch(e.target.value)}
              placeholder="検索..."
              autoFocus
              className="w-full border-b border-gray-100 px-2.5 py-1.5 text-xs focus:outline-none"
            />
            <ul className="max-h-[250px] overflow-y-auto py-0.5">
              {filteredCompanies.length === 0 ? (
                <li className="px-2.5 py-1.5 text-[10px] text-gray-400">見つかりません</li>
              ) : (
                filteredCompanies.map(c => (
                  <li key={c.id}>
                    <button
                      onClick={() => { onSelectCompany(c.id); setCompanySearchOpen(false); setCompanySearch(""); }}
                      className={`w-full px-2.5 py-1 text-left text-xs transition-colors ${
                        c.id === selectedCompanyId ? "bg-blue-50 text-blue-700" : "text-gray-700 hover:bg-gray-100"
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

      {/* 新規チャットボタン */}
      <div className="p-2">
        <button
          onClick={onNewThread}
          className="w-full rounded-lg border border-dashed border-gray-300 py-2 text-xs text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
        >
          + 新規チャット
        </button>
      </div>

      {/* チャット履歴 */}
      <div className="flex-1 overflow-y-auto px-2">
        {!company ? (
          <p className="text-[10px] text-gray-400 py-4 text-center">会社を選択してください</p>
        ) : threads.length === 0 ? (
          <p className="text-[10px] text-gray-400 py-4 text-center">チャットがありません</p>
        ) : (
          Object.entries(grouped).map(([group, items]) => (
            <div key={group} className="mb-2">
              <p className="text-[9px] text-gray-400 uppercase tracking-wider px-1 mb-1">{group}</p>
              {items.map(t => (
                <div
                  key={t.id}
                  className={`group rounded-lg px-2 py-1.5 mb-0.5 cursor-pointer transition-colors ${
                    t.id === selectedThreadId ? "bg-blue-100 text-blue-700" : "hover:bg-gray-100 text-gray-700"
                  }`}
                >
                  {editingId === t.id ? (
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onBlur={() => handleRename(t.id)}
                      onKeyDown={e => { if (e.key === "Enter") handleRename(t.id); if (e.key === "Escape") setEditingId(null); }}
                      autoFocus
                      className="w-full text-xs border-b border-blue-400 outline-none bg-transparent"
                    />
                  ) : (
                    <div className="flex items-center gap-1" onClick={() => onSelectThread(t.id)}>
                      <span className="text-xs">💬</span>
                      <span className="flex-1 text-xs truncate">{t.displayName}</span>
                      <div className="hidden group-hover:flex items-center gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingId(t.id); setEditName(t.displayName); }}
                          className="text-[10px] text-gray-400 hover:text-blue-600 px-1 py-0.5 rounded hover:bg-blue-50"
                        >編集</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}
                          className="text-[10px] text-gray-400 hover:text-red-600 px-1 py-0.5 rounded hover:bg-red-50"
                        >削除</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
