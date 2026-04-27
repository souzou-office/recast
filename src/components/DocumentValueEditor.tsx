"use client";

import { useState, useEffect } from "react";
import { Icon } from "./ui/Icon";
import type { FilledSlot, CheckIssue } from "@/types";

type Candidate = { value: string; source: string };

interface Props {
  filledSlots: FilledSlot[];
  templatePath: string;
  fileName: string;
  companyId: string;
  threadId?: string;
  // verify が返す issues。各 issue に slotId と candidates が含まれる（新形式）。
  verifyIssues?: { docName: string; issues: CheckIssue[] }[];
  // 再生成後、親（ChatWorkflow）に新しい docxBase64 と filledSlots を伝える
  onRegenerated: (docxBase64: string, filledSlots: FilledSlot[]) => void;
  // 指摘の acknowledged 状態を親に通知（slotId に紐付く全 issue を一括 ack/解除）
  onIssueAcknowledge?: (slotId: number, acknowledged: boolean) => void;
  // 再生成成功時に親（FilePreview）にプレビュータブ切替を要求
  onSwitchToPreview?: () => void;
}

export default function DocumentValueEditor({
  filledSlots,
  templatePath,
  fileName,
  companyId,
  threadId,
  verifyIssues,
  onRegenerated,
  onIssueAcknowledge,
  onSwitchToPreview,
}: Props) {
  // スロット値の編集状態（slotId → value）
  const [values, setValues] = useState<Record<number, string>>({});
  // ユーザーが「値は正しい、指摘は無視」と確認済みにしたスロット
  const [acknowledgedSlots, setAcknowledgedSlots] = useState<Set<number>>(new Set());
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

  // 永続化された acknowledged 状態を復元
  useEffect(() => {
    const set = new Set<number>();
    for (const vi of verifyIssues || []) {
      for (const iss of vi.issues) {
        if (iss.acknowledged && typeof iss.slotId === "number") set.add(iss.slotId);
      }
    }
    setAcknowledgedSlots(set);
  }, [verifyIssues]);

  // verify の指摘から、slotId 別に issue + candidates を構築（AI 呼び出しなし、純機械処理）
  const flatIssues: CheckIssue[] = (verifyIssues || []).flatMap(vi => vi.issues);
  const slotIssues: Record<number, CheckIssue[]> = {};
  const candidates: Record<number, Candidate[]> = {};
  for (const iss of flatIssues) {
    if (typeof iss.slotId !== "number") continue;
    if (!slotIssues[iss.slotId]) slotIssues[iss.slotId] = [];
    slotIssues[iss.slotId].push(iss);
    // issue.candidates を slot の候補にマージ（重複除去）
    if (iss.candidates && iss.candidates.length > 0) {
      if (!candidates[iss.slotId]) candidates[iss.slotId] = [];
      const seen = new Set(candidates[iss.slotId].map(c => c.value));
      for (const c of iss.candidates) {
        if (c?.value && !seen.has(c.value)) {
          candidates[iss.slotId].push(c);
          seen.add(c.value);
        }
      }
    }
  }

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
        // 値を変えた slot に紐付く verify 指摘は「直した」とみなして自動で acknowledged 扱い
        if (onIssueAcknowledge) {
          for (const s of filledSlots) {
            const newVal = values[s.slotId] ?? s.value;
            if (newVal !== s.value) onIssueAcknowledge(s.slotId, true);
          }
        }
        onRegenerated(data.docxBase64, newSlots);
        setDirty(false);
        // 再生成完了後、プレビュータブに自動切替して結果を見せる
        onSwitchToPreview?.();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(`再生成失敗: ${err.error || "不明なエラー"}`);
      }
    } catch (e) {
      alert(`再生成失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
    setRegenerating(false);
  };

  // 項目ごとの指摘（slotId が付いている issue のみ）。確認済み項目は抑止。
  const getSlotIssues = (slot: FilledSlot): CheckIssue[] => {
    if (acknowledgedSlots.has(slot.slotId)) return [];
    return slotIssues[slot.slotId] || [];
  };
  const isSlotFlagged = (slot: FilledSlot): boolean => getSlotIssues(slot).length > 0;

  // slotId が付いていない指摘（書類全体の話・自信なし）= 上部の「未分類」へ
  const unmatchedIssues = flatIssues.filter(iss => typeof iss.slotId !== "number");

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
        <button
          onClick={handleRegenerate}
          disabled={!dirty || regenerating}
          className="ml-auto inline-flex items-center gap-1 rounded-full bg-[var(--color-accent)] px-3 py-1 text-[10px] font-medium text-white hover:opacity-90 disabled:opacity-50"
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

                      {/* 修正理由（verify の指摘）をインライン表示 + 確認済みボタン */}
                      {flagged && !changed && (
                        <div className="mb-1.5 rounded bg-red-100/60 border border-red-200 px-2 py-1.5">
                          {getSlotIssues(s).map((iss, i) => (
                            <div key={i} className="text-[10.5px] text-red-900 leading-relaxed">
                              <span className="font-semibold">AI指摘:</span> {iss.problem}
                              {iss.expected && (
                                <span> → 正: <span className="font-medium">{iss.expected}</span></span>
                              )}
                            </div>
                          ))}
                          <button
                            onClick={() => {
                              setAcknowledgedSlots(prev => new Set(prev).add(s.slotId));
                              onIssueAcknowledge?.(s.slotId, true);
                            }}
                            className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-white border border-red-300 px-2 py-0.5 text-[10px] text-red-700 hover:bg-red-50"
                            title="この指摘は確認した（値はこのままでOK）"
                          >
                            <Icon name="CheckCircle2" size={10} /> 確認済み
                          </button>
                        </div>
                      )}
                      {/* 一度 確認済みにした後は戻せるように */}
                      {acknowledgedSlots.has(s.slotId) && !changed && (
                        <div className="mb-1.5 text-[10px] text-[var(--color-fg-subtle)] inline-flex items-center gap-1">
                          <Icon name="CheckCircle2" size={10} className="text-[var(--color-ok-fg)]" /> 確認済み
                          <button
                            onClick={() => {
                              setAcknowledgedSlots(prev => { const n = new Set(prev); n.delete(s.slotId); return n; });
                              onIssueAcknowledge?.(s.slotId, false);
                            }}
                            className="ml-2 underline hover:text-[var(--color-fg)]"
                          >
                            戻す
                          </button>
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
