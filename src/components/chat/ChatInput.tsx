"use client";

import { useState, useRef, useCallback } from "react";

interface Props {
  onSend: (message: string) => void;
  disabled: boolean;
}

export default function ChatInput({ onSend, disabled }: Props) {
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
    <div className="border-t border-[var(--color-border)] bg-[var(--color-panel)] p-4">
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
          className="flex-1 resize-none rounded-xl border border-[var(--color-border)] px-4 py-3 text-sm
                     focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500
                     disabled:bg-[var(--color-hover)] disabled:text-[var(--color-fg-subtle)]"
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || !input.trim()}
          className="rounded-xl bg-[var(--color-fg)] px-5 py-3 text-sm font-medium text-white
                     hover:opacity-90 disabled:bg-gray-300 disabled:cursor-not-allowed
                     transition-colors"
        >
          送信
        </button>
      </div>
    </div>
  );
}
