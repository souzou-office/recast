"use client";

import { useState } from "react";
import type { ClarificationCard, ActionCard } from "@/types";
import { Icon } from "@/components/ui/Icon";

interface Props {
  card: ClarificationCard;
  onAction: (data: Partial<ActionCard>) => void;
}

export default function ClarificationCardUI({ card, onAction }: Props) {
  const [answers, setAnswers] = useState<Record<string, { optionId?: string; manual?: string }>>(
    Object.fromEntries(card.questions.map(q => [q.id, { optionId: q.selectedOptionId, manual: q.manualInput }]))
  );
  const isLocked = !!card.answered;

  const allAnswered = card.questions.every(q => {
    const a = answers[q.id];
    if (!a?.optionId) return false;
    if (a.optionId === "_manual") return !!(a.manual && a.manual.trim());
    return true;
  });

  const submit = () => {
    if (!allAnswered) return;
    const updatedQuestions = card.questions.map(q => ({
      ...q,
      selectedOptionId: answers[q.id]?.optionId,
      manualInput: answers[q.id]?.manual,
    }));
    onAction({ questions: updatedQuestions, answered: true } as Partial<ActionCard>);
  };

  return (
    <div className={`rounded-2xl border overflow-hidden ${isLocked ? "bg-[var(--color-hover)] border-[var(--color-border)]" : "border-[var(--color-border)] bg-[var(--color-panel)]"}`}>
      <div className="px-4 py-2.5 bg-[var(--color-warn-bg)] text-[var(--color-warn-fg)] text-xs font-medium border-b border-[var(--color-border-soft)] inline-flex items-center gap-1.5 w-full">
        <Icon name="AlertTriangle" size={13} />
        {card.questions.length}点確認があります
      </div>
      <div className="p-4 space-y-4">
        {card.questions.map((q, qi) => (
          <div key={q.id}>
            <p className="text-xs font-medium text-[var(--color-fg)] mb-1.5">
              Q{qi + 1}. 【{q.placeholder}】— {q.question}
            </p>
            <div className="space-y-1 ml-4">
              {q.options.map(opt => (
                <label key={opt.id} className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="radio"
                    name={q.id}
                    checked={answers[q.id]?.optionId === opt.id}
                    onChange={() => setAnswers(prev => ({ ...prev, [q.id]: { optionId: opt.id } }))}
                    disabled={isLocked}
                    className="w-3.5 h-3.5"
                  />
                  <span className="text-[var(--color-fg)]">{opt.label}</span>
                  <span className="text-[10px] text-[var(--color-fg-subtle)]">({opt.source})</span>
                </label>
              ))}
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="radio"
                  name={q.id}
                  checked={answers[q.id]?.optionId === "_manual"}
                  onChange={() => setAnswers(prev => ({ ...prev, [q.id]: { optionId: "_manual", manual: "" } }))}
                  disabled={isLocked}
                  className="w-3.5 h-3.5"
                />
                <span className="text-[var(--color-fg)]">手動入力</span>
              </label>
              {answers[q.id]?.optionId === "_manual" && !isLocked && (
                <input
                  type="text"
                  value={answers[q.id]?.manual || ""}
                  onChange={e => setAnswers(prev => ({ ...prev, [q.id]: { optionId: "_manual", manual: e.target.value } }))}
                  className="ml-6 rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs w-48 focus:border-[var(--color-accent)] focus:outline-none bg-[var(--color-panel)]"
                  placeholder="値を入力"
                />
              )}
            </div>
          </div>
        ))}
        {!isLocked && (
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={submit}
              disabled={!allAnswered}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-fg)] px-4 py-1.5 text-xs font-medium text-[var(--color-bg)] hover:opacity-90 disabled:bg-[var(--color-hover)] disabled:text-[var(--color-fg-subtle)] disabled:cursor-not-allowed"
            >
              生成する <Icon name="ArrowRight" size={12} />
            </button>
            {!allAnswered && (
              <span className="text-[10px] text-[var(--color-fg-muted)]">すべての質問に回答してください</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
