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
}

export default function MessageBubble({ message, streaming, sourceLinks, onPreviewFile, activePreviewId }: Props) {
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
        <div className="flex flex-wrap items-center gap-2 mt-3 mb-1">
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
                        prose-h1:text-lg prose-h2:text-base prose-h2:mt-3 prose-h2:mb-1 prose-h3:text-sm
                        prose-p:leading-relaxed prose-p:my-1
                        prose-table:border-collapse prose-table:w-full prose-table:my-1
                        prose-th:border prose-th:border-gray-300 prose-th:bg-gray-50 prose-th:px-2 prose-th:py-1 prose-th:text-left prose-th:text-xs prose-th:font-medium prose-th:text-gray-600
                        prose-td:border prose-td:border-gray-300 prose-td:px-2 prose-td:py-1 prose-td:text-sm
                        prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
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
