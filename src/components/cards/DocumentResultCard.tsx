"use client";

import type { DocumentResultCard } from "@/types";

interface Props {
  card: DocumentResultCard;
  onPreview?: (file: { filePath?: string; docxBase64?: string; fileName: string }) => void;
}

function downloadDocx(base64: string, fileName: string) {
  const byteChars = atob(base64);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
  const blob = new Blob([byteArray], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName; a.click();
  URL.revokeObjectURL(url);
}

export default function DocumentResultCardUI({ card, onPreview }: Props) {
  return (
    <div className="rounded-lg border border-green-200 bg-green-50 p-3">
      <p className="text-xs font-medium text-green-700 mb-2">✅ 書類を生成しました</p>
      <div className="space-y-1">
        {card.documents.map((doc, i) => (
          <div key={i} className="flex items-center gap-2 rounded bg-white px-3 py-2 border border-gray-200">
            <span className="text-xs">📄</span>
            <span className="flex-1 text-xs text-gray-800 font-medium truncate">{doc.name}</span>
            <button
              onClick={() => onPreview?.({ docxBase64: doc.docxBase64, fileName: doc.fileName })}
              className="text-[10px] text-blue-500 hover:text-blue-700 shrink-0"
            >
              プレビュー
            </button>
            <button
              onClick={() => downloadDocx(doc.docxBase64, doc.fileName)}
              className="text-[10px] text-gray-500 hover:text-gray-700 shrink-0"
            >
              DL
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
