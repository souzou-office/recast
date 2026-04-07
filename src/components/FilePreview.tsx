"use client";

import { useState, useEffect } from "react";

interface Props {
  filePath?: string;
  fileName: string;
  onClose: () => void;
  docxBase64?: string;
}

const RAW_VIEWABLE = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".html", ".htm"]);
const WORD_EXTS = new Set([".doc", ".docx", ".odt", ".ppt", ".pptx"]);
const EXCEL_EXTS = new Set([".xls", ".xlsx", ".ods"]);

export default function FilePreview({ filePath, fileName, onClose, docxBase64 }: Props) {
  const ext = `.${(fileName.split(".").pop() || "").toLowerCase()}`;
  const isRawViewable = RAW_VIEWABLE.has(ext);
  const isWord = WORD_EXTS.has(ext);
  const isExcel = EXCEL_EXTS.has(ext);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
          setBlobUrl(URL.createObjectURL(blob));
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
          setBlobUrl(URL.createObjectURL(blob));
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
          setBlobUrl(URL.createObjectURL(blob));
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
      <div className="flex-1 overflow-hidden bg-gray-100">
        {loading ? (
          <p className="text-sm text-gray-400 animate-pulse p-4">変換中...</p>
        ) : blobUrl?.startsWith("html:") ? (
          <iframe srcDoc={blobUrl.slice(5)} className="w-full h-full border-0 bg-white" />
        ) : blobUrl ? (
          <iframe src={blobUrl} className="w-full h-full border-0" />
        ) : (
          <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono leading-relaxed p-4 overflow-y-auto h-full bg-white">{textContent}</pre>
        )}
      </div>
    </div>
  );
}
