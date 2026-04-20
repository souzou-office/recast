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
    <div className="mt-4 rounded-2xl border p-4 border-[var(--color-border)] bg-[var(--color-panel)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-center gap-2 mb-3">
        <Icon name="Sparkles" size={13} className="text-[var(--color-accent)]" />
        <span className="text-[11.5px] font-medium text-[var(--color-fg-muted)]">
          {card.selectedPath ? "AIが推奨したテンプレート" : "書類テンプレートを選んでください"}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {card.templates.map(t => {
          const active = selected === t.path;
          return (
            <button
              key={t.path}
              onClick={() => !confirmed && setSelected(t.path)}
              disabled={confirmed}
              className={`h-9 px-3.5 rounded-full text-[12.5px] transition-colors ${
                active
                  ? "bg-[var(--color-fg)] text-[var(--color-bg)] font-medium inline-flex items-center gap-1.5"
                  : confirmed
                    ? "border border-[var(--color-border)] text-[var(--color-fg-subtle)]"
                    : "border border-[var(--color-border)] text-[var(--color-fg)] hover:border-[var(--color-fg-subtle)]"
              }`}
            >
              {active && <Icon name="Check" size={11} className="text-[var(--color-bg)]" />}
              {t.name}
            </button>
          );
        })}
      </div>
      {!confirmed && (
        <div className="flex items-center gap-2.5 mt-3.5 pt-3.5 border-t border-[var(--color-border-soft)]">
          <button
            onClick={() => { if (!selected) return; setConfirmed(true); onAction({ selectedPath: selected } as Partial<ActionCard>); }}
            disabled={!selected}
            className="h-9 px-4 rounded-full text-[12.5px] font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-fg)] disabled:bg-[var(--color-hover)] disabled:text-[var(--color-fg-subtle)]"
          >
            生成を開始
          </button>
          {onGoBackToFolder && (
            <button
              onClick={onGoBackToFolder}
              className="text-[12px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              フォルダを選び直す
            </button>
          )}
        </div>
      )}
    </div>
  );
}
