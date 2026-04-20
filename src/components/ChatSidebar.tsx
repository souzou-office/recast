"use client";

import { useState, useEffect, useCallback } from "react";
import type { Company, ChatThread } from "@/types";
import { Icon } from "@/components/ui/Icon";

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
  refreshKey?: number;
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
  selectedThreadId, onSelectThread, onNewThread, refreshKey,
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

  useEffect(() => { loadThreads(); }, [loadThreads, refreshKey]);

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
    <aside className="flex-1 min-w-0 border-r border-[var(--color-border)] bg-[var(--color-sidebar)] flex flex-col overflow-hidden">
      {/* 会社セレクター */}
      <div className="border-b border-[var(--color-border)] p-2">
        <button
          onClick={() => setCompanySearchOpen(!companySearchOpen)}
          className="w-full flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-1.5 text-xs hover:border-[var(--color-fg-subtle)] transition-colors"
        >
          <span className="flex-1 truncate text-left text-[var(--color-fg)]">
            {company ? company.name : "会社を選択"}
          </span>
          <Icon name={companySearchOpen ? "ChevronUp" : "ChevronDown"} size={13} className="text-[var(--color-fg-subtle)]" />
        </button>
        {companySearchOpen && (
          <div className="mt-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-lg overflow-hidden">
            <input
              type="text"
              value={companySearch}
              onChange={e => setCompanySearch(e.target.value)}
              placeholder="検索..."
              autoFocus
              className="w-full border-b border-[var(--color-border-soft)] px-2.5 py-1.5 text-xs focus:outline-none bg-transparent"
            />
            <ul className="max-h-[250px] overflow-y-auto py-0.5">
              {filteredCompanies.length === 0 ? (
                <li className="px-2.5 py-1.5 text-[10px] text-[var(--color-fg-subtle)]">見つかりません</li>
              ) : (
                filteredCompanies.map(c => (
                  <li key={c.id}>
                    <button
                      onClick={() => { onSelectCompany(c.id); setCompanySearchOpen(false); setCompanySearch(""); }}
                      className={`w-full px-2.5 py-1 text-left text-xs transition-colors ${
                        c.id === selectedCompanyId ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]" : "text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
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
          className="w-full rounded-lg border border-dashed border-[var(--color-border)] py-2 text-xs text-[var(--color-fg-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] hover:bg-[var(--color-panel)]/40 transition-colors"
        >
          <span className="inline-flex items-center justify-center gap-1.5"><Icon name="Plus" size={14} /> 新規チャット</span>
        </button>
      </div>

      {/* チャット履歴 */}
      <div className="flex-1 overflow-y-auto px-2">
        {!company ? (
          <p className="text-[10px] text-[var(--color-fg-subtle)] py-4 text-center">会社を選択してください</p>
        ) : threads.length === 0 ? (
          <p className="text-[10px] text-[var(--color-fg-subtle)] py-4 text-center">チャットがありません</p>
        ) : (
          Object.entries(grouped).map(([group, items]) => (
            <div key={group} className="mb-4">
              <p className="text-[10.5px] font-serif italic text-[var(--color-fg-subtle)] px-2 pt-1 pb-1.5">{group}</p>
              {items.map(t => {
                const active = t.id === selectedThreadId;
                return (
                  <div
                    key={t.id}
                    className={`group flex items-stretch rounded-lg mb-0.5 cursor-pointer transition-colors ${
                      active ? "bg-[var(--color-panel)]" : "hover:bg-[var(--color-panel)]/50"
                    }`}
                  >
                    <div className={`w-0.5 self-stretch rounded-full ${active ? "bg-[var(--color-accent)]" : "bg-transparent"}`} />
                    <div className="flex-1 min-w-0 px-2 py-1.5">
                      {editingId === t.id ? (
                        <input
                          type="text"
                          value={editName}
                          onChange={e => setEditName(e.target.value)}
                          onBlur={() => handleRename(t.id)}
                          onKeyDown={e => { if (e.key === "Enter") handleRename(t.id); if (e.key === "Escape") setEditingId(null); }}
                          autoFocus
                          className="w-full text-xs border-b border-[var(--color-accent)] outline-none bg-transparent"
                        />
                      ) : (
                        <div className="flex items-center gap-1.5" onClick={() => onSelectThread(t.id)}>
                          <Icon name="MessageSquare" size={13} className="text-[var(--color-fg-subtle)] shrink-0" />
                          <span className={`flex-1 text-xs truncate ${active ? "text-[var(--color-fg)] font-medium" : "text-[var(--color-fg-muted)]"}`}>{t.displayName}</span>
                          <div className="hidden group-hover:flex items-center gap-0.5">
                            <button
                              onClick={(e) => { e.stopPropagation(); setEditingId(t.id); setEditName(t.displayName); }}
                              className="p-0.5 rounded text-[var(--color-fg-subtle)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
                              title="編集"
                            ><Icon name="Pencil" size={11} /></button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}
                              className="p-0.5 rounded text-[var(--color-fg-subtle)] hover:text-red-600 hover:bg-red-50"
                              title="削除"
                            ><Icon name="Trash2" size={11} /></button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
