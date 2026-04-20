"use client";

import type { CheckResultCard } from "@/types";
import { Icon } from "@/components/ui/Icon";
import { WarnHighlightMarkdown } from "@/components/ui/WarnHighlightMarkdown";

interface Props {
  card: CheckResultCard;
}

export default function CheckResultCardUI({ card }: Props) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] overflow-hidden">
      <div className="px-4 py-2.5 bg-[var(--color-warn-bg)] text-[var(--color-warn-fg)] text-xs font-medium border-b border-[var(--color-border-soft)] inline-flex items-center gap-1.5 w-full">
        <Icon name="ClipboardCheck" size={13} /> セルフチェック結果
      </div>
      <div className="p-4 prose-recast max-w-none">
        <WarnHighlightMarkdown>{card.content}</WarnHighlightMarkdown>
      </div>
    </div>
  );
}
