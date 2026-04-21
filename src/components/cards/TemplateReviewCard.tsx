"use client";

import type { TemplateReviewCard } from "@/types";
import { Icon } from "@/components/ui/Icon";

interface Props {
  card: TemplateReviewCard;
  onReview: () => void;     // [確認する] 押下時
  onProceed: () => void;    // [このまま実行] 押下時
}

export default function TemplateReviewCardUI({ card, onReview, onProceed }: Props) {
  const newCount = card.newlyGenerated;
  const disabled = card.acknowledged;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] overflow-hidden">
      <div className="px-4 py-2.5 text-xs font-medium border-b border-[var(--color-border-soft)] bg-[var(--color-hover)] inline-flex items-center gap-1.5 w-full">
        <Icon name="Sparkles" size={14} className="text-[var(--color-accent)]" />
        テンプレ解釈を生成しました
      </div>
      <div className="px-4 py-3 text-[12px] text-[var(--color-fg-muted)] leading-relaxed">
        <div className="mb-2">
          「<span className="font-medium text-[var(--color-fg)]">{card.templateName}</span>」 の書類を初めて使うので、
          AI が各テンプレのマーカーに <span className="font-medium">意味ラベル</span> を付けました。
        </div>
        <div className="text-[11px] text-[var(--color-fg-subtle)]">
          {card.totalFiles} ファイル中 {newCount} 件が新規生成。
          内容が案件に合っているか一度確認することをおすすめします（2 回目以降は表示されません）。
        </div>
        {card.files.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {card.files.map(f => (
              <li key={f.name} className="text-[11px] flex items-center gap-1.5">
                <Icon
                  name={/\.(xlsx|xlsm|xls)$/i.test(f.name) ? "FileSpreadsheet" : "FileText"}
                  size={11}
                  className="text-[var(--color-fg-subtle)] shrink-0"
                />
                <span className="truncate">{f.name}</span>
                {f.wasNew && <span className="text-[10px] text-[var(--color-accent)] shrink-0">新規</span>}
                <span className="text-[10px] text-[var(--color-fg-subtle)] shrink-0">{f.slotCount} スロット</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-[var(--color-border-soft)] px-4 py-2 flex gap-2 justify-end">
        <button
          onClick={onReview}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-full bg-[var(--color-hover)] px-3 py-1 text-[11px] font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-fg)] hover:text-[var(--color-bg)] disabled:opacity-50 transition-colors"
        >
          <Icon name="Eye" size={11} /> 確認する
        </button>
        <button
          onClick={onProceed}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          このまま実行 <Icon name="ArrowRight" size={11} />
        </button>
      </div>
    </div>
  );
}
