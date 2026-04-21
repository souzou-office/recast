"use client";

import { useState, useEffect, useCallback } from "react";
import { Icon } from "./ui/Icon";
import type { FilledSlot } from "@/types";

type Candidate = { value: string; source: string };

interface Props {
  filledSlots: FilledSlot[];
  templatePath: string;
  fileName: string;
  companyId: string;
  threadId?: string;
  verifyIssues?: { docName: string; issues: { aspect: string; problem: string; expected?: string }[] }[];
  // 再生成後、親（ChatWorkflow）に新しい docxBase64 と filledSlots を伝える
  onRegenerated: (docxBase64: string, filledSlots: FilledSlot[]) => void;
}

export default function DocumentValueEditor({
  filledSlots,
  templatePath,
  fileName,
  companyId,
  threadId,
  verifyIssues,
  onRegenerated,
}: Props) {
  // スロット値の編集状態（slotId → value）
  const [values, setValues] = useState<Record<number, string>>({});
  const [candidates, setCandidates] = useState<Record<number, Candidate[]>>({});
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  // 初期値: filledSlots の値をセット
  useEffect(() => {
    const init: Record<number, string> = {};
    for (const s of filledSlots) init[s.slotId] = s.value;
    setValues(init);
    setDirty(false);
  }, [filledSlots]);

  // 候補を読み込み
  const loadCandidates = useCallback(async () => {
    setCandidatesLoading(true);
    try {
      const res = await fetch("/api/document-values/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          threadId,
          filledSlots,
          verifyIssues,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setCandidates(data.candidates || {});
      }
    } catch { /* ignore */ }
    setCandidatesLoading(false);
  }, [companyId, threadId, filledSlots, verifyIssues]);

  useEffect(() => { loadCandidates(); }, [loadCandidates]);

  const handleSelectCandidate = (slotId: number, candidate: Candidate) => {
    setValues(prev => ({ ...prev, [slotId]: candidate.value }));
    setOpenDropdown(null);
    setDirty(true);
  };

  const handleChange = (slotId: number, value: string) => {
    setValues(prev => ({ ...prev, [slotId]: value }));
    setDirty(true);
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const newSlots: FilledSlot[] = filledSlots.map(s => ({
        ...s,
        value: values[s.slotId] ?? s.value,
      }));
      const res = await fetch("/api/document-templates/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templatePath,
          fileName,
          filledSlots: newSlots.map(s => ({ slotId: s.slotId, value: s.value })),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        onRegenerated(data.docxBase64, newSlots);
        setDirty(false);
      } else {
        const err = await res.json().catch(() => ({}));
        alert(`再生成失敗: ${err.error || "不明なエラー"}`);
      }
    } catch (e) {
      alert(`再生成失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
    setRegenerating(false);
  };

  // copyIndex ごとにスロットをグループ化（複数部数書類用）
  const slotsByCopy = new Map<number | undefined, FilledSlot[]>();
  for (const s of filledSlots) {
    const key = s.copyIndex;
    if (!slotsByCopy.has(key)) slotsByCopy.set(key, []);
    slotsByCopy.get(key)!.push(s);
  }
  const groups = Array.from(slotsByCopy.entries()).sort((a, b) => (a[0] || 0) - (b[0] || 0));

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-hover)]">
        <span className="text-xs text-[var(--color-fg-muted)]">値の編集</span>
        {candidatesLoading && (
          <span className="text-[10px] text-[var(--color-fg-subtle)] animate-pulse">候補読み込み中...</span>
        )}
        <button
          onClick={loadCandidates}
          disabled={candidatesLoading}
          className="ml-auto inline-flex items-center gap-1 rounded-full bg-[var(--color-hover)] border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)] hover:bg-[var(--color-fg)] hover:text-[var(--color-bg)] disabled:opacity-50"
          title="候補を再取得"
        >
          <Icon name="RefreshCcw" size={10} /> 候補更新
        </button>
        <button
          onClick={handleRegenerate}
          disabled={!dirty || regenerating}
          className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent)] px-3 py-1 text-[10px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {regenerating ? "再生成中..." : "再生成してプレビュー更新"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {filledSlots.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-subtle)]">編集可能なスロットがありません。</p>
        ) : (
          groups.map(([copyIndex, slots], gi) => (
            <div key={gi} className="mb-4">
              {copyIndex !== undefined && (
                <div className="text-[11px] font-semibold text-[var(--color-fg-muted)] mb-2 px-1">
                  {copyIndex} 部目
                </div>
              )}
              <div className="space-y-2">
                {slots.map(s => {
                  const current = values[s.slotId] ?? s.value;
                  const changed = current !== s.value;
                  const cands = candidates[s.slotId] || [];
                  return (
                    <div key={`${copyIndex}-${s.slotId}`} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-2.5">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[11px] font-medium text-[var(--color-fg)]">{s.label}</span>
                        {s.format && <span className="text-[10px] text-[var(--color-fg-subtle)] font-mono">{s.format}</span>}
                        {changed && <span className="text-[10px] text-[var(--color-accent)]">●変更済み</span>}
                      </div>
                      <div className="flex items-center gap-1.5 relative">
                        <input
                          type="text"
                          value={current}
                          onChange={e => handleChange(s.slotId, e.target.value)}
                          className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[12px]"
                        />
                        {cands.length > 0 && (
                          <button
                            onClick={() => setOpenDropdown(openDropdown === s.slotId ? null : s.slotId)}
                            className="shrink-0 inline-flex items-center gap-0.5 rounded border border-[var(--color-border)] bg-[var(--color-hover)] px-2 py-1 text-[10px] text-[var(--color-fg-muted)] hover:bg-[var(--color-accent-soft)]"
                          >
                            候補 {cands.length} <Icon name="ChevronDown" size={10} />
                          </button>
                        )}
                        {openDropdown === s.slotId && cands.length > 0 && (
                          <div className="absolute z-10 right-0 top-full mt-1 min-w-[240px] max-w-[360px] rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] shadow-lg">
                            {cands.map((c, i) => (
                              <button
                                key={i}
                                onClick={() => handleSelectCandidate(s.slotId, c)}
                                className="w-full text-left px-3 py-2 text-[11px] hover:bg-[var(--color-hover)] border-b border-[var(--color-border-soft)] last:border-b-0"
                              >
                                <div className="text-[var(--color-fg)] font-medium break-words">{c.value}</div>
                                <div className="text-[10px] text-[var(--color-fg-subtle)] mt-0.5">{c.source}</div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
