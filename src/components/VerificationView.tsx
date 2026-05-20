"use client";

import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { Company, CaseRoom, ChatMessage } from "@/types";
import { v4 as uuidv4 } from "uuid";
import MessageBubble from "./chat/MessageBubble";
import FilePreview from "./FilePreview";

import { Icon } from "./ui/Icon";
interface Props {
  company: Company | null;
  caseRoom?: CaseRoom;
  onUpdate?: () => void;
}

interface FolderData {
  files: { name: string; path: string }[];
  subfolders: { name: string; path: string }[];
}

function fileIconName(name: string): "FileText" | "FileSpreadsheet" | "FileType" | "File" {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return "FileType";
  if (["doc", "docx"].includes(ext)) return "FileText";
  if (["xls", "xlsx", "xlsm", "csv"].includes(ext)) return "FileSpreadsheet";
  return "File";
}

export default function VerificationView({ company, caseRoom, onUpdate }: Props) {
  const [selectedFiles, setSelectedFiles] = useState<{ id: string; name: string; mimeType: string }[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [sourceLinks, setSourceLinks] = useState<Record<string, { id: string; name: string }[]>>({});
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);

  // ローカルフォルダブラウザ
  const [folderData, setFolderData] = useState<Record<string, FolderData>>({});
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [browseRoot, setBrowseRoot] = useState<string>("");

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-hover)]">
        <p className="text-sm text-[var(--color-fg-subtle)]">サイドバーから会社を選択してください</p>
      </div>
    );
  }

  const hasMasterSheet = !!(caseRoom?.masterSheet || company.masterSheet);
  const hasProfile = !!company.profile;

  // フォルダ読み込み
  const loadFolder = async (folderPath: string) => {
    if (folderData[folderPath]) return;
    try {
      const res = await fetch("/api/workspace/list-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: folderPath }),
      });
      const data = await res.json();
      setFolderData(prev => ({
        ...prev,
        [folderPath]: { files: data.files || [], subfolders: data.subfolders || [] },
      }));
    } catch { /* ignore */ }
  };

  // 案件フォルダ内のチェック済みサブフォルダを取得
  const [checkedSubfolders, setCheckedSubfolders] = useState<{ id: string; name: string; parentName: string }[]>([]);

  useEffect(() => {
    if (!company) return;
    setFolderData({});
    setSelectedFiles([]);
    setChatMessages([]);
    setCheckedSubfolders([]);

    const activeJobs = company.subfolders.filter(s => s.role === "job" && s.active);
    if (activeJobs.length === 0) {
      setBrowseRoot(company.id);
      setExpandedFolders(new Set([company.id]));
      loadFolder(company.id);
      return;
    }

    // 各activeフォルダの中身を読み、disabledでないサブフォルダを収集
    setBrowseRoot("checked");
    const expanded = new Set<string>();

    Promise.all(activeJobs.map(async (job) => {
      const res = await fetch("/api/workspace/list-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: job.id }),
      });
      const data = await res.json();
      const disabled = new Set(job.disabledFiles || []);
      const subs = (data.subfolders || [])
        .filter((sf: { path: string }) => !disabled.has(sf.path))
        .map((sf: { name: string; path: string }) => ({ id: sf.path, name: sf.name, parentName: job.name }));

      // ファイルもfolderDataに入れる
      setFolderData(prev => ({
        ...prev,
        [job.id]: { files: data.files || [], subfolders: data.subfolders || [] },
      }));

      for (const sf of subs) {
        expanded.add(sf.id);
        loadFolder(sf.id);
      }
      return subs;
    })).then(results => {
      setCheckedSubfolders(results.flat());
      setExpandedFolders(expanded);
    });
  }, [company?.id]);

  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else { next.add(path); loadFolder(path); }
      return next;
    });
  };

  const [lastClickedFile, setLastClickedFile] = useState<string | null>(null);

  const addFile = (f: { name: string; path: string }) => {
    const ext = f.name.split(".").pop()?.toLowerCase() || "";
    if (!selectedFiles.some(sf => sf.id === f.path)) {
      setSelectedFiles(prev => [...prev, { id: f.path, name: f.name, mimeType: ext }]);
    }
    setLastClickedFile(f.path);
  };

  const removeFile = (filePath: string) => {
    setSelectedFiles(prev => prev.filter(f => f.id !== filePath));
  };

  // フォルダ内の全ファイルを追加
  const addAllFilesInFolder = (folderPath: string) => {
    const data = folderData[folderPath];
    if (!data) return;
    for (const f of data.files) {
      addFile(f);
    }
    // サブフォルダも再帰
    for (const sf of data.subfolders) {
      addAllFilesInFolder(sf.path);
    }
  };

  // Shift+クリックで範囲選択
  const handleFileClick = (f: { name: string; path: string }, e: React.MouseEvent, allFiles: { name: string; path: string }[]) => {
    const isSelected = selectedFiles.some(sf => sf.id === f.path);

    if (e.shiftKey && lastClickedFile) {
      // 範囲選択
      const lastIdx = allFiles.findIndex(af => af.path === lastClickedFile);
      const currentIdx = allFiles.findIndex(af => af.path === f.path);
      if (lastIdx >= 0 && currentIdx >= 0) {
        const start = Math.min(lastIdx, currentIdx);
        const end = Math.max(lastIdx, currentIdx);
        for (let i = start; i <= end; i++) {
          addFile(allFiles[i]);
        }
      }
    } else {
      if (isSelected) removeFile(f.path);
      else addFile(f);
    }
  };

  // 突合せ実行
  const handleVerify = async () => {
    if (selectedFiles.length === 0) return;
    setChatLoading(true);

    const userMsg: ChatMessage = {
      id: uuidv4(), role: "user",
      content: `以下のファイルで突合せを実行: ${selectedFiles.map(f => f.name).join(", ")}`,
      timestamp: Date.now(),
    };
    setChatMessages(prev => [...prev, userMsg]);

    const assistantMsg: ChatMessage = { id: uuidv4(), role: "assistant", content: "", timestamp: Date.now() };
    setChatMessages(prev => [...prev, assistantMsg]);

    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id, fileIds: selectedFiles.map(f => f.id), caseRoomId: caseRoom?.id }),
      });

      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      let collectedFiles: { id: string; name: string; mimeType: string }[] = [];

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
          if (data.type === "meta" && data.sourceFiles) collectedFiles = data.sourceFiles;
          else if (data.type === "text") {
            setChatMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last.role === "assistant") updated[updated.length - 1] = { ...last, content: last.content + data.text };
              return updated;
            });
          }
        }
      }

      setChatLoading(false);

      // Haikuでリンク紐付け
      const finalMessages = await new Promise<ChatMessage[]>(resolve => {
        setChatMessages(prev => { resolve(prev); return prev; });
      });
      const finalMsg = finalMessages[finalMessages.length - 1];
      if (collectedFiles.length > 0 && finalMsg?.content) {
        try {
          const linkRes = await fetch("/api/templates/link-sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: finalMsg.content, sourceFiles: collectedFiles }),
          });
          if (linkRes.ok) {
            const { links } = await linkRes.json();
            setSourceLinks(links);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    finally { setChatLoading(false); }
  };

  // 追加チャット
  const handleChatSend = useCallback(async (content: string) => {
    const userMsg: ChatMessage = { id: uuidv4(), role: "user", content, timestamp: Date.now() };
    setChatMessages(prev => [...prev, userMsg]);
    setChatLoading(true);
    const assistantMsg: ChatMessage = { id: uuidv4(), role: "assistant", content: "", timestamp: Date.now() };
    setChatMessages(prev => [...prev, assistantMsg]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...chatMessages, userMsg].map(m => ({ role: m.role, content: m.content })) }),
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
          if (line === "data: [DONE]") continue;
          const match = line.match(/^data: (.+)$/m);
          if (!match) continue;
          const data = JSON.parse(match[1]);
          if (data.text) {
            setChatMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last.role === "assistant") updated[updated.length - 1] = { ...last, content: last.content + data.text };
              return updated;
            });
          }
        }
      }
    } catch { /* ignore */ }
    finally { setChatLoading(false); }
  }, [chatMessages]);

  // h2カスタムコンポーネント
  const components: Components = {
    h2: ({ children, ...props }) => {
      const text = typeof children === "string" ? children :
        Array.isArray(children) ? children.map(c => typeof c === "string" ? c : "").join("") : "";
      const cleanText = text.replace(/^\d+\.\s*/, "").trim();
      const files = sourceLinks[text] || sourceLinks[cleanText] ||
        Object.entries(sourceLinks).find(([k]) => k.includes(cleanText) || cleanText.includes(k))?.[1];
      return (
        <div className="flex flex-wrap items-center gap-2 mt-3 mb-1">
          <h2 {...props} className="text-base font-semibold text-[var(--color-fg)] m-0">{children}</h2>
          {files?.map((f, i) => (
            <button key={`${f.id}-${i}`} onClick={() => setPreviewFileId(previewFileId === f.id ? null : f.id)}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                previewFileId === f.id ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]" : "bg-[var(--color-hover)] text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
              }`}>📄 {f.name}</button>
          ))}
        </div>
      );
    },
  };

  // 再帰フォルダツリー
  const renderTree = (folderPath: string, depth: number = 0) => {
    const data = folderData[folderPath];
    if (!data) return <p className="text-[10px] text-[var(--color-fg-subtle)] py-1 pl-2">読み込み中...</p>;

    return (
      <ul className={depth > 0 ? "ml-3 border-l border-[var(--color-border)] pl-2" : ""}>
        {data.subfolders.map(sf => {
          const isOpen = expandedFolders.has(sf.path);
          const hasAnySelected = folderData[sf.path]?.files.some(f => selectedFiles.some(s => s.id === f.path));
          return (
            <li key={sf.path}>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => toggleFolder(sf.path)}
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-left text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
                >
                  <span className="text-[11px]"><Icon name={isOpen ? "FolderOpen" : "Folder"} size={12} className="text-[var(--color-fg-muted)]" /></span>
                  <span className="truncate">{sf.name}</span>
                </button>
                <button
                  onClick={() => { loadFolder(sf.path); setTimeout(() => addAllFilesInFolder(sf.path), 500); }}
                  className="text-[9px] text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] shrink-0 px-1"
                  title="フォルダ内を全選択"
                >
                  全選択
                </button>
              </div>
              {isOpen && renderTree(sf.path, depth + 1)}
            </li>
          );
        })}
        {data.files.map(f => {
          const isSelected = selectedFiles.some(sf => sf.id === f.path);
          return (
            <li key={f.path}>
              <button
                onClick={(e) => handleFileClick(f, e, data.files)}
                className={`w-full flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-left transition-colors ${
                  isSelected ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]" : "text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                }`}
              >
                <Icon name={fileIconName(f.name)} size={12} className="text-[var(--color-fg-muted)] shrink-0" />
                <span className="truncate">{f.name}</span>
                {isSelected && <span className="ml-auto text-[9px] text-[var(--color-accent)]">✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="flex h-full">
      {/* 左: ファイル選択 + チャット */}
      <div className={`flex flex-col ${previewFileId ? "flex-1 min-w-0" : "w-full"} transition-all`}>
        {/* ヘッダー */}
        <div className="border-b border-[var(--color-border)] px-6 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-[var(--color-fg)]">{company.name}</h2>
            <div className="flex gap-2 mt-1">
              <span className={`rounded px-2 py-0.5 text-[10px] ${hasProfile ? "bg-green-100 text-[var(--color-ok-fg)]" : "bg-[var(--color-hover)] text-[var(--color-fg-muted)]"}`}>
                基本情報 {hasProfile ? "✓" : "未生成"}
              </span>
              <span className={`rounded px-2 py-0.5 text-[10px] ${hasMasterSheet ? "bg-green-100 text-[var(--color-ok-fg)]" : "bg-[var(--color-hover)] text-[var(--color-fg-muted)]"}`}>
                案件整理 {hasMasterSheet ? "✓" : "未生成"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {chatMessages.length > 0 && (
              <button
                onClick={() => {
                  if (!confirm("突合せ結果を削除しますか？")) return;
                  setChatMessages([]);
                  setSourceLinks({});
                  setSelectedFiles([]);
                }}
                className="text-[10px] text-red-400 hover:text-red-600 transition-colors"
              >
                削除
              </button>
            )}
            <button
              onClick={handleVerify}
              disabled={chatLoading || (!hasProfile && !hasMasterSheet) || selectedFiles.length === 0}
              className="rounded-lg bg-[var(--color-fg)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:bg-gray-300 transition-colors"
            >
              {chatLoading ? "突合せ中..." : `突合せ実行${selectedFiles.length > 0 ? `（${selectedFiles.length}件）` : ""}`}
            </button>
          </div>
        </div>

        {/* メインエリア */}
        <div className="flex-1 overflow-y-auto">
          {chatMessages.length === 0 && (
            <div className="flex h-full">
              {/* 左: フォルダブラウザ */}
              <div className="w-1/2 border-r border-[var(--color-border)] overflow-y-auto p-3">
                <p className="text-[10px] text-[var(--color-fg-subtle)] mb-2">突合せ対象のファイルを選択（クリックで追加）</p>
                {browseRoot === "checked" ? (
                  <ul>
                    {checkedSubfolders.map(sf => (
                      <li key={sf.id}>
                        <button
                          onClick={() => toggleFolder(sf.id)}
                          className="w-full flex items-center gap-1 rounded px-1.5 py-1 text-xs text-left text-[var(--color-fg)] font-medium hover:bg-[var(--color-hover)]"
                        >
                          <span className="text-[11px]"><Icon name={expandedFolders.has(sf.id) ? "FolderOpen" : "Folder"} size={12} className="text-[var(--color-fg-muted)]" /></span>
                          {sf.name}
                        </button>
                        {expandedFolders.has(sf.id) && renderTree(sf.id, 1)}
                      </li>
                    ))}
                    {checkedSubfolders.length === 0 && (
                      <li className="text-[10px] text-[var(--color-fg-subtle)] py-4 text-center">サイドバーでフォルダにチェックを入れてください</li>
                    )}
                    <li className="mt-2 border-t border-[var(--color-border-soft)] pt-2">
                      <button
                        onClick={() => { setBrowseRoot(company.id); loadFolder(company.id); setExpandedFolders(prev => new Set([...prev, company.id])); }}
                        className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]"
                      >
                        ↑ 会社フォルダ全体を表示
                      </button>
                    </li>
                  </ul>
                ) : (
                  <>
                    <button
                      onClick={() => setBrowseRoot("checked")}
                      className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] mb-2"
                    >
                      ↓ チェック済みフォルダに戻る
                    </button>
                    {renderTree(company.id)}
                  </>
                )}
              </div>

              {/* 右: 選択済みファイル */}
              <div className="w-1/2 overflow-y-auto p-3 bg-[var(--color-hover)]">
                <p className="text-[10px] text-[var(--color-fg-subtle)] mb-2">選択済み（{selectedFiles.length}件）</p>
                {selectedFiles.length === 0 ? (
                  <p className="text-xs text-[var(--color-fg-subtle)] py-8 text-center">左からファイルを選択してください</p>
                ) : (
                  <ul className="space-y-0.5">
                    {selectedFiles.map(f => (
                      <li key={f.id} className="flex items-center gap-1 rounded bg-[var(--color-panel)] px-2 py-1.5 border border-[var(--color-border)]">
                        <Icon name={fileIconName(f.name)} size={12} className="text-[var(--color-fg-muted)] shrink-0" />
                        <span className="text-xs text-[var(--color-fg)] flex-1 truncate">{f.name}</span>
                        <button onClick={() => removeFile(f.id)} className="text-[10px] text-red-400 hover:text-red-600 shrink-0">×</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* チャットメッセージ */}
          {chatMessages.length > 0 && (
            <div className="p-6 space-y-4">
              {chatMessages.map((msg, i) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  streaming={chatLoading && i === chatMessages.length - 1 && msg.role === "assistant"}
                  sourceLinks={msg.role === "assistant" ? sourceLinks : undefined}
                  onPreviewFile={setPreviewFileId}
                  activePreviewId={previewFileId}
                />
              ))}
            </div>
          )}
        </div>

      </div>

      {/* 右: プレビュー */}
      {previewFileId && (
        <FilePreview
          filePath={previewFileId}
          fileName={selectedFiles.find(f => f.id === previewFileId)?.name || previewFileId.split(/[\\/]/).pop() || ""}
          onClose={() => setPreviewFileId(null)}
        />
      )}
    </div>
  );
}
