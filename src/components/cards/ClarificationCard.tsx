"use client";

import { useState } from "react";
import type { ClarificationCard, ActionCard } from "@/types";
import { Icon } from "@/components/ui/Icon";

interface Props {
  card: ClarificationCard;
  onAction: (data: Partial<ActionCard>) => void;
}

export default function ClarificationCardUI({ card, onAction }: Props) {
  const [answers, setAnswers] = useState<Record<string, { optionId?: string; manual?: string }>>(() =>
    Object.fromEntries(card.questions.map(q => [q.id, { optionId: q.selectedOptionId, manual: q.manualInput }]))
  );
  const isLocked = !!card.answered;

  // 選択を即時反映するためのヘルパー（label 内 input + onChange だと一部ブラウザで反映が遅れる症状あり）
  const selectOption = (qid: string, optionId: string) => {
    setAnswers(prev => ({ ...prev, [qid]: { optionId, manual: optionId === "_manual" ? (prev[qid]?.manual || "") : undefined } }));
  };

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
      <div className="px-4 py-2.5 bg-[var(--color-warn-bg)] text-[var(--color-warn-fg)] text-[12.5px] font-medium border-b border-[var(--color-border-soft)] inline-flex items-center gap-1.5 w-full">
        <Icon name="AlertTriangle" size={14} />
        {card.questions.length}点確認があります
      </div>
      <div className="p-4 space-y-5">
        {card.questions.map((q, qi) => (
          <div key={q.id}>
            <p className="text-[13.5px] font-medium text-[var(--color-fg)] mb-2 leading-relaxed">
              Q{qi + 1}. <span className="text-[var(--color-fg-muted)]">【{q.placeholder}】</span> {q.question}
            </p>
            <div className="space-y-1.5 ml-4">
              {q.options.map(opt => {
                const checked = answers[q.id]?.optionId === opt.id;
                return (
                  <div
                    key={opt.id}
                    onClick={() => !isLocked && selectOption(q.id, opt.id)}
                    className={`flex items-start gap-2.5 ${isLocked ? "" : "cursor-pointer hover:bg-[var(--color-hover)] -mx-2 px-2 py-0.5 rounded"}`}
                  >
                    <input
                      type="radio"
                      name={q.id}
                      checked={checked}
                      onChange={() => selectOption(q.id, opt.id)}
                      disabled={isLocked}
                      className="w-4 h-4 mt-0.5 pointer-events-none"
                    />
                    <span className="flex-1">
                      <span className="text-[13px] text-[var(--color-fg)]">{opt.label}</span>
                      {opt.source && (
                        <span className="ml-2 text-[11.5px] text-[var(--color-fg-subtle)]">{opt.source}</span>
                      )}
                    </span>
                  </div>
                );
              })}
              <div
                onClick={() => !isLocked && selectOption(q.id, "_manual")}
                className={`flex items-center gap-2.5 ${isLocked ? "" : "cursor-pointer hover:bg-[var(--color-hover)] -mx-2 px-2 py-0.5 rounded"}`}
              >
                <input
                  type="radio"
                  name={q.id}
                  checked={answers[q.id]?.optionId === "_manual"}
                  onChange={() => selectOption(q.id, "_manual")}
                  disabled={isLocked}
                  className="w-4 h-4 pointer-events-none"
                />
                <span className="text-[13px] text-[var(--color-fg)]">手動入力</span>
              </div>
              {answers[q.id]?.optionId === "_manual" && !isLocked && (
                <input
                  type="text"
                  value={answers[q.id]?.manual || ""}
                  onChange={e => setAnswers(prev => ({ ...prev, [q.id]: { optionId: "_manual", manual: e.target.value } }))}
                  className="ml-6 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[13px] w-64 focus:border-[var(--color-accent)] focus:outline-none bg-[var(--color-panel)]"
                  placeholder="値を入力"
                />
              )}
            </div>
          </div>
        ))}
        {!isLocked && (
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={submit}
              disabled={!allAnswered}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-4 py-2 text-[12.5px] font-medium text-white hover:bg-[var(--color-accent-fg)] disabled:bg-[var(--color-hover)] disabled:text-[var(--color-fg-subtle)] disabled:cursor-not-allowed"
            >
              生成する <Icon name="ArrowRight" size={13} />
            </button>
            {!allAnswered && (
              <span className="text-[11.5px] text-[var(--color-fg-muted)]">すべての質問に回答してください</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
