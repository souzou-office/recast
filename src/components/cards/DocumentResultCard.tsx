"use client";

import type { DocumentResultCard } from "@/types";
import { Icon } from "@/components/ui/Icon";

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
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] overflow-hidden">
      <div className="px-4 py-2.5 bg-[var(--color-ok-bg)] text-[var(--color-ok-fg)] text-xs font-medium border-b border-[var(--color-border-soft)] flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="CheckCircle2" size={14} /> 書類を生成しました
        </span>
        {card.documents.length > 1 && (
          <button
            onClick={() => downloadAllZip(card.documents)}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-ok-fg)] px-3 py-1 text-[10px] font-medium text-[var(--color-ok-bg)] hover:opacity-90"
          >
            <Icon name="Download" size={11} /> すべてZIP
          </button>
        )}
      </div>
      <div className="p-3 space-y-1">
        {card.documents.map((doc, i) => (
          <div key={i} className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2">
            <Icon name="FileText" size={13} className="text-[var(--color-fg-muted)] shrink-0" />
            <span className="flex-1 text-xs text-[var(--color-fg)] font-medium truncate">{doc.name}</span>
            <button
              onClick={() => onPreview?.({ docxBase64: doc.docxBase64, fileName: doc.fileName })}
              className="inline-flex items-center gap-1 text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] shrink-0"
            >
              <Icon name="Eye" size={12} /> プレビュー
            </button>
            <button
              onClick={() => downloadDocx(doc.docxBase64, doc.fileName)}
              className="inline-flex items-center gap-1 text-[10px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] shrink-0"
            >
              <Icon name="Download" size={12} /> DL
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
