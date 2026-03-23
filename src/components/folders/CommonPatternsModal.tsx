"use client";

import { useState } from "react";

interface Props {
  patterns: string[];
  onSave: (patterns: string[]) => void;
  onScanAll: (patterns: string[], reset: boolean) => void;
  scanning: boolean;
  scanProgress: string;
  onClose: () => void;
}

export default function CommonPatternsModal({ patterns, onSave, onScanAll, scanning, scanProgress, onClose }: Props) {
  const [items, setItems] = useState<string[]>([...patterns]);
  const [newItem, setNewItem] = useState("");

  const addItem = () => {
    const trimmed = newItem.trim();
    if (trimmed && !items.includes(trimmed)) {
      setItems([...items, trimmed]);
      setNewItem("");
    }
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
        <div className="border-b border-gray-200 px-5 py-4">
          <h3 className="text-lg font-semibold text-gray-900">共通フォルダ設定</h3>
          <p className="mt-1 text-xs text-gray-500">
            指定したフォルダ名を全会社から探して「共通」に登録します
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          {/* 登録済みフォルダ名 */}
          {items.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-2">フォルダ名がありません</p>
          ) : (
            <ul className="space-y-1">
              {items.map((item, i) => (
                <li key={i} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
                  <span className="text-sm text-gray-700">{item}</span>
                  <button
                    onClick={() => removeItem(i)}
                    className="text-xs text-red-400 hover:text-red-600"
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* 追加 */}
          <div className="flex gap-2">
            <input
              type="text"
              value={newItem}
              onChange={e => setNewItem(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addItem()}
              placeholder="フォルダ名（例: 01.定款）"
              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
            />
            <button
              onClick={addItem}
              disabled={!newItem.trim()}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
            >
              追加
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-gray-200 px-5 py-4">
          {scanning && scanProgress && (
            <p className="text-xs text-blue-600 text-center">{scanProgress}</p>
          )}
          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
            >
              キャンセル
            </button>
            <button
              onClick={() => onSave(items)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors"
            >
              保存
            </button>
            <button
              onClick={() => onScanAll(items, false)}
              disabled={scanning || items.length === 0}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300 transition-colors"
            >
              {scanning ? "スキャン中..." : "追加登録"}
            </button>
            <button
              onClick={() => onScanAll(items, true)}
              disabled={scanning || items.length === 0}
              className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:bg-gray-300 transition-colors"
            >
              {scanning ? "スキャン中..." : "リセットして再登録"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
