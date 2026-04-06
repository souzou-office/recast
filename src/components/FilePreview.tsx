"use client";

import { useState, useEffect } from "react";

interface Props {
  filePath: string;
  fileName: string;
  onClose: () => void;
}

const RAW_VIEWABLE = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".html", ".htm"]);
const OFFICE_EXTS = new Set([".doc", ".docx", ".xls", ".xlsx"]);

export default function FilePreview({ filePath, fileName, onClose }: Props) {
  const ext = `.${(fileName.split(".").pop() || "").toLowerCase()}`;
  const isRawViewable = RAW_VIEWABLE.has(ext);
  const isOffice = OFFICE_EXTS.has(ext);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setBlobUrl(null);
    setHtmlContent(null);
    setTextContent(null);

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
    } else if (isOffice) {
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
  }, [filePath]);

  return (
    <div className="flex w-1/2 flex-col border-l border-gray-200">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2 bg-gray-50">
        <span className="text-xs text-gray-600 truncate font-medium">{fileName}</span>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={async () => {
              const res = await fetch("/api/workspace/raw-file", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: filePath }),
              });
              if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = fileName;
                a.click();
                URL.revokeObjectURL(url);
              }
            }}
            className="text-[10px] text-blue-500 hover:text-blue-700"
          >
            ダウンロード
          </button>
          <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <p className="text-sm text-gray-400 animate-pulse p-4">読み込み中...</p>
        ) : blobUrl ? (
          <iframe src={blobUrl} className="w-full h-full border-0" />
        ) : htmlContent ? (
          <div
            className="p-4 overflow-y-auto h-full text-sm text-gray-800"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
            style={{
              // Excelテーブルのスタイル補正
              // @ts-expect-error -- CSS custom properties
              "--tw-prose-body": undefined,
            }}
          />
        ) : (
          <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono leading-relaxed p-4 overflow-y-auto h-full">{textContent}</pre>
        )}
      </div>
      {/* ExcelテーブルのCSS */}
      {htmlContent && (
        <style>{`
          .flex > div:last-child table {
            border-collapse: collapse;
            width: 100%;
            font-size: 12px;
          }
          .flex > div:last-child td, .flex > div:last-child th {
            border: 1px solid #d1d5db;
            padding: 4px 8px;
            text-align: left;
          }
          .flex > div:last-child th {
            background: #f3f4f6;
            font-weight: 600;
          }
          .flex > div:last-child tr:nth-child(even) {
            background: #f9fafb;
          }
        `}</style>
      )}
    </div>
  );
}
