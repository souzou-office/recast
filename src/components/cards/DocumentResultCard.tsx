"use client";

import type { DocumentResultCard } from "@/types";

interface Props {
  card: DocumentResultCard;
  onPreview?: (file: { filePath?: string; docxBase64?: string; fileName: string }) => void;
}

function base64ToBytes(base64: string): Uint8Array {
  const byteChars = atob(base64);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
  return byteArray;
}

function downloadDocx(base64: string, fileName: string) {
  const blob = new Blob([base64ToBytes(base64)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName; a.click();
  URL.revokeObjectURL(url);
}

async function downloadAllZip(docs: { docxBase64: string; fileName: string }[]) {
  // PizZipで全ファイルをまとめて1つのzipにしてダウンロード
  const PizZip = (await import("pizzip")).default;
  const zip = new PizZip();
  for (const d of docs) {
    zip.file(d.fileName, base64ToBytes(d.docxBase64));
  }
  const blob = zip.generate({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  a.href = url; a.download = `書類一式_${ts}.zip`; a.click();
  URL.revokeObjectURL(url);
}

export default function DocumentResultCardUI({ card, onPreview }: Props) {
  return (
    <div className="rounded-lg border border-green-200 bg-green-50 p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-green-700">✅ 書類を生成しました</p>
        {card.documents.length > 1 && (
          <button
            onClick={() => downloadAllZip(card.documents)}
            className="rounded-lg bg-green-600 px-3 py-1 text-[10px] font-medium text-white hover:bg-green-700"
          >
            すべてZIPでDL
          </button>
        )}
      </div>
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
