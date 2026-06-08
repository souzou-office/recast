"use client";

import { useEffect, useState } from "react";
import type { Company, SubfolderRole } from "@/types";
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

interface SourceFile {
  path: string;
  name: string;
}

interface FolderRow {
  id: string;
  name: string;
  role: SubfolderRole;
  matchedPattern: string | null;
  files: SourceFile[];
}

interface ProfileSection {
  title: string;
  rows: { key: string; value: string }[];
}

// フォルダの role バッジ
function RoleBadge({ role }: { role: SubfolderRole }) {
  const map: Record<SubfolderRole, { label: string; cls: string }> = {
    common: { label: "共通", cls: "bg-[var(--color-ok-bg)] text-[var(--color-ok-fg)]" },
    job: { label: "案件", cls: "bg-[var(--color-hover)] text-[var(--color-fg-muted)]" },
    none: { label: "除外", cls: "bg-[var(--color-hover)] text-[var(--color-fg-subtle)]" },
  };
  const m = map[role];
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${m.cls}`}>{m.label}</span>;
}

// 「なぜこのフォルダがこの扱いなのか」を平易に説明（共通パターンとの関係を見える化）
function folderReason(f: FolderRow): string {
  if (f.role === "common") {
    return f.matchedPattern ? `共通パターン「${f.matchedPattern}」に一致 → 自動で使用` : "手動で「共通」に設定 → 使用";
  }
  if (f.role === "job") {
    return f.matchedPattern
      ? `手動で「案件」に設定（パターン「${f.matchedPattern}」一致）／自動では未使用`
      : "案件フォルダ（自動では未使用）";
  }
  return f.matchedPattern
    ? `手動で「除外」に設定（パターン「${f.matchedPattern}」一致）／未使用`
    : "除外フォルダ（基本情報には未使用）";
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
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
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [autoPaths, setAutoPaths] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [isAuto, setIsAuto] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sourcesLoading, setSourcesLoading] = useState(true);

  // 参照元フォルダ/ファイルと選択状態をロード（会社が変わった時だけ）。
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
        const fs: FolderRow[] = data.folders || [];
        const auto: string[] = data.autoPaths || [];
        setFolders(fs);
        setAutoPaths(auto);
        // 共通フォルダは開いて見せる、それ以外（案件/除外）は折りたたみ
        setExpanded(new Set(fs.filter(f => f.role === "common").map(f => f.id)));
        // 保存済み選択（profileSources）を現存ファイルと突合（消えたパスを除外）
        const allPaths = new Set(fs.flatMap(f => f.files.map(x => x.path)));
        const saved: string[] = (data.selected || []).filter((p: string) => allPaths.has(p));
        if (saved.length > 0) {
          setChecked(new Set(saved));
          setIsAuto(false);
        } else {
          // おまかせ: 共通フォルダのファイルを使う
          setChecked(new Set(auto));
          setIsAuto(true);
        }
      } catch { /* ignore */ }
      finally { setSourcesLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id]);

  // 選択を楽観的に反映してから1回だけ保存する。
  // おまかせ（= 選択が共通フォルダと完全一致）なら空配列で保存し、後で追加された
  // 共通フォルダのファイルも自動的に対象になるようにする。
  const persist = async (nextChecked: Set<string>, forceAuto: boolean) => {
    if (!company) return;
    const autoNow = forceAuto || setsEqual(nextChecked, new Set(autoPaths));
    setChecked(nextChecked);
    setIsAuto(autoNow);
    const paths = autoNow ? [] : Array.from(nextChecked);
    try {
      await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setProfileSources", companyId: company.id, paths }),
      });
    } catch { /* ignore */ }
    onUpdate();
  };

  const toggleFile = (path: string) => {
    const next = new Set(checked);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    persist(next, false);
  };

  const toggleFolder = (folder: FolderRow, allSelected: boolean) => {
    const next = new Set(checked);
    if (allSelected) for (const f of folder.files) next.delete(f.path);
    else for (const f of folder.files) next.add(f.path);
    persist(next, false);
  };

  const resetToAuto = () => {
    persist(new Set(autoPaths), true);
  };

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  const visibleFolders = folders.filter(f => f.files.length > 0);
  // 実際に基本情報生成で読まれる件数（おまかせ=共通フォルダ件数 / 手動=チェック件数）
  const effectiveCount = isAuto ? autoPaths.length : checked.size;

  // 「何が読まれるか」を見える化＆その場で選べる参照元パネル。
  // 共通パターン/ロールは“初期の自動提案”。ここでのチェックが最終的な正。
  const sourceSelector = (
    <div className="rounded-2xl bg-[var(--color-panel)] border border-[var(--color-border)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
      <div className="bg-[var(--color-hover)] border-b border-[var(--color-border)] px-4 py-3">
        <h3 className="font-serif text-[16px] font-semibold text-[var(--color-fg)]">基本情報の作成に使うファイル</h3>
        <p className="text-xs text-[var(--color-fg-subtle)] mt-1 leading-relaxed">
          設定の「共通パターン」に名前が一致したフォルダが最初は自動で「共通」になり、その中のファイルが使われます。
          下のチェックを変えれば、パターンやフォルダの種類に関係なく、好きなファイルを直接選べます。
        </p>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {isAuto ? (
            <span className="text-xs text-[var(--color-fg-muted)]">
              現在: <span className="font-semibold text-[var(--color-fg)]">おまかせ</span>
              （共通フォルダのファイルを自動使用・{autoPaths.length}件）
            </span>
          ) : (
            <>
              <span className="text-xs text-[var(--color-fg-muted)]">
                現在: <span className="font-semibold text-[var(--color-fg)]">手動</span>で {checked.size} 件を選択中
              </span>
              <button onClick={resetToAuto} className="text-xs text-[var(--color-accent)] hover:underline">
                おまかせに戻す
              </button>
            </>
          )}
        </div>
      </div>
      <div className="px-3 py-3 max-h-[420px] overflow-y-auto space-y-2">
        {sourcesLoading ? (
          <p className="text-sm text-[var(--color-fg-muted)] px-1">読込中...</p>
        ) : visibleFolders.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)] px-1">
            このフォルダには読み取り可能なファイルがありません。サイドバーで会社のフォルダ構成を確認してください。
          </p>
        ) : (
          <>
            {!isAuto && checked.size === 0 && (
              <p className="text-xs text-[var(--color-warn-fg)] px-1">
                ファイルが1つも選択されていません。1つ以上選ぶか「おまかせに戻す」を押してください。
              </p>
            )}
            {visibleFolders.map(folder => {
              const folderChecked = folder.files.filter(f => checked.has(f.path)).length;
              const allIn = folderChecked === folder.files.length;
              const someIn = folderChecked > 0 && !allIn;
              const isOpen = expanded.has(folder.id);
              return (
                <div key={folder.id} className="rounded-lg border border-[var(--color-border-soft)] overflow-hidden">
                  <div className="flex items-center gap-2 px-2 py-2 bg-[var(--color-hover)]/40">
                    <input
                      type="checkbox"
                      checked={allIn}
                      ref={el => { if (el) el.indeterminate = someIn; }}
                      onChange={() => toggleFolder(folder, allIn)}
                      className="w-3.5 h-3.5 shrink-0"
                    />
                    <button
                      onClick={() => toggleExpand(folder.id)}
                      className="min-w-0 flex-1 flex items-center gap-2 text-left"
                    >
                      <Icon name={isOpen ? "ChevronDown" : "ChevronRight"} size={13} className="text-[var(--color-fg-subtle)] shrink-0" />
                      <RoleBadge role={folder.role} />
                      <span className="text-[13px] font-medium text-[var(--color-fg)] truncate">{folder.name}</span>
                      <span className="text-[11px] text-[var(--color-fg-subtle)] shrink-0">{folderChecked}/{folder.files.length}</span>
                    </button>
                  </div>
                  <p className="text-[11px] text-[var(--color-fg-subtle)] px-2 pl-9 py-1">{folderReason(folder)}</p>
                  {isOpen && (
                    <div className="space-y-0.5 px-2 pb-2 pl-9">
                      {folder.files.map(f => {
                        const ck = checked.has(f.path);
                        return (
                          <div
                            key={f.path}
                            className={`flex items-center gap-2 px-1 py-1 rounded hover:bg-[var(--color-hover)] ${ck ? "" : "opacity-50"}`}
                          >
                            <input
                              type="checkbox"
                              checked={ck}
                              onChange={() => toggleFile(f.path)}
                              className="w-3.5 h-3.5 shrink-0"
                            />
                            <Icon name="FileText" size={12} className="text-[var(--color-fg-subtle)] shrink-0" />
                            <button
                              onClick={() => setViewerFile({ id: f.path, name: f.name })}
                              className="min-w-0 flex-1 truncate text-left text-sm text-[var(--color-accent)] hover:text-[var(--color-accent-fg)] hover:underline"
                              title={f.name}
                            >
                              {f.name}
                            </button>
                            <button
                              onClick={() => downloadFile(f.path, f.name)}
                              className="text-[10px] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)] shrink-0"
                            >
                              DL
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </>
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
                disabled={generating || effectiveCount === 0}
                title={effectiveCount === 0 ? "参照するファイルがありません（下でファイルを選ぶか、サイドバーでフォルダを共通にしてください）" : undefined}
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
                下の参照ファイルを確認して「基本情報を生成」を押してください
              </p>
            </div>
          )}

          {/* 参照元ファイル（“何が読まれるか”を見える化＋直接選択） */}
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
