"use client";

import type { DocumentResultCard, DocumentResultItem, CheckIssue, FilledSlot } from "@/types";
import { Icon } from "@/components/ui/Icon";

interface Props {
  card: DocumentResultCard;
  onPreview?: (file: {
    filePath?: string;
    docxBase64?: string;
    fileName: string;
    templatePath?: string;
    filledSlots?: FilledSlot[];
    issues?: CheckIssue[];
    docName?: string;
  }) => void;
  // 編集タブで保存された変更を一括で再生成する
  onBulkRegenerate?: () => void;
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

// 全書類を「個別ファイル」として連続ダウンロード（フォールバック）。
// ブラウザの DL フォルダに自動で入る。連続 DL は初回ブラウザ確認あり。
async function downloadAllIndividually(docs: { docxBase64: string; fileName: string }[]) {
  for (const d of docs) {
    const isXlsx = /\.xlsx?$/i.test(d.fileName);
    const mime = isXlsx
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const blob = new Blob([base64ToBytes(d.docxBase64)], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = d.fileName; a.click();
    URL.revokeObjectURL(url);
    // ブラウザによっては連続クリックを束ねてしまうので少し待つ
    await new Promise(r => setTimeout(r, 150));
  }
}

// File System Access API（Chrome/Edge）対応ブラウザでは保存先フォルダを選べる
// 非対応ブラウザ（Safari/Firefox）は通常の個別 DL にフォールバック
type DirHandle = {
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<{
    createWritable: () => Promise<{ write: (data: ArrayBuffer | Blob | Uint8Array) => Promise<void>; close: () => Promise<void>; }>;
  }>;
};
type WithPicker = Window & { showDirectoryPicker?: (opts?: { id?: string; mode?: "read" | "readwrite"; startIn?: string }) => Promise<DirHandle> };

async function downloadAllToFolder(docs: { docxBase64: string; fileName: string }[]) {
  const w = window as WithPicker;
  if (typeof w.showDirectoryPicker !== "function") {
    // 非対応ブラウザ → 個別 DL にフォールバック
    await downloadAllIndividually(docs);
    return;
  }
  let dirHandle: DirHandle;
  try {
    dirHandle = await w.showDirectoryPicker({ id: "recast-output", mode: "readwrite", startIn: "downloads" });
  } catch {
    // ユーザーがキャンセル → 何もしない
    return;
  }
  let written = 0;
  for (const d of docs) {
    try {
      const fileHandle = await dirHandle.getFileHandle(d.fileName, { create: true });
      const writable = await fileHandle.createWritable();
      // Uint8Array はそのまま書き込み可（File System Access API）
      const bytes = base64ToBytes(d.docxBase64);
      await writable.write(bytes as unknown as Uint8Array);
      await writable.close();
      written++;
    } catch (e) {
      console.error(`[downloadAllToFolder] ${d.fileName} failed:`, e);
    }
  }
  if (written < docs.length) {
    alert(`${docs.length} 件中 ${written} 件のみ保存できました。残りは権限エラー等で失敗しました。`);
  }
}

function DocumentRow({ doc, onPreview }: { doc: DocumentResultItem; onPreview?: Props["onPreview"] }) {
  const ext = doc.fileName.split(".").pop()?.toLowerCase() || "";
  const iconName = ext === "pdf" ? "FileType" : ["xlsx", "xls", "xlsm", "csv"].includes(ext) ? "FileSpreadsheet" : "FileText";

  return (
    <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-panel)] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon name={iconName} size={14} className="text-[var(--color-fg-muted)] shrink-0" />
        <span className="flex-1 text-[13px] text-[var(--color-fg)] font-medium truncate">{doc.name}</span>
        {doc.pendingChanges && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] text-[var(--color-accent-fg)] font-medium" title="編集タブで保存された変更が docx に未反映">
            <Icon name="Clock" size={10} /> 更新待ち
          </span>
        )}
        <button
          onClick={() => onPreview?.({
            docxBase64: doc.docxBase64,
            fileName: doc.fileName,
            templatePath: doc.templatePath,
            filledSlots: doc.filledSlots,
            docName: doc.name,
          })}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]"
          title="プレビュー"
        >
          <Icon name="Eye" size={12} />
        </button>
        <button
          onClick={() => downloadDocx(doc.docxBase64, doc.fileName)}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          title="ダウンロード"
        >
          <Icon name="Download" size={12} />
        </button>
      </div>
    </div>
  );
}

export default function DocumentResultCardUI({ card, onPreview, onBulkRegenerate }: Props) {
  // 編集タブで保存されたが未反映の書類数
  const pendingCount = card.documents.filter(d => d.pendingChanges).length;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] overflow-hidden">
      <div className="px-4 py-2.5 text-xs font-medium border-b border-[var(--color-border-soft)] bg-[var(--color-ok-bg)] text-[var(--color-ok-fg)] flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="CheckCircle2" size={14} /> 書類を生成しました
        </span>
        <div className="flex items-center gap-2">
          {pendingCount > 0 && onBulkRegenerate && (
            <button
              onClick={() => onBulkRegenerate()}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-3 py-1 text-[10px] font-medium text-white hover:opacity-90"
              title={`${pendingCount}件の書類を一括再生成`}
            >
              <Icon name="RefreshCcw" size={11} /> 更新待ち {pendingCount} 件を再生成
            </button>
          )}
          {card.documents.length > 1 && (
            <>
              <button
                onClick={() => downloadAllToFolder(card.documents)}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-fg)] px-3 py-1 text-[10px] font-medium text-[var(--color-bg)] hover:opacity-90"
                title="保存先フォルダを選んで全書類を保存（Chrome/Edge）"
              >
                <Icon name="FolderDown" size={11} /> フォルダ指定DL
              </button>
              <button
                onClick={() => downloadAllIndividually(card.documents)}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-white px-3 py-1 text-[10px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
                title="ブラウザの DL フォルダに個別ファイルとして連続保存"
              >
                <Icon name="Download" size={11} /> DLフォルダへ
              </button>
            </>
          )}
        </div>
      </div>
      <div className="p-3 space-y-1.5">
        {card.documents.map((doc, i) => (
          <DocumentRow key={i} doc={doc} onPreview={onPreview} />
        ))}
      </div>
    </div>
  );
}
