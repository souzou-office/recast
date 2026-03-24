"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "@/types";
import CheckResultCard from "./CheckResultCard";
import type { Components } from "react-markdown";

interface Props {
  message: ChatMessage;
  streaming?: boolean;
  sourceLinks?: Record<string, { id: string; name: string }[]>;
  onPreviewFile?: (fileId: string) => void;
  activePreviewId?: string | null;
  onNavigateToCompany?: (companyId: string) => void;
  companies?: { id: string; name: string }[];
}

export default function MessageBubble({ message, streaming, sourceLinks, onPreviewFile, activePreviewId, onNavigateToCompany, companies }: Props) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end mb-6">
        <div className="max-w-[70%] rounded-2xl bg-blue-600 px-4 py-3 text-sm text-white whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  // テンプレート結果がある場合はカード表示
  if (message.checkResult) {
    return <CheckResultCard data={message.checkResult} />;
  }

  // テキスト内の会社名をクリック可能なリンクに変換
  const renderWithCompanyLinks = (text: string): React.ReactNode => {
    if (!companies || companies.length === 0 || !onNavigateToCompany) return text;

    // 会社名から番号プレフィックスを除いた名前も用意し、長い順にソート
    const matchers = companies.flatMap(c => {
      const names = [c.name];
      // "030.株式会社AZNICS" → "株式会社AZNICS" も追加
      const withoutNum = c.name.replace(/^\d+[._\s]*/, "");
      if (withoutNum !== c.name) names.push(withoutNum);
      // "_D" や "_O" 等のサフィックスも除去したバージョン
      const withoutSuffix = withoutNum.replace(/[_\s]*[A-Z]$/, "").trim();
      if (withoutSuffix !== withoutNum && withoutSuffix.length > 3) names.push(withoutSuffix);
      return names.map(name => ({ name, id: c.id, fullName: c.name }));
    }).sort((a, b) => b.name.length - a.name.length);

    const parts: React.ReactNode[] = [text];

    for (const matcher of matchers) {
      const newParts: React.ReactNode[] = [];
      for (const part of parts) {
        if (typeof part !== "string") { newParts.push(part); continue; }
        const idx = part.indexOf(matcher.name);
        if (idx === -1) { newParts.push(part); continue; }
        if (idx > 0) newParts.push(part.slice(0, idx));
        newParts.push(
          <button
            key={`${matcher.id}-${idx}-${Math.random()}`}
            onClick={() => onNavigateToCompany(matcher.id)}
            className="text-blue-600 hover:text-blue-800 hover:underline"
          >
            {matcher.name}
          </button>
        );
        if (idx + matcher.name.length < part.length) newParts.push(part.slice(idx + matcher.name.length));
      }
      parts.length = 0;
      parts.push(...newParts);
    }

    return parts.length === 1 && typeof parts[0] === "string" ? parts[0] : <>{parts}</>;
  };

  // ## 見出しの後にファイルリンクを挿入するカスタムコンポーネント
  const components: Components = sourceLinks ? {
    h2: ({ children, ...props }) => {
      const text = typeof children === "string" ? children :
        Array.isArray(children) ? children.map(c => typeof c === "string" ? c : "").join("") :
        "";
      // テキストからリンクを探す（番号付き見出しも対応）
      const cleanText = text.replace(/^\d+\.\s*/, "").trim();
      const files = sourceLinks[text] || sourceLinks[cleanText] ||
        Object.entries(sourceLinks).find(([k]) =>
          k.includes(cleanText) || cleanText.includes(k)
        )?.[1];

      return (
        <div className="flex flex-wrap items-center gap-2 mt-2 mb-0.5">
          <h2 {...props} className="text-base font-semibold text-gray-900 m-0">{children}</h2>
          {files && files.map((f, i) => (
            <button
              key={`${f.id}-${i}`}
              onClick={() => onPreviewFile?.(f.id)}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                activePreviewId === f.id
                  ? "bg-blue-100 text-blue-700"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              }`}
            >
              📄 {f.name}
            </button>
          ))}
        </div>
      );
    },
  } : {};

  // 横断検索モード: テキスト内の会社名をリンク化
  if (companies && companies.length > 0 && onNavigateToCompany) {
    components.td = ({ children, ...props }) => {
      const text = typeof children === "string" ? children : "";
      if (text) {
        return <td {...props}>{renderWithCompanyLinks(text)}</td>;
      }
      return <td {...props}>{children}</td>;
    };
  }

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-1.5">
        <img src="/logo.png" alt="recast" className="h-4" />
      </div>
      {streaming ? (
        <div className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
          {message.content}
          <span className="animate-pulse">▍</span>
        </div>
      ) : (
        <div className="prose prose-sm max-w-none text-gray-800
                        prose-headings:text-gray-900 prose-headings:font-semibold
                        prose-h1:text-lg prose-h2:text-base prose-h2:mt-2 prose-h2:mb-0.5 prose-h3:text-sm
                        prose-p:leading-snug prose-p:my-0.5
                        prose-table:border-collapse prose-table:w-full prose-table:my-0.5
                        prose-th:border prose-th:border-gray-300 prose-th:bg-gray-50 prose-th:px-2 prose-th:py-1 prose-th:text-left prose-th:text-xs prose-th:font-medium prose-th:text-gray-600
                        prose-td:border prose-td:border-gray-300 prose-td:px-2 prose-td:py-1 prose-td:text-sm
                        prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0
                        prose-code:bg-gray-100 prose-code:px-1 prose-code:rounded prose-code:text-sm
                        prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-pre:rounded-lg
                        prose-strong:text-gray-900 prose-strong:font-semibold
                        prose-a:text-blue-600
                        prose-em:not-italic prose-em:text-amber-700 prose-em:text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {message.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
