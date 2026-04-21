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

  // verify の指摘を収集（この書類への指摘だけ）
  const flatIssues = (verifyIssues || []).flatMap(vi => vi.issues);

  // 項目にマッチする verify issue を返す。
  // ラベルが issue.problem または aspect に「明示的に」含まれている場合のみ紐付ける。
  // 値ベースのマッチング（例: "5000" や "岩下歌武輝"）は別項目にも当たる偽陽性が多いため採用しない。
  const getSlotIssues = (slot: FilledSlot) => {
    if (flatIssues.length === 0) return [];
    const label = (slot.label || "").trim();
    // ラベルが短すぎる・不明な場合はマッチングしない（偽陽性の元）
    if (label.length < 3 || label.startsWith("slot_") || label === "不明") return [];
    return flatIssues.filter(iss => {
      const haystack = `${iss.problem || ""} ${iss.aspect || ""}`;
      // ラベル全体が含まれる場合のみヒット（部分一致に頼らない）
      return haystack.includes(label);
    });
  };
  const isSlotFlagged = (slot: FilledSlot): boolean => getSlotIssues(slot).length > 0;

  // どの項目にも紐付かない issue（= 単独で上に出したい指摘）
  const unmatchedIssues = flatIssues.filter(iss => {
    return !filledSlots.some(s => {
      const label = (s.label || "").trim();
      if (label.length < 3 || label.startsWith("slot_") || label === "不明") return false;
      const haystack = `${iss.problem || ""} ${iss.aspect || ""}`;
      return haystack.includes(label);
    });
  });

  // 空欄（初期値が空）の項目は表示しない。ただし verify が指摘しているものは表示。
  // 編集中に空にした（変更済みだが空）ものも表示し続ける。
  const visibleSlots = filledSlots.filter(s => {
    const cur = values[s.slotId] ?? s.value;
    const hasInitialValue = !!(s.value && s.value.trim());
    const hasCurrentValue = !!(cur && cur.trim());
    return hasInitialValue || hasCurrentValue || isSlotFlagged(s);
  });

  // copyIndex ごとにグループ化（複数部数書類用）
  const slotsByCopy = new Map<number | undefined, FilledSlot[]>();
  for (const s of visibleSlots) {
    const key = s.copyIndex;
    if (!slotsByCopy.has(key)) slotsByCopy.set(key, []);
    slotsByCopy.get(key)!.push(s);
  }
  const groups = Array.from(slotsByCopy.entries()).sort((a, b) => (a[0] || 0) - (b[0] || 0));

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-hover)]">
        <span className="text-xs text-[var(--color-fg-muted)]">修正</span>
        {(() => {
          const changedCount = filledSlots.filter(s => (values[s.slotId] ?? s.value) !== s.value).length;
          if (changedCount === 0) return null;
          return (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent-fg)]">
              ✎ {changedCount} 件変更
            </span>
          );
        })()}
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
        {/* 項目に紐付かなかった verify 指摘はまとめて上に出す（どの項目のことか自動判定できなかったもの） */}
        {unmatchedIssues.length > 0 && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2.5">
            <div className="text-[11px] font-semibold text-red-800 mb-1 inline-flex items-center gap-1">
              <Icon name="AlertTriangle" size={11} /> AI指摘（項目特定できなかった分）
            </div>
            <ul className="space-y-1">
              {unmatchedIssues.map((iss, i) => (
                <li key={i} className="text-[10.5px] text-red-900 leading-relaxed">
                  ・{iss.problem}
                  {iss.expected && <span className="text-[var(--color-fg-muted)]"> → 正: <span className="font-medium">{iss.expected}</span></span>}
                </li>
              ))}
            </ul>
            <div className="text-[10px] text-[var(--color-fg-subtle)] mt-1.5">
              該当の項目を手動で見つけて修正してください（ラベルと指摘の文言が一致しないと自動紐付けできません）。
            </div>
          </div>
        )}

        {visibleSlots.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-subtle)]">編集可能な項目がありません。</p>
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
                  const slotIssues = getSlotIssues(s);
                  const flagged = slotIssues.length > 0;
                  return (
                    <div key={`${copyIndex}-${s.slotId}`} className={`rounded-lg border p-2.5 ${
                      changed
                        ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]/30 ring-1 ring-[var(--color-accent)]/30"
                        : flagged
                        ? "border-red-400 bg-red-50 ring-1 ring-red-200"
                        : "border-[var(--color-border)] bg-[var(--color-panel)]"
                    }`}>
                      <div className="flex items-center gap-2 mb-1.5">
                        {flagged && !changed && <span className="text-[11px] text-red-600" title="AIが修正推奨">🔴</span>}
                        {changed && <span className="text-[11px] text-[var(--color-accent)]" title="変更済み">✎</span>}
                        <span className="text-[11px] font-medium text-[var(--color-fg)]">{s.label}</span>
                      </div>

                      {/* 修正理由（verify の指摘）をインライン表示 */}
                      {flagged && !changed && (
                        <div className="mb-1.5 rounded bg-red-100/60 border border-red-200 px-2 py-1.5">
                          {slotIssues.map((iss, i) => (
                            <div key={i} className="text-[10.5px] text-red-900 leading-relaxed">
                              <span className="font-semibold">AI指摘:</span> {iss.problem}
                              {iss.expected && (
                                <span> → 正: <span className="font-medium">{iss.expected}</span></span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 変更時は 変更前 → 変更後 を明示表示 */}
                      {changed && (
                        <div className="mb-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed">
                          <span className="text-[10px] text-[var(--color-fg-subtle)] w-10 shrink-0 mt-0.5">変更前</span>
                          <span className="text-[var(--color-fg-subtle)] line-through break-words">{s.value || "(空)"}</span>
                        </div>
                      )}

                      <div className="flex items-start gap-1.5">
                        {changed && (
                          <span className="text-[10px] text-[var(--color-accent)] font-medium w-10 shrink-0 mt-1.5">変更後</span>
                        )}
                        <div className="flex-1 flex items-center gap-1.5 relative">
                          <input
                            type="text"
                            value={current}
                            onChange={e => handleChange(s.slotId, e.target.value)}
                            className={`flex-1 rounded border px-2 py-1 text-[12px] ${
                              changed
                                ? "border-[var(--color-accent)] bg-white font-medium"
                                : "border-[var(--color-border)] bg-[var(--color-bg)]"
                            }`}
                          />
                          {cands.length > 0 && (
                            <button
                              onClick={() => setOpenDropdown(openDropdown === s.slotId ? null : s.slotId)}
                              className="shrink-0 inline-flex items-center gap-0.5 rounded border border-[var(--color-border)] bg-[var(--color-hover)] px-2 py-1 text-[10px] text-[var(--color-fg-muted)] hover:bg-[var(--color-accent-soft)]"
                            >
                              候補 {cands.length} <Icon name="ChevronDown" size={10} />
                            </button>
                          )}
                          {changed && (
                            <button
                              onClick={() => handleChange(s.slotId, s.value)}
                              className="shrink-0 text-[10px] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] px-1"
                              title="元の値に戻す"
                            >
                              ↶戻す
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
