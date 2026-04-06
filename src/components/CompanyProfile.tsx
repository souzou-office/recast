"use client";

import { useState } from "react";
import type { Company } from "@/types";
import ProfileTemplateModal from "./ProfileTemplateModal";
import FilePreview from "./FilePreview";

interface ViewerFile {
  id: string;
  name: string;
}

interface Props {
  company: Company | null;
  onUpdate: () => void;
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
    return (
      <div className="space-y-2">
        {lines.map((line, i) => {
          const trimmed = line.trim().replace(/^[\-•・]\s*/, "");
          if (!trimmed) return null;

          // 「/」で分割してフィールドに
          const fields = trimmed.split("/").map(f => f.trim()).filter(Boolean);

          if (fields.length >= 2) {
            return (
              <div key={i} className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
                {fields.map((field, fi) => {
                  // 「ラベル: 値」形式か判定
                  const labelMatch = field.match(/^(.+?)[：:](.+)$/);
                  if (labelMatch) {
                    return (
                      <div key={fi} className="flex gap-2 py-0.5">
                        <span className="text-xs text-gray-400 shrink-0 w-20">{labelMatch[1].trim()}</span>
                        <span className="text-sm text-gray-800">{labelMatch[2].trim()}</span>
                      </div>
                    );
                  }
                  // 最初のフィールドは名前として太字
                  if (fi === 0) {
                    return <div key={fi} className="text-sm font-medium text-gray-900 pb-0.5">{field}</div>;
                  }
                  return <div key={fi} className="text-sm text-gray-700 py-0.5">{field}</div>;
                })}
              </div>
            );
          }

          // 「/」なしの行（注釈等）
          return <p key={i} className="text-xs text-gray-500">{trimmed}</p>;
        })}
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
  const [showTemplateModal, setShowTemplateModal] = useState(false);

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="text-lg text-gray-300 mb-2">&#128196;</p>
          <p className="text-sm text-gray-400">サイドバーから会社を選択してください</p>
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

  const profile = company.profile;
  const sections = profile?.summary ? parseProfile(profile.summary) : [];

  const profileContent = (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="px-6 py-6">
        {/* ヘッダー */}
        <div className="mb-5">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-gray-900">{company.name}</h2>
              {profile && (
                <p className="text-xs text-gray-400 mt-1">
                  最終更新: {new Date(profile.updatedAt).toLocaleDateString("ja-JP")}
                  &nbsp;&middot;&nbsp;
                  元資料: {profile.sourceFiles.length}件
                  {profile.structured && (
                    <span className="ml-2 text-green-500">JSON保存済</span>
                  )}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowTemplateModal(true)}
                className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
              >
                抽出項目
              </button>
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
                      ? "bg-gray-800 text-white"
                      : "border border-gray-300 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {showJson ? "テーブル表示" : "JSON表示"}
                </button>
              )}
              <button
                onClick={generateProfile}
                disabled={generating || commonSubs.length === 0}
                className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white
                           hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                {generating ? "生成中..." : profile ? "再生成" : "基本情報を生成"}
              </button>
            </div>
          </div>
        </div>

        {profile && showJson && profile.structured ? (
          <div className="space-y-4">
            <div className="rounded-xl bg-white shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-gray-800 border-b border-gray-700 px-4 py-2.5 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-200">Structured JSON</h3>
                {profileJsonDirty && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setProfileJson(JSON.stringify({ structured: profile.structured, 変更履歴: profile.変更履歴 || [] }, null, 2));
                        setProfileJsonDirty(false);
                      }}
                      className="text-xs text-gray-400 hover:text-gray-200"
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
                      className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-700"
                    >
                      保存
                    </button>
                  </div>
                )}
              </div>
              <textarea
                value={profileJson}
                onChange={e => { setProfileJson(e.target.value); setProfileJsonDirty(true); }}
                className="w-full min-h-[400px] p-4 text-xs text-gray-300 bg-gray-900 font-mono border-0 focus:outline-none resize-none leading-relaxed"
                spellCheck={false}
              />
            </div>
          </div>
        ) : profile && sections.length > 0 ? (
          <div className="space-y-4">
            {sections.map((section, si) => (
              <div key={si} className="rounded-xl bg-white shadow-sm border border-gray-200 overflow-hidden">
                <div className="bg-gray-50 border-b border-gray-200 px-4 py-2.5">
                  <h3 className="text-sm font-semibold text-gray-700">{section.title}</h3>
                </div>
                <table className="w-full">
                  <tbody>
                    {section.rows.map((row, ri) => (
                      <tr key={ri} className="border-b border-gray-100 last:border-0">
                        <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 w-44 align-top bg-gray-50/50 whitespace-nowrap">
                          {row.key}
                        </th>
                        <td className="px-4 py-3 text-sm text-gray-800 leading-relaxed">
                          {renderValue(row.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            {/* 元資料リスト */}
            <div className="rounded-xl bg-white shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-gray-50 border-b border-gray-200 px-4 py-2.5">
                <h3 className="text-sm font-semibold text-gray-700">参照元資料</h3>
              </div>
              <div className="px-4 py-3">
                <ul className="space-y-1">
                  {profile.sourceFiles.map((f, i) => {
                    const name = typeof f === "string" ? f : f.name;
                    const fileId = typeof f === "string" ? null : f.id;
                    return (
                      <li key={i} className="text-sm flex items-center gap-2">
                        <span className="text-gray-400 text-xs">&#128196;</span>
                        {fileId ? (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setViewerFile({ id: fileId, name })}
                              className="text-blue-600 hover:text-blue-800 hover:underline text-left"
                            >
                              {name}
                            </button>
                            <button
                              onClick={async () => {
                                const res = await fetch("/api/workspace/raw-file", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ path: fileId }),
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
                              }}
                              className="text-[10px] text-gray-400 hover:text-gray-600 shrink-0"
                            >
                              DL
                            </button>
                          </div>
                        ) : (
                          <span className="text-gray-600">{name}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </div>
        ) : profile?.summary ? (
          <div className="rounded-xl bg-white shadow-sm border border-gray-200 p-6">
            <pre className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
              {profile.summary}
            </pre>
          </div>
        ) : (
          <div className="rounded-xl border-2 border-dashed border-gray-300 p-12 text-center bg-white">
            <p className="text-4xl mb-4">&#128203;</p>
            <p className="text-gray-500 mb-2">
              {commonSubs.length === 0
                ? "サイドバーで共通フォルダを設定してください"
                : "定款・登記等から会社の基本情報を自動抽出します"}
            </p>
            {commonSubs.length > 0 && (
              <p className="text-xs text-gray-400">
                共通フォルダ: {commonSubs.map(s => s.name).join(", ")}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );

  // ビューワーなし → 基本情報を中央に
  if (!viewerFile) {
    return (
      <>
        <div className="h-full flex justify-center">
          <div className="w-full max-w-4xl">{profileContent}</div>
        </div>
        {showTemplateModal && <ProfileTemplateModal onClose={() => setShowTemplateModal(false)} />}
      </>
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
      {showTemplateModal && <ProfileTemplateModal onClose={() => setShowTemplateModal(false)} />}
    </div>
  );
}
