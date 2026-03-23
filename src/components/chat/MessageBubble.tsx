"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "@/types";
import CheckResultCard from "./CheckResultCard";

interface Props {
  message: ChatMessage;
  streaming?: boolean;
}

export default function MessageBubble({ message, streaming }: Props) {
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
                        prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
                        prose-p:leading-relaxed prose-p:my-2
                        prose-table:border-collapse prose-table:w-full prose-table:my-3
                        prose-th:border prose-th:border-gray-300 prose-th:bg-gray-50 prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:text-xs prose-th:font-medium prose-th:text-gray-600
                        prose-td:border prose-td:border-gray-300 prose-td:px-3 prose-td:py-2 prose-td:text-sm
                        prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
                        prose-code:bg-gray-100 prose-code:px-1 prose-code:rounded prose-code:text-sm
                        prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-pre:rounded-lg
                        prose-strong:text-gray-900 prose-strong:font-semibold
                        prose-a:text-blue-600
                        prose-em:not-italic prose-em:text-amber-700 prose-em:text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
