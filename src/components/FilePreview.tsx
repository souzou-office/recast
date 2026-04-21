"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface Props {
  filePath?: string;
  fileName: string;
  onClose: () => void;
  docxBase64?: string;
}

const RAW_VIEWABLE = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".html", ".htm"]);
// ブラウザ側で直接レンダリングできる Word（docx-preview で処理）
const BROWSER_DOCX = new Set([".docx", ".docm"]);
// LibreOffice が必要な古い Word / PowerPoint
const SERVER_DOCX = new Set([".doc", ".odt", ".ppt", ".pptx"]);
const EXCEL_EXTS = new Set([".xls", ".xlsx", ".ods"]);

function base64ToUint8(base64: string): Uint8Array {
  const byteChars = atob(base64);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
  return byteArray;
}

export default function FilePreview({ filePath, fileName, onClose, docxBase64 }: Props) {
  const ext = `.${(fileName.split(".").pop() || "").toLowerCase()}`;
  const isRawViewable = RAW_VIEWABLE.has(ext);
  const isBrowserDocx = BROWSER_DOCX.has(ext);
  const isServerDocx = SERVER_DOCX.has(ext);
  const isExcel = EXCEL_EXTS.has(ext);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [width, setWidth] = useState(50); // パーセント
  const docxContainerRef = useRef<HTMLDivElement | null>(null);

  const handleDragStart = useCallback(() => {
    const handleMove = (e: MouseEvent) => {
      const container = document.getElementById("main-content-area");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const pct = 100 - ((e.clientX - rect.left) / rect.width) * 100;
      setWidth(Math.max(20, Math.min(80, pct)));
    };
    const handleUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, []);

  // docx のブラウザ側レンダリング
  const renderDocxInBrowser = useCallback(async (buffer: ArrayBuffer | Uint8Array) => {
    if (!docxContainerRef.current) return;
    docxContainerRef.current.innerHTML = ""; // クリア
    try {
      const { renderAsync } = await import("docx-preview");
      await renderAsync(buffer, docxContainerRef.current, undefined, {
        className: "docx-preview",
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        breakPages: true,
      });
    } catch (err) {
      if (docxContainerRef.current) {
        docxContainerRef.current.textContent = `プレビューに失敗しました: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }, []);

  // xlsx のブラウザ側レンダリング（sheetjs で HTML に変換、セル結合・列幅・簡易スタイル反映）
  const renderXlsxInBrowserAsHtml = useCallback(async (buffer: Uint8Array): Promise<string> => {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buffer, { type: "array", cellStyles: true });
    const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      const ref = ws["!ref"];
      if (!ref) continue;
      const range = XLSX.utils.decode_range(ref);

      // セル結合のマップ: "r,c" → { rowspan, colspan } or "skip"
      const merges = (ws["!merges"] || []) as { s: { r: number; c: number }; e: { r: number; c: number } }[];
      const mergeInfo: Record<string, { rowspan: number; colspan: number } | "skip"> = {};
      for (const m of merges) {
        const rowspan = m.e.r - m.s.r + 1;
        const colspan = m.e.c - m.s.c + 1;
        mergeInfo[`${m.s.r},${m.s.c}`] = { rowspan, colspan };
        for (let r = m.s.r; r <= m.e.r; r++) {
          for (let c = m.s.c; c <= m.e.c; c++) {
            if (r === m.s.r && c === m.s.c) continue;
            mergeInfo[`${r},${c}`] = "skip";
          }
        }
      }

      // 列幅（Excel の wch / wpx 単位を CSS 幅に変換）
      const cols = (ws["!cols"] || []) as { wpx?: number; wch?: number }[];
      const colWidths: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const col = cols[c];
        if (col?.wpx) colWidths.push(`${col.wpx}px`);
        else if (col?.wch) colWidths.push(`${Math.round(col.wch * 7.5)}px`); // wch ≒ 文字数、1文字 ~7.5px
        else colWidths.push("auto");
      }

      const rows: string[] = [];
      for (let r = range.s.r; r <= range.e.r; r++) {
        const cells: string[] = [];
        for (let c = range.s.c; c <= range.e.c; c++) {
          const info = mergeInfo[`${r},${c}`];
          if (info === "skip") continue;
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr];
          const value = cell ? (cell.w ?? cell.v ?? "") : "";
          const span = info
            ? `${info.rowspan > 1 ? ` rowspan="${info.rowspan}"` : ""}${info.colspan > 1 ? ` colspan="${info.colspan}"` : ""}`
            : "";
          // 簡易スタイル: 太字・配置・背景色・文字色（cellStyles: true で取れたもののみ）
          const style = cell?.s as { font?: { bold?: boolean; color?: { rgb?: string } }; alignment?: { horizontal?: string; vertical?: string }; fgColor?: { rgb?: string }; fill?: { fgColor?: { rgb?: string } } } | undefined;
          const styleParts: string[] = [];
          if (style?.font?.bold) styleParts.push("font-weight:600");
          if (style?.font?.color?.rgb) styleParts.push(`color:#${style.font.color.rgb.slice(-6)}`);
          if (style?.alignment?.horizontal) styleParts.push(`text-align:${style.alignment.horizontal}`);
          if (style?.alignment?.vertical) styleParts.push(`vertical-align:${style.alignment.vertical === "center" ? "middle" : style.alignment.vertical}`);
          const bg = style?.fill?.fgColor?.rgb || style?.fgColor?.rgb;
          if (bg && bg !== "FFFFFF" && bg !== "FFFFFFFF") styleParts.push(`background:#${bg.slice(-6)}`);
          const styleAttr = styleParts.length > 0 ? ` style="${styleParts.join(";")}"` : "";
          cells.push(`<td${span}${styleAttr}>${esc(String(value))}</td>`);
        }
        rows.push(`<tr>${cells.join("")}</tr>`);
      }

      const colgroup = `<colgroup>${colWidths.map(w => `<col style="width:${w}">`).join("")}</colgroup>`;
      parts.push(`<h3>${esc(name)}</h3><table>${colgroup}${rows.join("")}</table>`);
    }

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff;color:#111}
body{padding:12px;font:12px -apple-system,system-ui,sans-serif;overflow:auto}
h3{margin:16px 8px 4px;font:600 13px -apple-system,system-ui,sans-serif;color:#555}
/* table-layout:fixed だと列幅を超えたセルが省略される。auto にして、列幅は colgroup の指定を最小値として扱う */
table{border-collapse:collapse;margin:0 8px 16px;table-layout:auto}
td{border:1px solid #ddd;padding:4px 6px;vertical-align:top;white-space:nowrap}
col{min-width:60px}
</style></head><body>${parts.join("")}</body></html>`;
  }, []);

  useEffect(() => {
    setLoading(true);
    setBlobUrl(null);
    setTextContent(null);

    // base64 から直接レンダリング（ファイル種類で分岐）
    if (docxBase64) {
      // xlsx / xlsm / xls なら sheetjs で HTML 化して iframe 表示
      if (isExcel) {
        (async () => {
          try {
            const bytes = base64ToUint8(docxBase64);
            const html = await renderXlsxInBrowserAsHtml(bytes);
            setBlobUrl("html:" + html);
          } catch (err) {
            setTextContent(`プレビューに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            setLoading(false);
          }
        })();
        return;
      }
      // docx / docm（default） → docx-preview でレンダリング
      (async () => {
        try {
          const bytes = base64ToUint8(docxBase64);
          await renderDocxInBrowser(bytes);
        } finally {
          setLoading(false);
        }
      })();
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
          setBlobUrl(URL.createObjectURL(blob) + "#toolbar=1&navpanes=0&view=FitH");
        })
        .catch(() => setTextContent("ファイルを読み取れませんでした"))
        .finally(() => setLoading(false));
    } else if (isBrowserDocx) {
      // docx/docm → ブラウザで直接レンダリング
      fetch("/api/workspace/raw-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error();
          const buf = await res.arrayBuffer();
          await renderDocxInBrowser(buf);
        })
        .catch(() => setTextContent("プレビューに失敗しました"))
        .finally(() => setLoading(false));
    } else if (isServerDocx) {
      // .doc / .ppt / .odt → LibreOffice 経由（docx-preview は非対応）
      fetch("/api/workspace/preview-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error();
          const blob = await res.blob();
          setBlobUrl(URL.createObjectURL(blob) + "#toolbar=1&navpanes=0&view=FitH");
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
  }, [filePath, docxBase64, isRawViewable, isBrowserDocx, isServerDocx, isExcel, renderDocxInBrowser, renderXlsxInBrowserAsHtml]);

  const handleDownload = async () => {
    if (docxBase64) {
      const mime = isExcel
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
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

  // docx-preview 用コンテナを表示するケース:
  // - filePath 経由の .docx / .docm
  // - docxBase64 経由で、かつ Excel ではないもの（Excel は HTML iframe で表示）
  const showDocxContainer = isBrowserDocx || (!!docxBase64 && !isExcel);

  return (
    <>
    <div
      onMouseDown={handleDragStart}
      className="w-1.5 shrink-0 cursor-col-resize hover:bg-blue-300 active:bg-blue-400 transition-colors bg-gray-200"
    />
    <div className="flex flex-col border-l border-[var(--color-border)]" style={{ width: `${width}%` }}>
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2 bg-[var(--color-hover)]">
        <span className="text-xs text-[var(--color-fg-muted)] truncate font-medium">{fileName}</span>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={handleDownload} className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]">
            ダウンロード
          </button>
          <button onClick={onClose} className="text-xs text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)]">x</button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden bg-[var(--color-hover)]">
        {showDocxContainer ? (
          <div className="relative w-full h-full">
            {loading && (
              <p className="absolute left-4 top-4 z-10 animate-pulse text-sm text-[var(--color-fg-subtle)]">読込中...</p>
            )}
            <div ref={docxContainerRef} className="w-full h-full overflow-auto bg-[var(--color-panel)] p-4" />
          </div>
        ) : loading ? (
          <p className="text-sm text-[var(--color-fg-subtle)] animate-pulse p-4">読込中...</p>
        ) : blobUrl?.startsWith("html:") ? (
          <iframe srcDoc={blobUrl.slice(5)} className="w-full h-full border-0 bg-[var(--color-panel)]" />
        ) : blobUrl ? (
          <iframe src={blobUrl} className="w-full h-full border-0" />
        ) : (
          <pre className="text-xs text-[var(--color-fg)] whitespace-pre-wrap font-mono leading-relaxed p-4 overflow-y-auto h-full bg-[var(--color-panel)]">{textContent}</pre>
        )}
      </div>
    </div>
    </>
  );
}
