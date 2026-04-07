"use client";

import { useState, useEffect, useRef } from "react";

interface Props {
  filePath?: string;
  fileName: string;
  onClose: () => void;
  // base64データから直接表示（生成書類用）
  docxBase64?: string;
}

const RAW_VIEWABLE = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".html", ".htm"]);
const DOCX_EXTS = new Set([".doc", ".docx"]);
const XLSX_EXTS = new Set([".xls", ".xlsx"]);

export default function FilePreview({ filePath, fileName, onClose, docxBase64 }: Props) {
  const ext = `.${(fileName.split(".").pop() || "").toLowerCase()}`;
  const isRawViewable = RAW_VIEWABLE.has(ext);
  const isDocx = DOCX_EXTS.has(ext);
  const isXlsx = XLSX_EXTS.has(ext);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const docxContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setBlobUrl(null);
    setHtmlContent(null);
    setTextContent(null);

    // base64 docxを直接表示
    if (docxBase64) {
      renderDocxFromBase64(docxBase64);
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
          setBlobUrl(URL.createObjectURL(blob));
        })
        .catch(() => setTextContent("ファイルを読み取れませんでした"))
        .finally(() => setLoading(false));
    } else if (isDocx) {
      // docxはraw-fileで取得してdocx-previewでレンダリング
      fetch("/api/workspace/raw-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error();
          const blob = await res.blob();
          const arrayBuffer = await blob.arrayBuffer();
          renderDocxBuffer(arrayBuffer);
        })
        .catch(() => { setTextContent("ファイルを読み取れませんでした"); setLoading(false); });
    } else if (isXlsx) {
      // ExcelはHTMLテーブル
      fetch("/api/workspace/read-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, format: "html" }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.html) setHtmlContent(data.html);
          else setTextContent(data.error || "読み取れませんでした");
        })
        .catch(() => setTextContent("読み取りに失敗しました"))
        .finally(() => setLoading(false));
    } else {
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

  const renderDocxFromBase64 = async (base64: string) => {
    try {
      const byteChars = atob(base64);
      const byteArray = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
      renderDocxBuffer(byteArray.buffer);
    } catch {
      setTextContent("docxの表示に失敗しました");
      setLoading(false);
    }
  };

  const renderDocxBuffer = async (buffer: ArrayBuffer) => {
    try {
      const docxPreview = await import("docx-preview");
      setLoading(false);
      // 少し遅延してDOMが準備できてからレンダリング
      setTimeout(() => {
        if (docxContainerRef.current) {
          docxContainerRef.current.innerHTML = "";
          docxPreview.renderAsync(buffer, docxContainerRef.current, undefined, {
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
          });
        }
      }, 50);
    } catch {
      setTextContent("docxの表示に失敗しました");
      setLoading(false);
    }
  };

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
    <div className="flex w-1/2 flex-col border-l border-gray-200">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2 bg-gray-50">
        <span className="text-xs text-gray-600 truncate font-medium">{fileName}</span>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={handleDownload} className="text-[10px] text-blue-500 hover:text-blue-700">
            ダウンロード
          </button>
          <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
        </div>
      </div>
      <div className="flex-1 overflow-auto bg-gray-100">
        {loading ? (
          <p className="text-sm text-gray-400 animate-pulse p-4">読み込み中...</p>
        ) : blobUrl ? (
          <iframe src={blobUrl} className="w-full h-full border-0" />
        ) : isDocx || docxBase64 ? (
          <div ref={docxContainerRef} className="bg-gray-100 min-h-full" />
        ) : htmlContent ? (
          <div className="p-4 overflow-y-auto h-full text-sm text-gray-800 bg-white"
            dangerouslySetInnerHTML={{ __html: htmlContent }} />
        ) : (
          <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono leading-relaxed p-4 overflow-y-auto h-full bg-white">{textContent}</pre>
        )}
      </div>
    </div>
  );
}
