"use client";

import { useState } from "react";
import type { ClarificationCard, ActionCard } from "@/types";

interface Props {
  card: ClarificationCard;
  onAction: (data: Partial<ActionCard>) => void;
}

export default function ClarificationCardUI({ card, onAction }: Props) {
  const [answers, setAnswers] = useState<Record<string, { optionId?: string; manual?: string }>>(
    Object.fromEntries(card.questions.map(q => [q.id, { optionId: q.selectedOptionId, manual: q.manualInput }]))
  );
  const isLocked = !!card.answered;

  const submit = () => {
    const updatedQuestions = card.questions.map(q => ({
      ...q,
      selectedOptionId: answers[q.id]?.optionId,
      manualInput: answers[q.id]?.manual,
    }));
    onAction({ questions: updatedQuestions, answered: true } as Partial<ActionCard>);
  };

  return (
    <div className={`rounded-lg border p-3 ${isLocked ? "bg-gray-50 border-gray-200" : "border-amber-200 bg-amber-50"}`}>
      <p className="text-xs font-medium text-gray-600 mb-3">{card.questions.length}点確認があります</p>
      <div className="space-y-4">
        {card.questions.map((q, qi) => (
          <div key={q.id}>
            <p className="text-xs font-medium text-gray-700 mb-1">
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
                  <span className="text-gray-700">{opt.label}</span>
                  <span className="text-[10px] text-gray-400">({opt.source})</span>
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
                <span className="text-gray-700">手動入力</span>
              </label>
              {answers[q.id]?.optionId === "_manual" && !isLocked && (
                <input
                  type="text"
                  value={answers[q.id]?.manual || ""}
                  onChange={e => setAnswers(prev => ({ ...prev, [q.id]: { optionId: "_manual", manual: e.target.value } }))}
                  className="ml-6 rounded border border-gray-300 px-2 py-1 text-xs w-48 focus:border-blue-500 focus:outline-none"
                  placeholder="値を入力"
                />
              )}
            </div>
          </div>
        ))}
      </div>
      {!isLocked && (
        <div className="flex gap-2 mt-3">
          <button
            onClick={submit}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            生成する →
          </button>
        </div>
      )}
    </div>
  );
}
