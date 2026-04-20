"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CheckResultCard } from "@/types";
import { Icon } from "@/components/ui/Icon";

interface Props {
  card: CheckResultCard;
}

export default function CheckResultCardUI({ card }: Props) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] overflow-hidden">
      <div className="px-4 py-2.5 bg-[var(--color-warn-bg)] text-[var(--color-warn-fg)] text-xs font-medium border-b border-[var(--color-border-soft)] inline-flex items-center gap-1.5 w-full">
        <Icon name="ClipboardCheck" size={13} /> セルフチェック結果
      </div>
      <div className="p-4 prose prose-sm max-w-none text-[var(--color-fg)]
                      prose-table:border-collapse prose-table:w-full
                      prose-th:border prose-th:border-[var(--color-border)] prose-th:bg-[var(--color-hover)] prose-th:px-2 prose-th:py-1 prose-th:text-xs
                      prose-td:border prose-td:border-[var(--color-border)] prose-td:px-2 prose-td:py-1 prose-td:text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.content}</ReactMarkdown>
      </div>
    </div>
  );
}
