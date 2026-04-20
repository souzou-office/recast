"use client";

import { useState } from "react";
import type { TemplateSelectCard, ActionCard } from "@/types";
import { Icon } from "@/components/ui/Icon";

interface Props {
  card: TemplateSelectCard;
  onAction: (data: Partial<ActionCard>) => void;
  onGoBackToFolder?: () => void;
}

export default function TemplateSelectCardUI({ card, onAction, onGoBackToFolder }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(card.selectedPath);

  return (
    <div className={`rounded-2xl border p-4 ${confirmed ? "bg-[var(--color-hover)] border-[var(--color-border)]" : "border-[var(--color-accent-soft)] bg-[var(--color-accent-soft)]"}`}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-[var(--color-fg-muted)]">
          {card.selectedPath && !confirmed ? "テンプレートを推奨しました。変更もできます" : "書類テンプレートを選んでください"}
        </p>
        {!confirmed && onGoBackToFolder && (
          <button
            onClick={onGoBackToFolder}
            className="inline-flex items-center gap-1 text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]"
          >
            <Icon name="ArrowLeft" size={11} /> フォルダを選び直す
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2 mb-2">
        {card.templates.map(t => (
          <button
            key={t.path}
            onClick={() => !confirmed && setSelected(t.path)}
            disabled={confirmed}
            className={`rounded-full px-4 py-2 text-xs font-medium transition-colors ${
              selected === t.path
                ? "bg-[var(--color-fg)] text-[var(--color-bg)]"
                : confirmed
                  ? "bg-[var(--color-hover)] text-[var(--color-fg-subtle)]"
                  : "bg-[var(--color-panel)] border border-[var(--color-border)] text-[var(--color-fg)] hover:border-[var(--color-accent)]"
            }`}
          >
            {t.name}
          </button>
        ))}
      </div>
      {!confirmed && selected && (
        <button
          onClick={() => { setConfirmed(true); onAction({ selectedPath: selected } as Partial<ActionCard>); }}
          className="rounded-full bg-[var(--color-fg)] px-4 py-1.5 text-xs font-medium text-[var(--color-bg)] hover:opacity-90"
        >
          このテンプレートで生成
        </button>
      )}
    </div>
  );
}
