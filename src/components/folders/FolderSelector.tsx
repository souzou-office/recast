"use client";

import { useState } from "react";
import type { FolderProvider } from "@/types";
import FolderBrowser from "./FolderBrowser";

interface Props {
  onAdd: (name: string, path: string, type: "common" | "jobs", provider: FolderProvider) => void;
  onClose: () => void;
}

export default function FolderSelector({ onAdd, onClose }: Props) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [type, setType] = useState<"common" | "jobs">("jobs");
  const [provider, setProvider] = useState<FolderProvider>("google");
  const [showBrowser, setShowBrowser] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) return;
    onAdd(name.trim(), path.trim(), type, provider);
  };

  const handleBrowseSelect = (selectedPath: string, selectedName?: string) => {
    setPath(selectedPath);
    if (!name) {
      if (selectedName) {
        setName(selectedName);
      } else {
        const segments = selectedPath.replace(/[\\/]+$/, "").split(/[\\/]/);
        setName(segments[segments.length - 1] || "");
      }
    }
    setShowBrowser(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-2xl bg-[var(--color-panel)] p-6 shadow-xl">
        <h3 className="mb-4 text-lg font-semibold text-[var(--color-fg)]">
          フォルダを追加
        </h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* プロバイダー選択 */}
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-fg)]">
              参照先
            </label>
            <div className="flex gap-2">
              {(["google", "dropbox", "local"] as FolderProvider[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => { setProvider(p); setPath(""); }}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    provider === p
                      ? "border-blue-500 bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]"
                      : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                  }`}
                >
                  {p === "google" ? "Google Drive" : p === "dropbox" ? "Dropbox" : "ローカル"}
                </button>
              ))}
            </div>
          </div>

          {/* 表示名 */}
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-fg)]">
              表示名
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 定款、今月の請求書"
              className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm
                         focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* フォルダ選択 */}
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-fg)]">
              フォルダ
            </label>
            {provider === "local" ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="例: C:/Users/.../Dropbox/定款"
                  className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-mono
                             focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setShowBrowser(true)}
                  className="shrink-0 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm
                             text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)] transition-colors"
                >
                  参照
                </button>
              </div>
            ) : (
              <div>
                <button
                  type="button"
                  onClick={() => setShowBrowser(true)}
                  className="w-full rounded-lg border border-dashed border-[var(--color-border)] px-3 py-3 text-sm
                             text-[var(--color-fg-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
                >
                  {path
                    ? `選択済み: ${name || path}`
                    : `${provider === "google" ? "Google Drive" : "Dropbox"} からフォルダを選択`}
                </button>
              </div>
            )}
          </div>

          {/* 種類 */}
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-fg)]">
              種類
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="type"
                  value="common"
                  checked={type === "common"}
                  onChange={() => setType("common")}
                  className="text-[var(--color-accent)]"
                />
                共通フォルダ
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="type"
                  value="jobs"
                  checked={type === "jobs"}
                  onChange={() => setType("jobs")}
                  className="text-[var(--color-accent)]"
                />
                個別フォルダ
              </label>
            </div>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              共通: 常にAIが参照 / 個別: 有効時のみ参照
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]
                         transition-colors"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={!name.trim() || !path.trim()}
              className="rounded-lg bg-[var(--color-fg)] px-4 py-2 text-sm font-medium text-white
                         hover:opacity-90 disabled:bg-gray-300 disabled:cursor-not-allowed
                         transition-colors"
            >
              追加
            </button>
          </div>
        </form>
      </div>

      {showBrowser && (
        <FolderBrowser
          provider={provider}
          onSelect={handleBrowseSelect}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  );
}
