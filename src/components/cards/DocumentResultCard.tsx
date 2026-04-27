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

function DocumentRow({ doc, onPreview, onMarkOk }: { doc: DocumentResultItem; onPreview?: Props["onPreview"]; onMarkOk?: Props["onMarkOk"] }) {
  const ext = doc.fileName.split(".").pop()?.toLowerCase() || "";
  const iconName = ext === "pdf" ? "FileType" : ["xlsx", "xls", "xlsm", "csv"].includes(ext) ? "FileSpreadsheet" : "FileText";
  // acknowledged な指摘は「解決済み」扱いで表示・カウントから除く
  const activeIssues = (doc.issues || []).filter(iss => !iss.acknowledged);
  const hasIssues = activeIssues.length > 0;
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
            {activeIssues.map((iss, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px]">
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
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function DocumentResultCardUI({ card, onPreview, onMarkOk, onBulkRegenerate }: Props) {
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
            <button
              onClick={() => downloadAllZip(card.documents)}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-fg)] px-3 py-1 text-[10px] font-medium text-[var(--color-bg)] hover:opacity-90"
            >
              <Icon name="Download" size={11} /> すべてZIP
            </button>
          )}
        </div>
      </div>
      <div className="p-3 space-y-1.5">
        {card.documents.map((doc, i) => (
          <DocumentRow key={i} doc={doc} onPreview={onPreview} onMarkOk={onMarkOk} />
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
