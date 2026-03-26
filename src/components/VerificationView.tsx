"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { Company } from "@/types";

interface Props {
  company: Company | null;
}

interface BrowseData {
  dirs: { name: string; path: string }[];
  files?: { name: string; mimeType: string }[];
}

export default function VerificationView({ company }: Props) {
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState("");
  const [sourceFiles, setSourceFiles] = useState<{ id: string; name: string; mimeType: string }[]>([]);
  const [sourceLinks, setSourceLinks] = useState<Record<string, { id: string; name: string }[]>>({});
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<{ id: string; name: string; mimeType: string }[]>([]);

  // Google Driveブラウザ
  const [browseData, setBrowseData] = useState<BrowseData | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string; name: string }[]>([]);

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">サイドバーから会社を選択してください</p>
      </div>
    );
  }

  const hasMasterSheet = !!company.masterSheet;
  const hasProfile = !!company.profile;

  // 初回: 会社のフォルダを表示
  const browseTo = async (folderId?: string, folderName?: string) => {
    setBrowseLoading(true);
    try {
      const params = new URLSearchParams({ provider: "google" });
      if (folderId) params.set("path", folderId);
      const res = await fetch(`/api/browse?${params}`);
      if (res.ok) {
        setBrowseData(await res.json());
        if (folderId && folderName) {
          setBreadcrumbs(prev => [...prev, { id: folderId, name: folderName }]);
        }
      }
    } catch { /* ignore */ }
    finally { setBrowseLoading(false); }
  };

  // 会社フォルダを初期表示
  useEffect(() => {
    if (company && !result) browseTo(company.id, company.name);
  }, [company?.id]);

  const navigateUp = () => {
    const bc = breadcrumbs.slice(0, -1);
    setBreadcrumbs(bc);
    if (bc.length === 0) {
      browseTo(company.id, company.name);
      setBreadcrumbs([{ id: company.id, name: company.name }]);
    } else {
      setBrowseLoading(true);
      const last = bc[bc.length - 1];
      const params = new URLSearchParams({ path: last.id, provider: "google" });
      fetch(`/api/browse?${params}`).then(r => r.json()).then(d => setBrowseData(d)).finally(() => setBrowseLoading(false));
    }
  };

  const addFile = (f: { name: string; mimeType: string }) => {
    if (selectedFiles.some(sf => sf.name === f.name)) return;
    setSelectedFiles(prev => [...prev, { id: f.name, name: f.name, mimeType: f.mimeType }]);
  };

  const removeFile = (name: string) => {
    setSelectedFiles(prev => prev.filter(f => f.name !== name));
  };

  const handleVerify = async () => {
    setVerifying(true);
    setResult("");
    setSourceFiles([]);
    setSourceLinks({});

    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id, fileIds: selectedFiles.map(f => f.id) }),
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

          if (data.type === "meta" && data.sourceFiles) {
            collectedFiles = data.sourceFiles;
            setSourceFiles(data.sourceFiles);
          } else if (data.type === "text") {
            setResult(prev => prev + data.text);
          }
        }
      }

      setVerifying(false);

      // Haikuで各セクションとファイルの紐付け
      const finalResult = await new Promise<string>(resolve => {
        setResult(prev => { resolve(prev); return prev; });
      });

      if (collectedFiles.length > 0 && finalResult) {
        try {
          const linkRes = await fetch("/api/templates/link-sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: finalResult, sourceFiles: collectedFiles }),
          });
          if (linkRes.ok) {
            const { links } = await linkRes.json();
            setSourceLinks(links);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    finally { setVerifying(false); }
  };

  // h2見出しの横にファイルリンクを表示するカスタムコンポーネント
  const components: Components = {
    h2: ({ children, ...props }) => {
      const text = typeof children === "string" ? children :
        Array.isArray(children) ? children.map(c => typeof c === "string" ? c : "").join("") : "";
      const cleanText = text.replace(/^\d+\.\s*/, "").trim();
      const files = sourceLinks[text] || sourceLinks[cleanText] ||
        Object.entries(sourceLinks).find(([k]) =>
          k.includes(cleanText) || cleanText.includes(k)
        )?.[1];

      return (
        <div className="flex flex-wrap items-center gap-2 mt-3 mb-1">
          <h2 {...props} className="text-base font-semibold text-gray-900 m-0">{children}</h2>
          {files && files.map((f, i) => (
            <button
              key={`${f.id}-${i}`}
              onClick={() => setPreviewFileId(previewFileId === f.id ? null : f.id)}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                previewFileId === f.id
                  ? "bg-blue-100 text-blue-700"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              }`}
            >
              📄 {f.name}
            </button>
          ))}
        </div>
      );
    },
  };

  return (
    <div className="flex h-full">
      {/* 左: 突合せ結果 */}
      <div className={`flex flex-col ${previewFileId ? "w-1/2" : "w-full"} transition-all`}>
        <div className="border-b border-gray-200 px-6 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-gray-900">{company.name}</h2>
            <div className="flex gap-2 mt-1">
              <span className={`rounded px-2 py-0.5 text-[10px] ${hasProfile ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                基本情報 {hasProfile ? "✓" : "未生成"}
              </span>
              <span className={`rounded px-2 py-0.5 text-[10px] ${hasMasterSheet ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                案件整理 {hasMasterSheet ? "✓" : "未生成"}
              </span>
            </div>
          </div>
          <button
            onClick={handleVerify}
            disabled={verifying || (!hasProfile && !hasMasterSheet) || selectedFiles.length === 0}
            className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
          >
            {verifying ? "突合せ中..." : `突合せ実行${selectedFiles.length > 0 ? `（${selectedFiles.length}件）` : ""}`}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {result ? (
            <div className="prose prose-sm max-w-none text-gray-800
                            prose-headings:text-gray-900 prose-headings:font-semibold
                            prose-h2:text-base prose-h2:mt-3 prose-h2:mb-1
                            prose-p:leading-snug prose-p:my-0.5
                            prose-table:border-collapse prose-table:w-full prose-table:my-0.5
                            prose-th:border prose-th:border-gray-300 prose-th:bg-gray-50 prose-th:px-2 prose-th:py-1 prose-th:text-left prose-th:text-xs
                            prose-td:border prose-td:border-gray-300 prose-td:px-2 prose-td:py-1 prose-td:text-sm
                            prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {result}
              </ReactMarkdown>
            </div>
          ) : (
            /* ファイル選択UI（Google Driveブラウザ + 選択済み） */
            <div className="flex h-full">
              {/* 左: フォルダブラウザ */}
              <div className="w-1/2 border-r border-gray-200 overflow-y-auto p-3">
                <div className="flex items-center gap-1 text-[10px] text-gray-400 mb-2 flex-wrap">
                  {breadcrumbs.map((bc, i) => (
                    <span key={bc.id} className="flex items-center gap-1">
                      {i > 0 && <span>/</span>}
                      <button
                        onClick={() => {
                          const newBc = breadcrumbs.slice(0, i + 1);
                          setBreadcrumbs(newBc);
                          setBrowseLoading(true);
                          const params = new URLSearchParams({ path: bc.id, provider: "google" });
                          fetch(`/api/browse?${params}`).then(r => r.json()).then(d => setBrowseData(d)).finally(() => setBrowseLoading(false));
                        }}
                        className="hover:text-gray-600"
                      >{bc.name}</button>
                    </span>
                  ))}
                </div>

                {browseLoading ? (
                  <p className="text-xs text-gray-400 py-4 text-center">読み込み中...</p>
                ) : browseData ? (
                  <ul className="space-y-0.5">
                    {breadcrumbs.length > 1 && (
                      <li>
                        <button onClick={navigateUp} className="flex items-center gap-2 px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded w-full text-left">
                          ↑ 上の階層へ
                        </button>
                      </li>
                    )}
                    {browseData.dirs.map(dir => (
                      <li key={dir.path}>
                        <button
                          onClick={() => browseTo(dir.path, dir.name)}
                          className="flex items-center gap-2 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded w-full text-left"
                        >
                          <span className="text-yellow-500">📁</span> {dir.name}
                        </button>
                      </li>
                    ))}
                    {browseData.files?.map((f, i) => {
                      const isSelected = selectedFiles.some(sf => sf.name === f.name);
                      return (
                        <li key={`file-${i}`}>
                          <button
                            onClick={() => !isSelected && addFile(f)}
                            className={`flex items-center gap-2 px-2 py-1 text-xs rounded w-full text-left ${
                              isSelected ? "opacity-40 bg-gray-100" : "text-gray-700 hover:bg-blue-50"
                            }`}
                          >
                            <span className="text-gray-400">📄</span>
                            <span className="truncate">{f.name}</span>
                            {isSelected && <span className="text-[9px] text-green-500 ml-auto">選択済</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>

              {/* 右: 選択済みファイル */}
              <div className="w-1/2 overflow-y-auto p-3 bg-gray-50">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-gray-700">
                    突合せ対象（{selectedFiles.length}件）
                  </h3>
                  {selectedFiles.length > 0 && (
                    <button onClick={() => setSelectedFiles([])} className="text-[10px] text-red-400 hover:text-red-600">クリア</button>
                  )}
                </div>
                {selectedFiles.length === 0 ? (
                  <div className="flex h-32 items-center justify-center">
                    <p className="text-xs text-gray-400 text-center">
                      左からファイルをクリックして追加
                    </p>
                  </div>
                ) : (
                  <ul className="space-y-0.5">
                    {selectedFiles.map(f => (
                      <li key={f.name} className="flex items-center justify-between rounded px-2 py-1 bg-white">
                        <span className="text-xs text-gray-700 truncate">📄 {f.name}</span>
                        <button onClick={() => removeFile(f.name)} className="text-[10px] text-red-400 hover:text-red-600 shrink-0 ml-1">×</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 右: ファイルプレビュー */}
      {previewFileId && (
        <div className="flex w-1/2 flex-col border-l border-gray-200">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
            <span className="text-xs text-gray-600 truncate">
              {sourceFiles.find(f => f.id === previewFileId)?.name}
            </span>
            <div className="flex items-center gap-2">
              <a href={`https://drive.google.com/file/d/${previewFileId}/view`} target="_blank" rel="noopener noreferrer"
                className="text-[10px] text-blue-500 hover:text-blue-700">別タブで開く</a>
              <button onClick={() => setPreviewFileId(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
            </div>
          </div>
          <iframe src={`https://drive.google.com/file/d/${previewFileId}/preview`} className="flex-1 w-full" allow="autoplay" />
        </div>
      )}
    </div>
  );
}
