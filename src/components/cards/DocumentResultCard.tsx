"use client";

import type { DocumentResultCard, DocumentResultItem, CheckIssue } from "@/types";
import { Icon } from "@/components/ui/Icon";

interface Props {
  card: DocumentResultCard;
  onPreview?: (file: {
    filePath?: string;
    docxBase64?: string;
    fileName: string;
    templatePath?: string;
    filledSlots?: import("@/types").FilledSlot[];
    issues?: CheckIssue[];
    docName?: string;
  }) => void;
  // 書類ごとに「問題なし」を手動でマークする（確認済み扱い）
  onMarkOk?: (fileName: string) => void;
  // 個別の指摘を「確認済み」にする/戻す（slotId に紐付かない指摘でも使える）
  onIssueAck?: (fileName: string, issueIndex: number, ack: boolean) => void;
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

function statusBadge(status?: "ok" | "warn" | "error") {
  if (!status) return null;
  if (status === "ok") {
    return <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-ok-fg)]"><Icon name="CheckCircle2" size={11} /> 問題なし</span>;
  }
  if (status === "warn") {
    return <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-warn-fg)]"><Icon name="AlertTriangle" size={11} /> 要確認</span>;
  }
  return <span className="inline-flex items-center gap-1 text-[10px] text-red-600"><Icon name="AlertCircle" size={11} /> 要修正</span>;
}

function severityDot(sev: CheckIssue["severity"]) {
  const color = sev === "error" ? "bg-red-500" : sev === "warn" ? "bg-[var(--color-warn-fg)]" : "bg-[var(--color-accent)]";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${color}`} />;
}

function DocumentRow({ doc, onPreview, onMarkOk, onIssueAck }: { doc: DocumentResultItem; onPreview?: Props["onPreview"]; onMarkOk?: Props["onMarkOk"]; onIssueAck?: Props["onIssueAck"] }) {
  const ext = doc.fileName.split(".").pop()?.toLowerCase() || "";
  const iconName = ext === "pdf" ? "FileType" : ["xlsx", "xls", "xlsm", "csv"].includes(ext) ? "FileSpreadsheet" : "FileText";
  // 全指摘 + 元のインデックス（確認済みの「戻す」リンク用）。ack 済みは末尾に薄く表示。
  const allIssuesIndexed = (doc.issues || []).map((iss, idx) => ({ iss, idx }));
  const activeIssues = allIssuesIndexed.filter(({ iss }) => !iss.acknowledged);
  const ackedIssues = allIssuesIndexed.filter(({ iss }) => iss.acknowledged);
  const hasIssues = activeIssues.length > 0 || ackedIssues.length > 0;
  const isOk = doc.checkStatus === "ok";

  return (
    <div className={`rounded-lg border ${hasIssues ? "border-[var(--color-border)]" : "border-[var(--color-border-soft)]"} bg-[var(--color-panel)] overflow-hidden`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon name={iconName} size={14} className="text-[var(--color-fg-muted)] shrink-0" />
        <span className="flex-1 text-[13px] text-[var(--color-fg)] font-medium truncate">{doc.name}</span>
        {doc.pendingChanges && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] text-[var(--color-accent-fg)] font-medium" title="編集タブで保存された変更が docx に未反映">
            <Icon name="Clock" size={10} /> 更新待ち
          </span>
        )}
        {statusBadge(doc.checkStatus)}
        <button
          onClick={() => onPreview?.({
            docxBase64: doc.docxBase64,
            fileName: doc.fileName,
            templatePath: doc.templatePath,
            filledSlots: doc.filledSlots,
            issues: doc.issues,
            docName: doc.name,
          })}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]"
          title="プレビュー"
        >
          <Icon name="Eye" size={12} />
        </button>
        {!isOk && onMarkOk && (
          <button
            onClick={() => onMarkOk(doc.fileName)}
            className="inline-flex items-center gap-1 text-[11px] text-[var(--color-ok-fg)] hover:bg-[var(--color-ok-bg)] rounded px-1 py-0.5"
            title="問題なし（確認済み）にする"
          >
            <Icon name="CheckCircle2" size={12} />
          </button>
        )}
        <button
          onClick={() => downloadDocx(doc.docxBase64, doc.fileName)}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          title="ダウンロード"
        >
          <Icon name="Download" size={12} />
        </button>
      </div>
      {hasIssues && (
        <div className="px-3 pb-2.5 pt-0.5 border-t border-[var(--color-border-soft)] bg-[var(--color-warn-bg)]/30">
          <ul className="space-y-1.5 mt-2">
            {activeIssues.map(({ iss, idx }) => (
              <li key={idx} className="flex items-start gap-2 text-[12px]">
                {severityDot(iss.severity)}
                <div className="flex-1 leading-relaxed">
                  <span className="text-[var(--color-fg)]">{iss.problem}</span>
                  {iss.expected && (
                    <span className="text-[var(--color-fg-muted)]"> （原本: {iss.expected}）</span>
                  )}
                  {iss.aspect && (
                    <span className="ml-2 text-[10.5px] text-[var(--color-fg-subtle)]">[{iss.aspect}]</span>
                  )}
                </div>
                {onIssueAck && (
                  <button
                    onClick={() => onIssueAck(doc.fileName, idx, true)}
                    className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-white border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-muted)] hover:bg-[var(--color-ok-bg)] hover:text-[var(--color-ok-fg)] hover:border-[var(--color-ok-fg)]"
                    title="この指摘を確認済みにする"
                  >
                    <Icon name="CheckCircle2" size={10} /> 確認済み
                  </button>
                )}
              </li>
            ))}
            {ackedIssues.length > 0 && (
              <li className="pt-1.5 border-t border-[var(--color-border-soft)] mt-1.5">
                <div className="text-[10px] text-[var(--color-fg-subtle)] mb-1">確認済みの指摘 ({ackedIssues.length}件)</div>
                <ul className="space-y-1">
                  {ackedIssues.map(({ iss, idx }) => (
                    <li key={idx} className="flex items-start gap-2 text-[11px] opacity-60">
                      <Icon name="CheckCircle2" size={11} className="text-[var(--color-ok-fg)] mt-0.5 shrink-0" />
                      <div className="flex-1 leading-relaxed line-through">
                        {iss.problem}
                      </div>
                      {onIssueAck && (
                        <button
                          onClick={() => onIssueAck(doc.fileName, idx, false)}
                          className="shrink-0 text-[10px] text-[var(--color-fg-subtle)] underline hover:text-[var(--color-fg)]"
                          title="確認済みを解除"
                        >
                          戻す
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function DocumentResultCardUI({ card, onPreview, onMarkOk, onIssueAck, onBulkRegenerate }: Props) {
  // 編集タブで保存されたが未反映の書類数
  const pendingCount = card.documents.filter(d => d.pendingChanges).length;
  // 解決済み (acknowledged) の指摘はカウントから除外
  const totalIssues = card.documents.reduce(
    (sum, d) => sum + ((d.issues || []).filter(iss => !iss.acknowledged).length),
    0,
  );
  const hasChecked = card.documents.some(d => d.checkStatus !== undefined);
  const anyError = card.documents.some(d => d.checkStatus === "error");
  const anyWarn = card.documents.some(d => d.checkStatus === "warn");

  const headerBg = !hasChecked
    ? "bg-[var(--color-ok-bg)] text-[var(--color-ok-fg)]"
    : anyError
      ? "bg-red-50 text-red-700"
      : anyWarn
        ? "bg-[var(--color-warn-bg)] text-[var(--color-warn-fg)]"
        : "bg-[var(--color-ok-bg)] text-[var(--color-ok-fg)]";
  const headerIcon = !hasChecked ? "CheckCircle2" : anyError ? "AlertCircle" : anyWarn ? "AlertTriangle" : "CheckCircle2";
  const headerLabel = !hasChecked
    ? "書類を生成しました"
    : totalIssues === 0
      ? "全書類、原本と一致"
      : `${totalIssues}件 要確認`;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] overflow-hidden">
      <div className={`px-4 py-2.5 text-xs font-medium border-b border-[var(--color-border-soft)] flex items-center justify-between gap-2 ${headerBg}`}>
        <span className="inline-flex items-center gap-1.5">
          <Icon name={headerIcon} size={14} /> {headerLabel}
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
          <DocumentRow key={i} doc={doc} onPreview={onPreview} onMarkOk={onMarkOk} onIssueAck={onIssueAck} />
        ))}
      </div>
      {card.checkSummary && (
        <div className="px-4 py-2 border-t border-[var(--color-border-soft)] text-[11px] text-[var(--color-fg-muted)] bg-[var(--color-bg)]">
          {card.checkSummary}
        </div>
      )}
    </div>
  );
}
