"use client";

interface Props {
  fileId: string;
  fileName: string;
  onClose: () => void;
}

export default function FileViewer({ fileId, fileName, onClose }: Props) {
  const previewUrl = `https://drive.google.com/file/d/${fileId}/preview`;
  const openUrl = `https://drive.google.com/file/d/${fileId}/view`;

  return (
    <div className="flex h-full w-[45%] max-w-[600px] min-w-[350px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)]">
      {/* ヘッダー */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <h3 className="text-sm font-medium text-[var(--color-fg)] truncate" title={fileName}>
          {fileName}
        </h3>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-fg)]"
          >
            別タブで開く
          </a>
          <button
            onClick={onClose}
            className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)] text-lg leading-none"
          >
            &times;
          </button>
        </div>
      </div>

      {/* プレビュー */}
      <div className="flex-1">
        <iframe
          src={previewUrl}
          className="h-full w-full border-0"
          allow="autoplay"
        />
      </div>
    </div>
  );
}
