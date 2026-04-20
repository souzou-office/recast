"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface Props {
  filePath?: string;
  fileName: string;
  onClose: () => void;
  docxBase64?: string;
}

const RAW_VIEWABLE = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".html", ".htm"]);
// ブラウザ側で直接レンダリングできる Word（docx-preview で処理）
const BROWSER_DOCX = new Set([".docx", ".docm"]);
// LibreOffice が必要な古い Word / PowerPoint
const SERVER_DOCX = new Set([".doc", ".odt", ".ppt", ".pptx"]);
const EXCEL_EXTS = new Set([".xls", ".xlsx", ".ods"]);

function base64ToUint8(base64: string): Uint8Array {
  const byteChars = atob(base64);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
  return byteArray;
}

export default function FilePreview({ filePath, fileName, onClose, docxBase64 }: Props) {
  const ext = `.${(fileName.split(".").pop() || "").toLowerCase()}`;
  const isRawViewable = RAW_VIEWABLE.has(ext);
  const isBrowserDocx = BROWSER_DOCX.has(ext);
  const isServerDocx = SERVER_DOCX.has(ext);
  const isExcel = EXCEL_EXTS.has(ext);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [width, setWidth] = useState(50); // パーセント
  const [docxRenderKey, setDocxRenderKey] = useState(0); // 再レンダリングトリガー
  const docxContainerRef = useRef<HTMLDivElement | null>(null);

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

  // docx のブラウザ側レンダリング
  const renderDocxInBrowser = useCallback(async (buffer: ArrayBuffer | Uint8Array) => {
    if (!docxContainerRef.current) return;
    docxContainerRef.current.innerHTML = ""; // クリア
    try {
      const { renderAsync } = await import("docx-preview");
      await renderAsync(buffer, docxContainerRef.current, undefined, {
        className: "docx-preview",
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        breakPages: true,
      });
    } catch (err) {
      if (docxContainerRef.current) {
        docxContainerRef.current.textContent = `プレビューに失敗しました: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setBlobUrl(null);
    setTextContent(null);

    // base64 docx → ブラウザで直接レンダリング（LibreOffice 不要）
    if (docxBase64) {
      setDocxRenderKey(k => k + 1);
      (async () => {
        try {
          const bytes = base64ToUint8(docxBase64);
          await renderDocxInBrowser(bytes);
        } finally {
          setLoading(false);
        }
      })();
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
    } else if (isBrowserDocx) {
      // docx/docm → ブラウザで直接レンダリング
      setDocxRenderKey(k => k + 1);
      fetch("/api/workspace/raw-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error();
          const buf = await res.arrayBuffer();
          await renderDocxInBrowser(buf);
        })
        .catch(() => setTextContent("プレビューに失敗しました"))
        .finally(() => setLoading(false));
    } else if (isServerDocx) {
      // .doc / .ppt / .odt → LibreOffice 経由（docx-preview は非対応）
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
  }, [filePath, docxBase64, isRawViewable, isBrowserDocx, isServerDocx, isExcel, renderDocxInBrowser]);

  const handleDownload = async () => {
    if (docxBase64) {
      const blob = new Blob([base64ToUint8(docxBase64)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
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

  const showDocxContainer = isBrowserDocx || !!docxBase64;

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
          <p className="text-sm text-[var(--color-fg-subtle)] animate-pulse p-4">読込中...</p>
        ) : showDocxContainer ? (
          <div key={docxRenderKey} ref={docxContainerRef} className="w-full h-full overflow-auto bg-[var(--color-panel)] p-4" />
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
