"use client";

import { useEffect, useState } from "react";
import type { Company } from "@/types";
import FilePreview from "./FilePreview";

import { Icon } from "./ui/Icon";
interface ViewerFile {
  id: string;
  name: string;
}

interface Props {
  company: Company | null;
  onUpdate: () => void;
}

interface SourceFileRow {
  path: string;
  name: string;
  folder: string;
}

interface ProfileSection {
  title: string;
  rows: { key: string; value: string }[];
}

// AIの出力を項目ごとにパースしてセクション分け
function parseProfile(summary: string): ProfileSection[] {
  const lines = summary.split("\n");
  const allRows: { key: string; value: string }[] = [];

  let currentKey = "";
  let currentValue = "";

  for (const line of lines) {
    const raw = line.replace(/\*+/g, "");
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // 【セクション見出し】はスキップ
    if (/^【.+】$/.test(trimmed)) {
      if (currentKey) allRows.push({ key: currentKey, value: currentValue.trim() });
      currentKey = "";
      currentValue = "";
      continue;
    }

    // インデント行（スペース2つ以上 or タブ始まり）→ 前のキーの値の続き
    const isIndented = raw.match(/^[ \t]{2,}/) || raw.match(/^　/);

    if (isIndented && currentKey) {
      currentValue += "\n" + trimmed;
      continue;
    }

    // 「キー: 値」形式
    const match = trimmed.match(/^([^:：]+?)[：:](.*)$/);
    if (match) {
      if (currentKey) allRows.push({ key: currentKey, value: currentValue.trim() });
      currentKey = match[1].replace(/^[\-•]\s*/, "").trim();
      currentValue = match[2].trim();
    } else if (currentKey) {
      currentValue += "\n" + trimmed;
    }
  }
  if (currentKey) allRows.push({ key: currentKey, value: currentValue.trim() });

  // セクション分け（キー名で判定）
  const registryKeys = ["会社法人等番号", "商号", "本店", "設立", "事業目的", "資本金", "発行可能", "発行済", "譲渡制限", "役員", "新株予約権", "公告", "その他登記"];
  const articlesKeys = ["決算", "任期"];
  const shareholderKeys = ["株主"];
  const otherKeys = ["備考"];

  function matchSection(key: string, keywords: string[]): boolean {
    return keywords.some(kw => key.includes(kw));
  }

  const registry: { key: string; value: string }[] = [];
  const articles: { key: string; value: string }[] = [];
  const shareholders: { key: string; value: string }[] = [];
  const other: { key: string; value: string }[] = [];

  for (const row of allRows) {
    const k = row.key;
    if (matchSection(k, articlesKeys)) {
      articles.push(row);
    } else if (matchSection(k, shareholderKeys)) {
      shareholders.push(row);
    } else if (matchSection(k, otherKeys)) {
      other.push(row);
    } else if (matchSection(k, registryKeys)) {
      registry.push(row);
    } else {
      registry.push(row);
    }
  }

  const sections: ProfileSection[] = [];
  if (registry.length > 0) sections.push({ title: "登記簿情報", rows: registry });
  if (articles.length > 0) sections.push({ title: "定款情報", rows: articles });
  if (shareholders.length > 0) sections.push({ title: "株主名簿", rows: shareholders });
  if (other.length > 0) sections.push({ title: "備考", rows: other });

  if (sections.length === 0 && allRows.length > 0) {
    sections.push({ title: "基本情報", rows: allRows });
  }

  return sections;
}

// 値をレンダリング。複数行で「/」区切りがあればカード形式で表示
function renderValue(value: string) {
  const lines = value.split("\n").filter(l => l.trim());

  // 複数行で「/」区切りが含まれるか判定
  const hasSlashFormat = lines.length > 1 && lines.filter(l => l.includes("/")).length >= 2;

  if (hasSlashFormat) {
    type Record = { fields: string[]; isTotal: boolean; raw: string };
    const records: Record[] = lines
      .map(line => {
        const trimmed = line.trim().replace(/^[\-•・]\s*/, "");
        const fields = trimmed.split("/").map(f => f.trim()).filter(Boolean);
        const isTotal = /^合計(?:[:：\s]|$)/.test(trimmed);
        return { fields, isTotal, raw: trimmed };
      })
      .filter(r => r.fields.length > 0);

    const dataRecords = records.filter(r => !r.isTotal && r.fields.length >= 2);
    const totalRecord = records.find(r => r.isTotal);
    const otherLines = records.filter(r => r.fields.length < 2 && !r.isTotal);

    return (
      <div className="space-y-2">
        {dataRecords.map((r, i) => (
          <div key={i} className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-hover)]/40 px-3 py-2">
            {r.fields.map((field, fi) => {
              const labelMatch = field.match(/^(.+?)[：:](.+)$/);
              if (labelMatch) {
                return (
                  <div key={fi} className="flex gap-2 py-0.5">
                    <span className="text-xs text-[var(--color-fg-subtle)] shrink-0 w-20">{labelMatch[1].trim()}</span>
                    <span className="text-sm text-[var(--color-fg)]">{labelMatch[2].trim()}</span>
                  </div>
                );
              }
              if (fi === 0) return <div key={fi} className="text-sm font-medium text-[var(--color-fg)] pb-0.5">{field}</div>;
              return <div key={fi} className="text-sm text-[var(--color-fg-muted)] py-0.5">{field}</div>;
            })}
          </div>
        ))}
        {totalRecord && (
          <div className="flex items-center gap-3 pt-1 px-3 text-[13px]">
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)] w-20 shrink-0">合計</span>
            <span className="flex items-center gap-4 text-[var(--color-fg)]">
              {totalRecord.fields
                .filter(f => !/^合計/.test(f))
                .map((f, fi) => {
                  const labelMatch = f.match(/^(.+?)[：:](.+)$/);
                  return <span key={fi}>{labelMatch ? labelMatch[2].trim() : f}</span>;
                })}
            </span>
          </div>
        )}
        {otherLines.map((r, i) => (
          <p key={`other-${i}`} className="text-xs text-[var(--color-fg-muted)] px-1">{r.raw}</p>
        ))}
      </div>
    );
  }

  // 複数行だが「/」区切りでない場合
  if (lines.length > 1) {
    return (
      <div className="space-y-1">
        {lines.map((line, i) => (
          <div key={i} className="text-sm">{line.trim()}</div>
        ))}
      </div>
    );
  }

  // 単一行
  return <span>{value}</span>;
}

export default function CompanyProfile({ company, onUpdate }: Props) {
  const [generating, setGenerating] = useState(false);
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [profileJson, setProfileJson] = useState("");
  const [profileJsonDirty, setProfileJsonDirty] = useState(false);
  const [availableSources, setAvailableSources] = useState<SourceFileRow[]>([]);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [sourcesLoading, setSourcesLoading] = useState(true);

  // 共通フォルダの全ファイル一覧と選択状態をロード（会社が変わった時だけ）。
  // dep を company?.id にしているのは、トグルの度に onUpdate() で company の参照が
  // 変わっても再フェッチ＝チェックのちらつきを起こさないため。会社切替時はそもそも
  // 親が key={companyId} で再マウントするので、id 依存で十分。
  useEffect(() => {
    const cid = company?.id;
    if (!cid) return;
    setSourcesLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/workspace/profile/sources?companyId=${encodeURIComponent(cid)}`);
        if (!res.ok) return;
        const data = await res.json();
        const files: SourceFileRow[] = data.files || [];
        setAvailableSources(files);
        const fileSet = new Set(files.map(f => f.path));
        // 保存済み選択のうち、現存ファイルだけに絞る（消えたファイルのゴミ掃除）。
        // 未設定（空配列）または全滅した場合は「全選択」扱い。
        const saved: string[] = (data.selected || []).filter((p: string) => fileSet.has(p));
        setSelectedSources(saved.length > 0 ? new Set(saved) : new Set(fileSet));
      } catch { /* ignore */ }
      finally { setSourcesLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id]);

  // 選択を楽観的に反映してから1回だけ保存する。
  // 全選択 = 未設定扱い（空配列で保存）→ 後で追加されたファイルも自動で対象になる。
  const persistSources = async (next: Set<string>) => {
    if (!company) return;
    setSelectedSources(next);
    const paths = next.size === availableSources.length ? [] : Array.from(next);
    try {
      await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setProfileSources", companyId: company.id, paths }),
      });
    } catch { /* ignore */ }
    onUpdate();
  };

  const toggleSource = (path: string) => {
    const next = new Set(selectedSources);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    persistSources(next);
  };

  const toggleFolder = (paths: string[], allSelected: boolean) => {
    const next = new Set(selectedSources);
    if (allSelected) for (const p of paths) next.delete(p);
    else for (const p of paths) next.add(p);
    persistSources(next);
  };

  const toggleAll = () => {
    const next = selectedSources.size === availableSources.length
      ? new Set<string>()
      : new Set(availableSources.map(f => f.path));
    persistSources(next);
  };

  const downloadFile = async (filePath: string, name: string) => {
    const res = await fetch("/api/workspace/raw-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
    });
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-hover)]">
        <div className="text-center">
          <Icon name="FileText" size={36} className="mx-auto mb-2 text-[var(--color-fg-subtle)]" />
          <p className="text-sm text-[var(--color-fg-subtle)]">サイドバーから会社を選択してください</p>
        </div>
      </div>
    );
  }

  const commonSubs = company.subfolders.filter(s => s.role === "common");

  const generateProfile = async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/workspace/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id }),
      });
      if (res.ok) {
        onUpdate();
      } else {
        const err = await res.json();
        alert(err.error || "生成に失敗しました");
      }
    } catch { /* ignore */ }
    finally { setGenerating(false); }
  };

  const deleteProfile = async () => {
    if (!confirm(`「${company.name}」の基本情報を削除しますか？\n\nこの操作は元に戻せません。元のファイルは残ります。`)) return;
    try {
      const res = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deleteProfile", companyId: company.id }),
      });
      if (res.ok) onUpdate();
    } catch { /* ignore */ }
  };

  const profile = company.profile;
  const sections = profile?.summary ? parseProfile(profile.summary) : [];

  // 参照元ファイルをサブフォルダごとにグループ化
  const groupedSources: Record<string, SourceFileRow[]> = {};
  for (const f of availableSources) {
    (groupedSources[f.folder] ||= []).push(f);
  }
  const allSourcesSelected = availableSources.length > 0 && selectedSources.size === availableSources.length;
  const noneSelected = availableSources.length > 0 && selectedSources.size === 0;

  // 「何が読まれるか」を直接見える化＆選べる参照元ファイル一覧。
  // ここが基本情報の“真実のソース”。共通パターンや role を知らなくても、
  // チェックの入ったファイルがそのまま生成対象になる。
  const sourceSelector = (
    <div className="rounded-2xl bg-[var(--color-panel)] border border-[var(--color-border)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
      <div className="bg-[var(--color-hover)] border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-serif text-[16px] font-semibold text-[var(--color-fg)]">この資料から基本情報を作成します</h3>
            <p className="text-xs text-[var(--color-fg-subtle)] mt-0.5">
              チェックを入れたファイルだけを読み取って基本情報を生成します。
            </p>
          </div>
          {availableSources.length > 0 && (
            <div className="flex items-center gap-3 shrink-0 pt-0.5">
              <span className="text-xs text-[var(--color-fg-subtle)] whitespace-nowrap">
                {allSourcesSelected ? `全 ${availableSources.length} 件` : `${selectedSources.size} / ${availableSources.length} 件`}
              </span>
              <button onClick={toggleAll} className="text-xs text-[var(--color-accent)] hover:underline whitespace-nowrap">
                {allSourcesSelected ? "全解除" : "全選択"}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="px-4 py-3 max-h-[360px] overflow-y-auto">
        {sourcesLoading ? (
          <p className="text-sm text-[var(--color-fg-muted)]">読込中...</p>
        ) : availableSources.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)]">
            {commonSubs.length === 0
              ? "サイドバーでフォルダを「共通」に設定すると、ここに参照できるファイルが表示されます。"
              : "共通フォルダに読み取り可能なファイルがありません。"}
          </p>
        ) : (
          <div className="space-y-3">
            {noneSelected && (
              <p className="text-xs text-[var(--color-warn-fg)]">
                ファイルが1つも選択されていません。1つ以上選択してください（未選択のままだと全ファイルが対象になります）。
              </p>
            )}
            {Object.entries(groupedSources).map(([folder, rows]) => {
              const folderPaths = rows.map(r => r.path);
              const selCount = folderPaths.filter(p => selectedSources.has(p)).length;
              const allInFolder = selCount === folderPaths.length;
              const someInFolder = selCount > 0 && !allInFolder;
              return (
                <div key={folder}>
                  <label className="flex items-center gap-2 cursor-pointer px-1 py-1 rounded hover:bg-[var(--color-hover)]">
                    <input
                      type="checkbox"
                      checked={allInFolder}
                      ref={el => { if (el) el.indeterminate = someInFolder; }}
                      onChange={() => toggleFolder(folderPaths, allInFolder)}
                      className="w-3.5 h-3.5"
                    />
                    <Icon name="Folder" size={13} className="text-[var(--color-fg-subtle)] shrink-0" />
                    <span className="text-[12px] font-medium text-[var(--color-fg-muted)] truncate">{folder}</span>
                    <span className="text-[11px] text-[var(--color-fg-subtle)] shrink-0">({selCount}/{folderPaths.length})</span>
                  </label>
                  <div className="space-y-0.5 ml-6 mt-0.5">
                    {rows.map(r => {
                      const checked = selectedSources.has(r.path);
                      return (
                        <div
                          key={r.path}
                          className={`flex items-center gap-2 px-1 py-1 rounded hover:bg-[var(--color-hover)] ${checked ? "" : "opacity-50"}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSource(r.path)}
                            className="w-3.5 h-3.5 shrink-0"
                          />
                          <Icon name="FileText" size={12} className="text-[var(--color-fg-subtle)] shrink-0" />
                          <button
                            onClick={() => setViewerFile({ id: r.path, name: r.name })}
                            className="min-w-0 flex-1 truncate text-left text-sm text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] hover:underline"
                            title={r.name}
                          >
                            {r.name}
                          </button>
                          <button
                            onClick={() => downloadFile(r.path, r.name)}
                            className="text-[10px] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)] shrink-0"
                          >
                            DL
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  const profileContent = (
    <div className="h-full overflow-y-auto bg-[var(--color-bg)]">
      <div className="w-[65%] min-w-[560px] max-w-[1100px] mx-auto px-10 py-10">
        {/* ヘッダー */}
        <div className="mb-8">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="font-serif text-[26px] font-semibold tracking-tight text-[var(--color-fg)]">{company.name}</h2>
              {profile && (
                <p className="text-xs text-[var(--color-fg-subtle)] mt-1">
                  最終更新: {new Date(profile.updatedAt).toLocaleDateString("ja-JP")}
                  &nbsp;&middot;&nbsp;
                  元資料: {profile.sourceFiles.length}件
                  {profile.structured && (
                    <span className="ml-2 text-[var(--color-ok-fg)]">JSON保存済</span>
                  )}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {profile?.structured && (
                <button
                  onClick={() => {
                    if (!showJson && profile?.structured) {
                      setProfileJson(JSON.stringify({ structured: profile.structured, 変更履歴: profile.変更履歴 || [] }, null, 2));
                      setProfileJsonDirty(false);
                    }
                    setShowJson(!showJson);
                  }}
                  className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    showJson
                      ? "bg-[var(--color-fg)] text-white"
                      : "border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-hover)]"
                  }`}
                >
                  {showJson ? "テーブル表示" : "JSON表示"}
                </button>
              )}
              {profile && (
                <button
                  onClick={deleteProfile}
                  className="shrink-0 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                  title="基本情報を削除（元のファイルは残ります）"
                >
                  削除
                </button>
              )}
              <button
                onClick={generateProfile}
                disabled={generating || commonSubs.length === 0 || noneSelected}
                title={noneSelected ? "参照するファイルを1つ以上選択してください" : undefined}
                className="shrink-0 rounded-lg bg-[var(--color-fg)] px-4 py-2 text-sm font-medium text-white
                           hover:opacity-90 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                {generating ? "生成中..." : profile ? "再生成" : "基本情報を生成"}
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {profile && showJson && profile.structured ? (
            <div className="rounded-2xl bg-[var(--color-panel)] border border-[var(--color-border)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
              <div className="bg-[var(--color-fg)] border-b border-[var(--color-border)] px-4 py-2.5 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--color-bg)]">Structured JSON</h3>
                {profileJsonDirty && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setProfileJson(JSON.stringify({ structured: profile.structured, 変更履歴: profile.変更履歴 || [] }, null, 2));
                        setProfileJsonDirty(false);
                      }}
                      className="text-xs text-[var(--color-fg-subtle)] hover:text-[var(--color-bg)]"
                    >
                      リセット
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          const parsed = JSON.parse(profileJson);
                          await fetch("/api/workspace/master-sheet", {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ companyId: company.id, type: "profile", structured: parsed.structured || parsed }),
                          });
                          setProfileJsonDirty(false);
                          onUpdate();
                        } catch {
                          alert("JSONの形式が正しくありません");
                        }
                      }}
                      className="rounded bg-[var(--color-fg)] px-2 py-0.5 text-xs text-white hover:opacity-90"
                    >
                      保存
                    </button>
                  </div>
                )}
              </div>
              <textarea
                value={profileJson}
                onChange={e => { setProfileJson(e.target.value); setProfileJsonDirty(true); }}
                className="w-full min-h-[400px] p-4 text-xs text-[var(--color-fg-subtle)] bg-[var(--color-fg)] font-mono border-0 focus:outline-none resize-none leading-relaxed"
                spellCheck={false}
              />
            </div>
          ) : profile && sections.length > 0 ? (
            <>
              {sections.map((section, si) => (
                <div key={si} className="rounded-2xl bg-[var(--color-panel)] border border-[var(--color-border)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
                  <div className="bg-[var(--color-hover)] border-b border-[var(--color-border)] px-4 py-2.5">
                    <h3 className="font-serif text-[16px] font-semibold text-[var(--color-fg)]">{section.title}</h3>
                  </div>
                  <table className="w-full table-fixed">
                    <tbody>
                      {section.rows.map((row, ri) => (
                        <tr key={ri} className="border-b border-[var(--color-border-soft)] last:border-0">
                          <th className="w-[180px] px-4 py-3 text-left text-[12px] font-medium text-[var(--color-fg-muted)] align-top break-words leading-relaxed bg-[var(--color-hover)]/50">
                            {row.key}
                          </th>
                          <td className="px-4 py-3 text-sm text-[var(--color-fg)] leading-relaxed">
                            {renderValue(row.value)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          ) : profile?.summary ? (
            <div className="rounded-2xl bg-[var(--color-panel)] border border-[var(--color-border)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] p-6">
              <pre className="text-sm text-[var(--color-fg)] whitespace-pre-wrap leading-relaxed">
                {profile.summary}
              </pre>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] p-6 text-center bg-[var(--color-panel)]">
              <Icon name="ClipboardList" size={32} className="mx-auto mb-2 text-[var(--color-fg-subtle)]" />
              <p className="text-sm text-[var(--color-fg-muted)]">
                {commonSubs.length === 0
                  ? "サイドバーでフォルダを「共通」に設定してください"
                  : "下の参照ファイルを確認して「基本情報を生成」を押してください"}
              </p>
            </div>
          )}

          {/* 参照元ファイル（“何が読まれるか”を直接選べる一覧） */}
          {sourceSelector}
        </div>
      </div>
    </div>
  );

  // ビューワーなし → 基本情報を中央に
  if (!viewerFile) {
    return (
      <div className="h-full">
        {profileContent}
      </div>
    );
  }

  // ビューワーあり → 左右分割
  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        {profileContent}
      </div>
      <FilePreview
        filePath={viewerFile.id}
        fileName={viewerFile.name}
        onClose={() => setViewerFile(null)}
      />
    </div>
  );
}
