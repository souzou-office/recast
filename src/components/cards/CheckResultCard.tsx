"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CheckResultCard } from "@/types";

interface Props {
  card: CheckResultCard;
}

export default function CheckResultCardUI({ card }: Props) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="prose prose-sm max-w-none text-gray-800
                      prose-table:border-collapse prose-table:w-full
                      prose-th:border prose-th:border-gray-300 prose-th:bg-gray-50 prose-th:px-2 prose-th:py-1 prose-th:text-xs
                      prose-td:border prose-td:border-gray-300 prose-td:px-2 prose-td:py-1 prose-td:text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.content}</ReactMarkdown>
      </div>
    </div>
  );
}
