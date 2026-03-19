"use client";

import { useState, useRef, useCallback } from "react";

interface Props {
  onSend: (message: string) => void;
  onOpenTemplateModal?: () => void;
  disabled: boolean;
}

export default function ChatInput({ onSend, onOpenTemplateModal, disabled }: Props) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };

  return (
    <div className="border-t border-gray-200 bg-white p-4">
      {/* ショートカットボタン */}
      <div className="flex gap-2 mb-3">
        <button
          onClick={onOpenTemplateModal}
          disabled={disabled}
          className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700
                     hover:bg-blue-100 disabled:bg-gray-50 disabled:text-gray-400 disabled:border-gray-200 transition-colors"
        >
          案件を整理
        </button>
      </div>

      {/* 入力欄 */}
      <div className="flex items-end gap-3">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="メッセージを入力...（Shift+Enterで改行）"
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-3 text-sm
                     focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500
                     disabled:bg-gray-50 disabled:text-gray-400"
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || !input.trim()}
          className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white
                     hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed
                     transition-colors"
        >
          送信
        </button>
      </div>
    </div>
  );
}
