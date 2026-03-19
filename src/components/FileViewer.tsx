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
    <div className="flex h-full w-[45%] max-w-[600px] min-w-[350px] shrink-0 flex-col border-l border-gray-200 bg-white">
      {/* ヘッダー */}
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h3 className="text-sm font-medium text-gray-700 truncate" title={fileName}>
          {fileName}
        </h3>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:text-blue-800"
          >
            別タブで開く
          </a>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
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
