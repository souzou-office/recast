"use client";

import { useState, useEffect, useCallback } from "react";
import type { FolderProvider } from "@/types";

interface DirEntry {
  name: string;
  path: string;
}

interface FileEntry {
  name: string;
  mimeType: string;
}

interface BrowseResult {
  current: string;
  parent: string | null;
  dirs: DirEntry[];
  files?: FileEntry[];
}

interface Props {
  provider?: FolderProvider;
  onSelect: (path: string, name?: string) => void;
  onClose: () => void;
}

export default function FolderBrowser({ provider = "local", onSelect, onClose }: Props) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // クラウドの場合、フォルダ名を追跡
  const [currentName, setCurrentName] = useState("");

  const browse = useCallback(async (dirPath?: string, dirName?: string) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (dirPath) params.set("path", dirPath);
      if (provider !== "local") params.set("provider", provider);
      const query = params.toString();
      const res = await fetch(`/api/browse${query ? `?${query}` : ""}`);
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "読み取りエラー");
        return;
      }
      setData(await res.json());
      if (dirName) setCurrentName(dirName);
    } catch {
      setError("通信エラー");
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    browse();
  }, [browse]);

  const providerLabel =
    provider === "google" ? "Google Drive" :
    provider === "dropbox" ? "Dropbox" : "ローカル";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div className="flex w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl"
           style={{ maxHeight: "70vh" }}>
        {/* ヘッダー */}
        <div className="border-b border-gray-200 px-5 py-4">
          <h3 className="text-lg font-semibold text-gray-900">
            {providerLabel} - フォルダを選択
          </h3>
          {data && (
            <p className="mt-1 truncate text-xs font-mono text-gray-500" title={data.current}>
              {provider === "google"
                ? (currentName || (data.current === "root" ? "マイドライブ" : data.current))
                : (data.current || "/")}
            </p>
          )}
        </div>

        {/* フォルダ一覧 */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading && (
            <p className="px-3 py-4 text-center text-sm text-gray-400">読み込み中...</p>
          )}
          {error && (
            <p className="px-3 py-4 text-center text-sm text-red-500">{error}</p>
          )}
          {data && !loading && (
            <ul>
              {data.parent !== null && data.parent !== undefined && (
                <li>
                  <button
                    onClick={() => browse(data.parent!)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm
                               text-blue-600 hover:bg-blue-50 transition-colors"
                  >
                    <span className="text-base">&#8593;</span>
                    上の階層へ
                  </button>
                </li>
              )}
              {data.dirs.length === 0 && (
                <li className="px-3 py-4 text-center text-sm text-gray-400">
                  サブフォルダなし
                </li>
              )}
              {data.dirs.map((dir) => (
                <li key={dir.path}>
                  <button
                    onClick={() => browse(dir.path, dir.name)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm
                               text-gray-700 hover:bg-gray-100 transition-colors"
                  >
                    <span className="shrink-0 text-yellow-500">&#128193;</span>
                    {dir.name}
                  </button>
                </li>
              ))}
              {data.files && data.files.length > 0 && (
                <>
                  <li className="border-t border-gray-100 mt-1 pt-1">
                    <span className="px-3 py-1 text-[10px] text-gray-400">ファイル</span>
                  </li>
                  {data.files.map((file, i) => (
                    <li key={`file-${i}`}
                        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-gray-400">
                      <span className="shrink-0 text-xs">
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

        {/* フッター */}
        <div className="flex justify-end gap-3 border-t border-gray-200 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
          >
            キャンセル
          </button>
          <button
            onClick={() => data && onSelect(data.current, currentName || undefined)}
            disabled={!data}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white
                       hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            このフォルダを選択
          </button>
        </div>
      </div>
    </div>
  );
}
