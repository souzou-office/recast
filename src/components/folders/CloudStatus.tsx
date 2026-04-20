"use client";

import { useState, useEffect, useCallback } from "react";

interface AuthStatus {
  google: boolean;
  dropbox: boolean;
}

export default function CloudStatus() {
  const [status, setStatus] = useState<AuthStatus>({ google: false, dropbox: false });

  const fetchStatus = useCallback(async () => {
    const res = await fetch("/api/auth/status");
    if (res.ok) setStatus(await res.json());
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleDisconnect = async (provider: "google" | "dropbox") => {
    if (!confirm(`${provider === "google" ? "Google Drive" : "Dropbox"} の接続を解除しますか？`)) return;
    const res = await fetch("/api/auth/status", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    if (res.ok) setStatus(await res.json());
  };

  return (
    <div className="space-y-2">
      {/* Google Drive */}
      <div className="flex items-center justify-between rounded-lg bg-[var(--color-panel)] px-3 py-2">
        <span className="text-xs text-[var(--color-fg-muted)]">Google Drive</span>
        {status.google ? (
          <button
            onClick={() => handleDisconnect("google")}
            className="text-xs text-[var(--color-ok-fg)] hover:text-red-500 transition-colors"
          >
            接続中
          </button>
        ) : (
          <a
            href="/api/auth/google"
            className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] transition-colors"
          >
            接続
          </a>
        )}
      </div>

      {/* Dropbox */}
      <div className="flex items-center justify-between rounded-lg bg-[var(--color-panel)] px-3 py-2">
        <span className="text-xs text-[var(--color-fg-muted)]">Dropbox</span>
        {status.dropbox ? (
          <button
            onClick={() => handleDisconnect("dropbox")}
            className="text-xs text-[var(--color-ok-fg)] hover:text-red-500 transition-colors"
          >
            接続中
          </button>
        ) : (
          <a
            href="/api/auth/dropbox"
            className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] transition-colors"
          >
            接続
          </a>
        )}
      </div>
    </div>
  );
}
