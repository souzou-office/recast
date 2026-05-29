"use client";

// 書類プレビューパネル — 1 タブ分の表示を担当。
//
// 表示エンジンの振り分け (拡張子で判定):
//   - docx / docm / xls / xlsx / xlsm → /api/workspace/preview-html (OfficeCLI screenshot → PNG)
//   - pdf                              → /api/workspace/raw-file (ブラウザネイティブ表示)
//   - 画像 (png/jpg/jpeg/gif/webp)     → /api/workspace/raw-file (img タグ)
//   - html / htm                       → /api/workspace/raw-file (iframe)
//   - その他 (txt 等)                  → /api/workspace/read-file (テキスト表示)
//
// 設計方針:
//   - LibreOffice ・ docx-preview ・ sheetjs 等のクライアント側レンダリングは廃止 (OfficeCLI 一本化)
//   - キャッシュは src/lib/preview-cache.ts、サーバ側にも同等のキャッシュあり
//   - キャッシュヒット時はローディング状態を挟まない (タブ切替のフリッカー対策)

import { useState, useEffect, useRef } from "react";
import DocumentValueEditor from "./DocumentValueEditor";
import type { FilledSlot, CheckIssue } from "@/types";
import { getCacheKey, getCached, setCached } from "@/lib/preview-cache";

const OFFICE_EXTS = new Set([".docx", ".docm", ".xls", ".xlsx", ".xlsm"]);
const PDF_EXTS = new Set([".pdf"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const HTML_EXTS = new Set([".html", ".htm"]);
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface Props {
  filePath?: string;
  docxBase64?: string;
  fileName: string;
  onClose: () => void;
  // 値の編集タブ用 (生成済み書類のみ)
  filledSlots?: FilledSlot[];
  templatePath?: string;
  companyId?: string;
  threadId?: string;
  verifyIssues?: { docName: string; issues: CheckIssue[] }[];
  onRegenerated?: (docxBase64: string, filledSlots: FilledSlot[]) => void;
  onSaveValues?: (filledSlots: FilledSlot[]) => void;
  onIssueAcknowledge?: (slotId: number, acknowledged: boolean) => void;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "html"; html: string }            // iframe srcDoc (PNG 埋め込み HTML)
  | { kind: "url"; url: string; mime: "pdf" | "image" | "html" }  // raw blob 経由
  | { kind: "text"; text: string }            // テキスト系
  | { kind: "error"; message: string }
  | { kind: "unsupported"; ext: string };

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function getExt(fileName: string): string {
  const m = fileName.match(/\.[^./\\]+$/);
  return m ? m[0].toLowerCase() : "";
}

export default function FilePreview({
  filePath, docxBase64, fileName, onClose,
  filledSlots, templatePath, companyId, threadId, verifyIssues,
  onRegenerated, onSaveValues, onIssueAcknowledge,
}: Props) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const canEdit = !!(filledSlots && templatePath && companyId && onRegenerated);
  const [activeTab, setActiveTab] = useState<"preview" | "edit">("preview");

  // URL.createObjectURL で作った URL を後始末するための ref
  const objectUrlRef = useRef<string | null>(null);
  const revokeObjectUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  useEffect(() => {
    const ext = getExt(fileName);
    let cancelled = false;

    // -- Office 系 (docx / xlsx) → preview-html route --
    if (OFFICE_EXTS.has(ext)) {
      const key = getCacheKey({ filePath, docxBase64 });
      const cached = key ? getCached(key) : undefined;
      if (cached) {
        // キャッシュヒット: loading 表示を挟まずに即時切替 (フリッカー回避)
        setState({ kind: "html", html: cached });
        return () => { cancelled = true; };
      }
      setState({ kind: "loading" });
      fetch("/api/workspace/preview-html", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, docxBase64, fileName }),
      })
        .then(r => r.json())
        .then(data => {
          if (cancelled) return;
          if (data?.html) {
            if (key) setCached(key, data.html);
            setState({ kind: "html", html: data.html });
          } else {
            setState({ kind: "error", message: data?.error || "プレビュー生成に失敗しました" });
          }
        })
        .catch(e => {
          if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : "通信エラー" });
        });
      return () => { cancelled = true; };
    }

    // -- PDF / 画像 / HTML → raw blob --
    const rawMime: "pdf" | "image" | "html" | null =
      PDF_EXTS.has(ext) ? "pdf"
      : IMAGE_EXTS.has(ext) ? "image"
      : HTML_EXTS.has(ext) ? "html"
      : null;
    if (rawMime && filePath) {
      setState({ kind: "loading" });
      fetch("/api/workspace/raw-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      })
        .then(async r => {
          if (!r.ok) throw new Error("ファイルを読み取れませんでした");
          const blob = await r.blob();
          revokeObjectUrl();
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          if (cancelled) { revokeObjectUrl(); return; }
          const suffix = rawMime === "pdf" ? "#toolbar=1&navpanes=0&view=FitH" : "";
          setState({ kind: "url", url: url + suffix, mime: rawMime });
        })
        .catch(e => {
          if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : "読込エラー" });
        });
      return () => { cancelled = true; revokeObjectUrl(); };
    }

    // -- テキスト系 → read-file route --
    if (filePath && !OFFICE_EXTS.has(ext)) {
      setState({ kind: "loading" });
      fetch("/api/workspace/read-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      })
        .then(r => r.json())
        .then(data => {
          if (cancelled) return;
          if (typeof data?.content === "string") {
            setState({ kind: "text", text: data.content });
          } else {
            setState({ kind: "unsupported", ext });
          }
        })
        .catch(() => {
          if (!cancelled) setState({ kind: "unsupported", ext });
        });
      return () => { cancelled = true; };
    }

    // ここまで来たら表示できない (filePath も無いし上の判定に該当しない)
    setState({ kind: "unsupported", ext });
    return () => { cancelled = true; };
  }, [filePath, docxBase64, fileName]);

  // unmount で objectURL 解放
  useEffect(() => () => { revokeObjectUrl(); }, []);

  // ダウンロード
  const handleDownload = async () => {
    if (docxBase64) {
      const ext = getExt(fileName);
      const mime = (ext === ".xls" || ext === ".xlsx" || ext === ".xlsm") ? XLSX_MIME : DOCX_MIME;
      const blob = new Blob([base64ToUint8(docxBase64)], { type: mime });
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

  // ---- レンダー ----
  return (
    <div className="flex flex-col border-l border-[var(--color-border)] flex-1 min-w-0">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2 bg-[var(--color-hover)]">
        <span className="text-xs text-[var(--color-fg-muted)] truncate font-medium">{fileName}</span>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={handleDownload} className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]">
            ダウンロード
          </button>
          <button onClick={onClose} className="text-xs text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)]">x</button>
        </div>
      </div>
      {canEdit && (
        <div className="flex items-center gap-0 border-b border-[var(--color-border-soft)] bg-[var(--color-panel)] px-2">
          <TabButton active={activeTab === "preview"} onClick={() => setActiveTab("preview")}>プレビュー</TabButton>
          <TabButton active={activeTab === "edit"} onClick={() => setActiveTab("edit")}>修正</TabButton>
        </div>
      )}
      {/* プレビューと修正は両方とも常にマウントしておき display で切替 */}
      <div
        className="flex-1 overflow-hidden bg-[var(--color-hover)]"
        style={{ display: canEdit && activeTab === "edit" ? "none" : "block" }}
      >
        <PreviewBody state={state} />
      </div>
      {canEdit && (
        <div
          className="flex-1 overflow-hidden"
          style={{ display: activeTab === "edit" ? "block" : "none" }}
        >
          <DocumentValueEditor
            filledSlots={filledSlots!}
            templatePath={templatePath!}
            fileName={fileName}
            companyId={companyId!}
            threadId={threadId}
            verifyIssues={verifyIssues}
            onRegenerated={onRegenerated!}
            onSaveValues={onSaveValues}
            onIssueAcknowledge={onIssueAcknowledge}
            onSwitchToPreview={() => setActiveTab("preview")}
          />
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-[11px] font-medium border-b-2 transition-colors ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-fg)]"
          : "border-transparent text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)]"
      }`}
    >
      {children}
    </button>
  );
}

function PreviewBody({ state }: { state: ViewState }) {
  switch (state.kind) {
    case "loading":
      return <p className="text-sm text-[var(--color-fg-subtle)] animate-pulse p-4">読込中...</p>;
    case "html":
      return <iframe srcDoc={state.html} className="w-full h-full border-0 bg-[var(--color-panel)]" />;
    case "url":
      if (state.mime === "image") {
        return (
          <div className="w-full h-full overflow-auto bg-[var(--color-panel)] flex items-center justify-center p-4">
            <img src={state.url} alt="" className="max-w-full max-h-full object-contain" />
          </div>
        );
      }
      return <iframe src={state.url} className="w-full h-full border-0 bg-[var(--color-panel)]" />;
    case "text":
      return (
        <pre className="text-xs text-[var(--color-fg)] whitespace-pre-wrap font-mono leading-relaxed p-4 overflow-y-auto h-full bg-[var(--color-panel)]">
          {state.text}
        </pre>
      );
    case "error":
      return <p className="text-sm text-[var(--color-danger-fg)] p-4">エラー: {state.message}</p>;
    case "unsupported":
      return <p className="text-sm text-[var(--color-fg-subtle)] p-4">プレビュー非対応の形式です ({state.ext || "拡張子なし"})</p>;
  }
}
