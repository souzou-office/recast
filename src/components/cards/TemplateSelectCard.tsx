"use client";

import type { TemplateSelectCard, ActionCard } from "@/types";

interface Props {
  card: TemplateSelectCard;
  onAction: (data: Partial<ActionCard>) => void;
}

export default function TemplateSelectCardUI({ card, onAction }: Props) {
  const isLocked = !!card.selectedPath;

  return (
    <div className={`rounded-lg border p-3 ${isLocked ? "bg-gray-50 border-gray-200" : "border-blue-200 bg-blue-50"}`}>
      <p className="text-xs font-medium text-gray-600 mb-2">書類テンプレートを選んでください</p>
      <div className="flex flex-wrap gap-2">
        {card.templates.map(t => (
          <button
            key={t.path}
            onClick={() => !isLocked && onAction({ selectedPath: t.path } as Partial<ActionCard>)}
            disabled={isLocked}
            className={`rounded-lg px-4 py-2 text-xs font-medium transition-colors ${
              card.selectedPath === t.path
                ? "bg-blue-600 text-white"
                : isLocked
                  ? "bg-gray-100 text-gray-400"
                  : "bg-white border border-gray-200 text-gray-700 hover:border-blue-400"
            }`}
          >
            {t.name}
          </button>
        ))}
      </div>
    </div>
  );
}
