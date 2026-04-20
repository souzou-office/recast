"use client";

import { useState, useEffect, useCallback } from "react";

interface Props {
  filePath?: string;
  fileName: string;
  onClose: () => void;
  docxBase64?: string;
}

const RAW_VIEWABLE = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".html", ".htm"]);
const WORD_EXTS = new Set([".doc", ".docx", ".docm", ".odt", ".ppt", ".pptx"]);
const EXCEL_EXTS = new Set([".xls", ".xlsx", ".ods"]);

export default function FilePreview({ filePath, fileName, onClose, docxBase64 }: Props) {
  const ext = `.${(fileName.split(".").pop() || "").toLowerCase()}`;
  const isRawViewable = RAW_VIEWABLE.has(ext);
  const isWord = WORD_EXTS.has(ext);
  const isExcel = EXCEL_EXTS.has(ext);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [width, setWidth] = useState(50); // パーセント

  const handleDragStart = useCallback(() => {
    const handleMove = (e: MouseEvent) => {
      const container = document.getElementById("main-content-area");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const pct = 100 - ((e.clientX - rect.left) / rect.width) * 100;
      setWidth(Math.max(20, Math.min(80, pct)));
    };
    const handleUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, []);

  useEffect(() => {
    setLoading(true);
    setBlobUrl(null);
    setTextContent(null);

    // base64 docx → LibreOfficeでPDF変換
    if (docxBase64) {
      fetch("/api/workspace/preview-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64: docxBase64, fileName }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error();
          const blob = await res.blob();
          setBlobUrl(URL.createObjectURL(blob) + "#toolbar=1&navpanes=0&view=FitH");
        })
        .catch(() => setTextContent("プレビューに失敗しました"))
        .finally(() => setLoading(false));
      return;
    }

    if (!filePath) { setLoading(false); return; }

    if (isRawViewable) {
      fetch("/api/workspace/raw-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error();
          const blob = await res.blob();
          setBlobUrl(URL.createObjectURL(blob) + "#toolbar=1&navpanes=0&view=FitH");
        })
        .catch(() => setTextContent("ファイルを読み取れませんでした"))
        .finally(() => setLoading(false));
    } else if (isWord) {
      // Word/PPT → LibreOfficeでPDF変換
      fetch("/api/workspace/preview-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error();
          const blob = await res.blob();
          setBlobUrl(URL.createObjectURL(blob) + "#toolbar=1&navpanes=0&view=FitH");
        })
        .catch(() => setTextContent("プレビューに失敗しました"))
        .finally(() => setLoading(false));
    } else if (isExcel) {
      // Excel → LibreOfficeでHTML変換
      fetch("/api/workspace/preview-html", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.html) setBlobUrl("html:" + data.html);
          else setTextContent(data.error || "読み取れませんでした");
        })
        .catch(() => setTextContent("プレビューに失敗しました"))
        .finally(() => setLoading(false));
    } else {
      // テキスト系
      fetch("/api/workspace/read-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      })
        .then(r => r.json())
        .then(data => setTextContent(data.content || data.error || "読み取れませんでした"))
        .catch(() => setTextContent("読み取りに失敗しました"))
        .finally(() => setLoading(false));
    }

    return () => {
      setBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    };
  }, [filePath, docxBase64]);

  const handleDownload = async () => {
    if (docxBase64) {
      const byteChars = atob(docxBase64);
      const byteArray = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
      const blob = new Blob([byteArray], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fileName; a.click();
      URL.revokeObjectURL(url);
    } else if (filePath) {
      const res = await fetch("/api/workspace/raw-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fileName; a.click();
        URL.revokeObjectURL(url);
      }
    }
  };

  return (
    <>
    <div
      onMouseDown={handleDragStart}
      className="w-1.5 shrink-0 cursor-col-resize hover:bg-blue-300 active:bg-blue-400 transition-colors bg-gray-200"
    />
    <div className="flex flex-col border-l border-[var(--color-border)]" style={{ width: `${width}%` }}>
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2 bg-[var(--color-hover)]">
        <span className="text-xs text-[var(--color-fg-muted)] truncate font-medium">{fileName}</span>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={handleDownload} className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]">
            ダウンロード
          </button>
          <button onClick={onClose} className="text-xs text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)]">x</button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden bg-[var(--color-hover)]">
        {loading ? (
          <p className="text-sm text-[var(--color-fg-subtle)] animate-pulse p-4">変換中...</p>
        ) : blobUrl?.startsWith("html:") ? (
          <iframe srcDoc={blobUrl.slice(5)} className="w-full h-full border-0 bg-[var(--color-panel)]" />
        ) : blobUrl ? (
          <iframe src={blobUrl} className="w-full h-full border-0" />
        ) : (
          <pre className="text-xs text-[var(--color-fg)] whitespace-pre-wrap font-mono leading-relaxed p-4 overflow-y-auto h-full bg-[var(--color-panel)]">{textContent}</pre>
        )}
      </div>
    </div>
    </>
  );
}
