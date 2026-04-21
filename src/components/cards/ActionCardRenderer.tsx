"use client";

import type { ActionCard, Company, ChatThread } from "@/types";
import FolderSelectCardUI from "./FolderSelectCard";
import FileSelectCardUI from "./FileSelectCard";
import TemplateSelectCardUI from "./TemplateSelectCard";
import ClarificationCardUI from "./ClarificationCard";
import DocumentResultCardUI from "./DocumentResultCard";
import CheckResultCardUI from "./CheckResultCard";
import TemplateReviewCardUI from "./TemplateReviewCard";

interface Props {
  card: ActionCard;
  onAction: (data: Partial<ActionCard>) => void;
  company: Company;
  thread: ChatThread;
  onPreview?: (file: { filePath?: string; docxBase64?: string; fileName: string }) => void;
  onGoBackToFolder?: () => void;
}

export default function ActionCardRenderer({ card, onAction, company, thread, onPreview, onGoBackToFolder }: Props) {
  switch (card.type) {
    case "folder-select":
      return <FolderSelectCardUI card={card} onAction={onAction} />;
    case "file-select":
      return <FileSelectCardUI card={card} onAction={onAction} onPreview={onPreview} />;
    case "template-select":
      return <TemplateSelectCardUI card={card} onAction={onAction} onGoBackToFolder={onGoBackToFolder} />;
    case "clarification":
      return <ClarificationCardUI card={card} onAction={onAction} />;
    case "document-result":
      return <DocumentResultCardUI card={card} onPreview={onPreview} />;
    case "template-review":
      return (
        <TemplateReviewCardUI
          card={card}
          onReview={() => {
            // グローバルイベントで設定タブ→テンプレート解釈を開く
            window.dispatchEvent(new CustomEvent("recast:open-settings", {
              detail: { section: "template-labels", templateFolderPath: card.folderPath },
            }));
          }}
          onProceed={() => onAction({ acknowledged: true } as Partial<ActionCard>)}
        />
      );
    case "check-prompt":
      return (
        <button
          onClick={() => onAction({ accepted: true } as Partial<ActionCard>)}
          disabled={card.accepted}
          className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
            card.accepted ? "bg-[var(--color-hover)] text-[var(--color-fg-subtle)]" : "bg-[var(--color-fg)] text-[var(--color-bg)] hover:opacity-90"
          }`}
        >
          {card.accepted ? "チェック中..." : "チェックする"}
        </button>
      );
    case "check-result":
      return <CheckResultCardUI card={card} />;
    default:
      return null;
  }
}
