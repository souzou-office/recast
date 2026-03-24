"use client";

import { useState } from "react";
import type { Company, StructuredProfile, OfficerInfo, ShareholderInfo, ChangeHistoryEntry } from "@/types";

interface ViewerFile {
  id: string;
  name: string;
}

interface Props {
  company: Company | null;
  onUpdate: () => void;
}

// structured JSONからセクション別にレンダリング
function renderStructured(data: StructuredProfile) {
  const simpleFields: { label: string; key: keyof StructuredProfile }[] = [
    { label: "会社法人等番号", key: "会社法人等番号" },
    { label: "商号", key: "商号" },
    { label: "本店所在地", key: "本店所在地" },
    { label: "設立年月日", key: "設立年月日" },
    { label: "資本金", key: "資本金" },
    { label: "発行可能株式総数", key: "発行可能株式総数" },
    { label: "発行済株式総数", key: "発行済株式総数" },
    { label: "株式の譲渡制限", key: "株式の譲渡制限" },
    { label: "新株予約権", key: "新株予約権" },
    { label: "公告方法", key: "公告方法" },
    { label: "決算期", key: "決算期" },
    { label: "役員の任期", key: "役員の任期" },
  ];

  return (
    <div className="space-y-4">
      {/* 登記簿・定款情報 */}
      <Section title="登記簿・定款情報">
        <table className="w-full">
          <tbody>
            {simpleFields.map(({ label, key }) => {
              const val = data[key];
              if (!val || val === "不明") return null;
              return (
                <tr key={key} className="border-b border-gray-100 last:border-0">
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 w-44 align-top bg-gray-50/50 whitespace-nowrap">
                    {label}
                  </th>
                  <td className="px-4 py-3 text-sm text-gray-800 leading-relaxed">
                    {typeof val === "string" ? val : JSON.stringify(val)}
                  </td>
                </tr>
              );
            })}
            {/* 事業目的 */}
            {data.事業目的 && data.事業目的.length > 0 && (
              <tr className="border-b border-gray-100">
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 w-44 align-top bg-gray-50/50 whitespace-nowrap">
                  事業目的
                </th>
                <td className="px-4 py-3 text-sm text-gray-800 leading-relaxed">
                  <ol className="list-decimal list-inside space-y-0.5">
                    {data.事業目的.map((item, i) => (
                      <li key={i}>{item.replace(/^\(\d+\)\s*/, "")}</li>
                    ))}
                  </ol>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      {/* 役員 */}
      {data.役員 && data.役員.length > 0 && (
        <Section title="役員">
          <div className="px-4 py-3 space-y-2">
            {data.役員.map((officer: OfficerInfo, i: number) => (
              <div key={i} className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
                <div className="text-sm font-medium text-gray-900">{officer.役職} {officer.氏名}</div>
                {officer.住所 && <div className="text-xs text-gray-500 mt-0.5">住所: {officer.住所}</div>}
                <div className="flex gap-4 mt-0.5">
                  {officer.就任日 && <span className="text-xs text-gray-500">就任: {officer.就任日}</span>}
                  {officer.任期満了 && <span className="text-xs text-gray-500">任期満了: {officer.任期満了}</span>}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 株主 */}
      {data.株主 && data.株主.length > 0 && (
        <Section title="株主構成">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">氏名</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">住所</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">持株数</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">持株比率</th>
              </tr>
            </thead>
            <tbody>
              {data.株主.map((sh: ShareholderInfo, i: number) => (
                <tr key={i} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-2 text-sm text-gray-800">{sh.氏名}</td>
                  <td className="px-4 py-2 text-sm text-gray-600">{sh.住所 || "-"}</td>
                  <td className="px-4 py-2 text-sm text-gray-800">{sh.持株数 || "-"}</td>
                  <td className="px-4 py-2 text-sm text-gray-800">{sh.持株比率 || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* 備考 */}
      {data.備考 && data.備考 !== "不明" && (
        <Section title="備考">
          <div className="px-4 py-3 text-sm text-gray-700">{data.備考}</div>
        </Section>
      )}
    </div>
  );
}

function renderChangeHistory(history: ChangeHistoryEntry[]) {
  if (!history || history.length === 0) return null;
  return (
    <Section title="変更履歴">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 w-28">日付</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">内容</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 w-48">根拠ファイル</th>
          </tr>
        </thead>
        <tbody>
          {history.map((entry, i) => (
            <tr key={i} className="border-b border-gray-100 last:border-0">
              <td className="px-4 py-2 text-sm text-gray-600">{entry.日付}</td>
              <td className="px-4 py-2 text-sm text-gray-800">{entry.内容}</td>
              <td className="px-4 py-2 text-sm text-gray-500">{entry.根拠ファイル}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white shadow-sm border border-gray-200 overflow-hidden">
      <div className="bg-gray-50 border-b border-gray-200 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      </div>
      {children}
    </div>
  );
}

// 旧フリーテキスト形式のフォールバック表示
function renderLegacySummary(summary: string) {
  return (
    <div className="rounded-xl bg-white shadow-sm border border-gray-200 p-6">
      <pre className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
        {summary}
      </pre>
    </div>
  );
}

export default function CompanyProfile({ company, onUpdate }: Props) {
  const [generating, setGenerating] = useState(false);
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null);
  const [splitRatio, setSplitRatio] = useState(50);
  const [dragging, setDragging] = useState(false);

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
  const hasStructured = profile?.structured;

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
                </p>
              )}
            </div>
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

        {profile && hasStructured ? (
          <>
            {renderStructured(profile.structured!)}
            {renderChangeHistory(profile.変更履歴 || [])}

            {/* 元資料リスト */}
            <div className="mt-4">
              <Section title="参照元資料">
                <div className="px-4 py-3">
                  <ul className="space-y-1">
                    {profile.sourceFiles.map((f, i) => {
                      const name = typeof f === "string" ? f : f.name;
                      const fileId = typeof f === "string" ? null : f.id;
                      const url = fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
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
                              <a href={url!} target="_blank" rel="noopener noreferrer"
                                className="text-[10px] text-gray-400 hover:text-gray-600 shrink-0">
                                別タブ
                              </a>
                            </div>
                          ) : (
                            <span className="text-gray-600">{name}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </Section>
            </div>
          </>
        ) : profile?.summary ? (
          renderLegacySummary(profile.summary)
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
      <div className="h-full flex justify-center">
        <div className="w-full max-w-4xl">{profileContent}</div>
      </div>
    );
  }

  // ビューワーあり → 左右分割
  const previewUrl = `https://drive.google.com/file/d/${viewerFile.id}/preview`;
  const openUrl = `https://drive.google.com/file/d/${viewerFile.id}/view`;

  const handleMouseDown = () => {
    setDragging(true);
    const handleMouseMove = (e: MouseEvent) => {
      const container = document.getElementById("split-container");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitRatio(Math.min(Math.max(ratio, 20), 80));
    };
    const handleMouseUp = () => {
      setDragging(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <div id="split-container" className="flex h-full" style={{ userSelect: dragging ? "none" : undefined }}>
      <div className="min-w-0 overflow-hidden" style={{ width: `${splitRatio}%` }}>
        {profileContent}
      </div>
      <div
        onMouseDown={handleMouseDown}
        className="w-1.5 shrink-0 cursor-col-resize bg-gray-200 hover:bg-blue-400 transition-colors"
      />
      <div className="flex min-w-0 flex-1 flex-col bg-white overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 shrink-0">
          <h3 className="text-sm font-medium text-gray-700 truncate" title={viewerFile.name}>
            {viewerFile.name}
          </h3>
          <div className="flex items-center gap-3 shrink-0">
            <a href={openUrl} target="_blank" rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:text-blue-800">
              別タブで開く
            </a>
            <button onClick={() => setViewerFile(null)}
              className="text-gray-400 hover:text-gray-600 text-lg leading-none">
              &times;
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          <iframe src={previewUrl} className="h-full w-full border-0"
            style={{ pointerEvents: dragging ? "none" : undefined }} allow="autoplay" />
        </div>
      </div>
    </div>
  );
}
