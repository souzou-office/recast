"use client";

import type { CheckResultCard } from "@/types";
import { Icon } from "@/components/ui/Icon";
import { WarnHighlightMarkdown } from "@/components/ui/WarnHighlightMarkdown";

interface Props {
  card: CheckResultCard;
  companyName?: string;
  threadTitle?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 簡易 markdown → HTML（このカード用の最小実装。### 見出し と - [ ] 行 だけ
// きちんと変換し、それ以外は段落として出す）
function markdownToHtml(md: string): string {
  const out: string[] = [];
  let inList = false;
  const flushList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("### ")) {
      flushList();
      out.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
    } else if (line.startsWith("## ")) {
      flushList();
      out.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith("# ")) {
      flushList();
      out.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
    } else if (/^- \[[ xX]\] /.test(line)) {
      if (!inList) { out.push(`<ul class="checklist">`); inList = true; }
      const checked = /^- \[[xX]\] /.test(line);
      const body = line.replace(/^- \[[ xX]\] /, "");
      out.push(`<li><span class="box${checked ? " checked" : ""}"></span><span class="body">${escapeHtml(body)}</span></li>`);
    } else if (/^[-*] /.test(line)) {
      if (!inList) { out.push(`<ul>`); inList = true; }
      out.push(`<li><span class="body">${escapeHtml(line.replace(/^[-*] /, ""))}</span></li>`);
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      out.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  flushList();
  return out.join("\n");
}

function printChecklistAsPdf(content: string, companyName?: string, threadTitle?: string) {
  const now = new Date().toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const body = markdownToHtml(content);
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>セルフチェック結果</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  html, body { font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif; color: #111; }
  body { font-size: 11.5pt; line-height: 1.7; margin: 0; padding: 0; }
  .header { border-bottom: 1px solid #888; padding-bottom: 10pt; margin-bottom: 16pt; }
  .header .title { font-size: 16pt; font-weight: 600; margin: 0 0 4pt 0; }
  .header .meta { font-size: 10pt; color: #555; }
  .header .meta span + span::before { content: " / "; color: #aaa; padding: 0 2pt; }
  h1 { font-size: 15pt; margin: 20pt 0 8pt 0; }
  h2 { font-size: 13pt; margin: 18pt 0 6pt 0; border-bottom: 1px solid #ddd; padding-bottom: 4pt; }
  h3 { font-size: 12pt; margin: 14pt 0 4pt 0; color: #222; }
  p { margin: 6pt 0; }
  ul { margin: 4pt 0 10pt 0; padding-left: 0; list-style: none; }
  ul.checklist li { display: flex; align-items: flex-start; gap: 8pt; margin: 4pt 0; page-break-inside: avoid; }
  ul.checklist .box { display: inline-block; width: 12pt; height: 12pt; border: 1.2pt solid #444; border-radius: 1.5pt; flex-shrink: 0; margin-top: 3pt; }
  ul.checklist .box.checked::after { content: "✓"; display: block; text-align: center; line-height: 12pt; font-size: 11pt; color: #222; }
  ul:not(.checklist) li { margin: 2pt 0 2pt 16pt; list-style: disc; }
  .body { flex: 1; }
  .footer { margin-top: 24pt; padding-top: 8pt; border-top: 1px solid #ddd; font-size: 9pt; color: #888; text-align: right; }
</style>
</head>
<body>
  <div class="header">
    <div class="title">セルフチェック結果</div>
    <div class="meta">
      ${companyName ? `<span>${escapeHtml(companyName)}</span>` : ""}
      ${threadTitle ? `<span>${escapeHtml(threadTitle)}</span>` : ""}
      <span>${escapeHtml(now)} 出力</span>
    </div>
  </div>
  ${body}
  <div class="footer">recast</div>
</body>
</html>`;

  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc) { document.body.removeChild(iframe); return; }
  doc.open();
  doc.write(html);
  doc.close();

  // フォントロード後に印刷
  const trigger = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } finally {
      // 印刷ダイアログを閉じたあとに片付け（ブラウザ差吸収のため余裕を持って）
      setTimeout(() => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 1000);
    }
  };
  // load 完了を待つ。すでに about:blank で完了している環境にも備えてフォールバック。
  if (iframe.contentDocument?.readyState === "complete") {
    setTimeout(trigger, 50);
  } else {
    iframe.onload = () => setTimeout(trigger, 50);
    setTimeout(trigger, 300);
  }
}

export default function CheckResultCardUI({ card, companyName, threadTitle }: Props) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] overflow-hidden">
      <div className="px-4 py-2.5 bg-[var(--color-warn-bg)] text-[var(--color-warn-fg)] text-xs font-medium border-b border-[var(--color-border-soft)] flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="ClipboardCheck" size={13} /> セルフチェック結果
        </span>
        <button
          onClick={() => printChecklistAsPdf(card.content, companyName, threadTitle)}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-fg)] px-3 py-1 text-[10px] font-medium text-[var(--color-bg)] hover:opacity-90"
          title="ブラウザの印刷ダイアログから PDF として保存"
        >
          <Icon name="FileDown" size={11} /> PDFで保存
        </button>
      </div>
      <div className="p-4 prose-recast max-w-none">
        <WarnHighlightMarkdown>{card.content}</WarnHighlightMarkdown>
      </div>
    </div>
  );
}
