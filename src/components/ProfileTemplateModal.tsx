"use client";

import { useState, useEffect } from "react";

interface Props {
  onClose: () => void;
}

export default function ProfileTemplateModal({ onClose }: Props) {
  const [items, setItems] = useState<string[]>([]);
  const [newItem, setNewItem] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/workspace/profile-template");
        if (res.ok) {
          const data = await res.json();
          setItems(data.items);
        }
      } catch { /* ignore */ }
      finally { setLoading(false); }
    };
    load();
  }, []);

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

  const moveItem = (index: number, dir: -1 | 1) => {
    const newIndex = index + dir;
    if (newIndex < 0 || newIndex >= items.length) return;
    const updated = [...items];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    setItems(updated);
  };

  const save = async () => {
    await fetch("/api/workspace/profile-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl max-h-[80vh] flex flex-col">
        <div className="border-b border-gray-200 px-5 py-4">
          <h3 className="text-lg font-semibold text-gray-900">基本情報 抽出項目設定</h3>
          <p className="mt-1 text-xs text-gray-500">
            基本情報を生成する際に抽出する項目を設定します
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {loading ? (
            <p className="text-sm text-gray-400 text-center py-4">読み込み中...</p>
          ) : (
            <>
              {items.map((item, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <button
                      onClick={() => moveItem(i, -1)}
                      disabled={i === 0}
                      className="text-[10px] text-gray-400 hover:text-gray-600 disabled:opacity-30"
                    >▲</button>
                    <button
                      onClick={() => moveItem(i, 1)}
                      disabled={i === items.length - 1}
                      className="text-[10px] text-gray-400 hover:text-gray-600 disabled:opacity-30"
                    >▼</button>
                  </div>
                  <span className="flex-1 text-sm text-gray-700">{item}</span>
                  <button
                    onClick={() => removeItem(i)}
                    className="text-xs text-red-400 hover:text-red-600"
                  >
                    削除
                  </button>
                </div>
              ))}

              <div className="flex gap-2 pt-2">
                <input
                  type="text"
                  value={newItem}
                  onChange={e => setNewItem(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addItem()}
                  placeholder="項目名を入力（例: 代表者の住所）"
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
            </>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-gray-200 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
          >
            キャンセル
          </button>
          <button
            onClick={save}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
