"use client";

import { useState } from "react";
import type { Company, CaseRoom } from "@/types";
import CaseOrganizer from "./CaseOrganizer";
import DocumentGenerator from "./DocumentGenerator";
import VerificationView from "./VerificationView";

type CaseSubTab = "organize" | "documents" | "check";

interface Props {
  company: Company | null;
  onUpdate: () => void;
}

export default function CaseRoomView({ company, onUpdate }: Props) {
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<CaseSubTab>("organize");
  const [creating, setCreating] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editNameValue, setEditNameValue] = useState("");

  if (!company) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">サイドバーから会社を選択してください</p>
      </div>
    );
  }

  const caseRooms = company.caseRooms || [];
  const selectedRoom = caseRooms.find(r => r.id === selectedRoomId);

  // 案件部屋を作成
  const handleCreate = async () => {
    setCreating(true);

    // activeなjobフォルダの中のチェック付きサブフォルダを案件名のベースにする
    const activeSub = company.subfolders.find(s => s.role === "job" && s.active);
    const disabled = new Set(activeSub?.disabledFiles || []);
    let checkedFolderNames: string[] = [];
    let folderPath = activeSub?.id || "";

    if (activeSub) {
      try {
        const res = await fetch("/api/workspace/list-files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: activeSub.id }),
        });
        const data = await res.json();
        // チェックが付いている（disabledに入っていない）サブフォルダ名
        checkedFolderNames = (data.subfolders || [])
          .filter((sf: { path: string }) => !disabled.has(sf.path))
          .map((sf: { name: string }) => sf.name);
      } catch { /* ignore */ }
    }

    // チェック付きフォルダ名から案件名を生成
    let displayName = checkedFolderNames.join(" / ") || activeSub?.name || "新規案件";
    try {
      const res = await fetch("/api/workspace/suggest-case-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folderName: checkedFolderNames.join(", ") || activeSub?.name || "",
          fileNames: checkedFolderNames,
          companyName: company.name,
        }),
      });
      const data = await res.json();
      if (data.name) displayName = data.name;
    } catch { /* ignore */ }

    // 保存
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createCaseRoom",
        companyId: company.id,
        folderPath: folderPath,
        displayName,
      }),
    });
    onUpdate();
    setCreating(false);
  };

  // 案件名変更
  const handleRename = async (roomId: string) => {
    if (!editNameValue.trim()) return;
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "updateCaseRoom",
        companyId: company.id,
        caseRoomId: roomId,
        displayName: editNameValue.trim(),
      }),
    });
    setEditingName(null);
    onUpdate();
  };

  // 案件削除
  const handleDelete = async (roomId: string) => {
    if (!confirm("この案件を削除しますか？")) return;
    await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "deleteCaseRoom",
        companyId: company.id,
        caseRoomId: roomId,
      }),
    });
    if (selectedRoomId === roomId) setSelectedRoomId(null);
    onUpdate();
  };

  // 案件一覧（部屋未選択時）
  if (!selectedRoom) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold text-gray-800">{company.name} の案件</h2>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300"
            >
              {creating ? "作成中..." : "+ 新規案件"}
            </button>
          </div>

          {caseRooms.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <p className="text-3xl mb-3">📋</p>
              <p className="text-sm">案件がありません</p>
              <p className="text-xs mt-1">サイドバーでフォルダを選択してから「+ 新規案件」で作成</p>
            </div>
          ) : (
            <div className="space-y-2">
              {caseRooms.map(room => (
                <div key={room.id} className="rounded-xl border border-gray-200 hover:border-blue-300 transition-colors">
                  <div className="flex items-center gap-3 px-5 py-4">
                    <button
                      onClick={() => { setSelectedRoomId(room.id); setSubTab("organize"); }}
                      className="flex-1 text-left"
                    >
                      {editingName === room.id ? (
                        <input
                          type="text"
                          value={editNameValue}
                          onChange={e => setEditNameValue(e.target.value)}
                          onBlur={() => handleRename(room.id)}
                          onKeyDown={e => { if (e.key === "Enter") handleRename(room.id); if (e.key === "Escape") setEditingName(null); }}
                          autoFocus
                          onClick={e => e.stopPropagation()}
                          className="text-base font-bold text-gray-800 border-b border-blue-400 outline-none w-full"
                        />
                      ) : (
                        <h3 className="text-base font-bold text-gray-800">{room.displayName}</h3>
                      )}
                      <div className="flex gap-2 mt-1">
                        {room.masterSheet && <span className="text-[9px] bg-green-100 text-green-600 rounded px-1.5 py-0.5">案件整理済</span>}
                        {room.generatedDocuments && room.generatedDocuments.length > 0 && (
                          <span className="text-[9px] bg-blue-100 text-blue-600 rounded px-1.5 py-0.5">書類{room.generatedDocuments.length}件</span>
                        )}
                        {room.checkResult && <span className="text-[9px] bg-purple-100 text-purple-600 rounded px-1.5 py-0.5">チェック済</span>}
                      </div>
                      <p className="text-[10px] text-gray-400 mt-1">{new Date(room.updatedAt).toLocaleString("ja-JP")}</p>
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => { setEditingName(room.id); setEditNameValue(room.displayName); }}
                        className="text-[10px] text-gray-400 hover:text-blue-600 px-1"
                      >
                        名前変更
                      </button>
                      <button
                        onClick={() => handleDelete(room.id)}
                        className="text-[10px] text-gray-400 hover:text-red-600 px-1"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 案件部屋（サブタブ付き）
  return (
    <div className="flex flex-col h-full">
      {/* 案件部屋ヘッダー */}
      <div className="border-b border-gray-200 px-6 py-2 flex items-center gap-4 bg-white shrink-0">
        <button
          onClick={() => setSelectedRoomId(null)}
          className="text-xs text-blue-500 hover:text-blue-700"
        >
          ← 一覧に戻る
        </button>
        <h3 className="text-sm font-bold text-gray-800 flex-1 truncate">{selectedRoom.displayName}</h3>
        {/* サブタブ */}
        <div className="flex gap-1">
          {([
            { id: "organize", label: "案件整理" },
            { id: "documents", label: "書類作成" },
            { id: "check", label: "チェック" },
          ] as { id: CaseSubTab; label: string }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                subTab === t.id
                  ? "bg-blue-100 text-blue-700 font-medium"
                  : "text-gray-500 hover:bg-gray-100"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* サブタブ内容 */}
      <div className="flex-1 overflow-hidden">
        {subTab === "organize" && (
          <CaseOrganizer
            company={company}
            caseRoom={selectedRoom}
            onUpdate={onUpdate}
            visible={true}
          />
        )}
        {subTab === "documents" && (
          <DocumentGenerator
            company={company}
            caseRoom={selectedRoom}
            onUpdate={onUpdate}
          />
        )}
        {subTab === "check" && (
          <VerificationView
            company={company}
            caseRoom={selectedRoom}
            onUpdate={onUpdate}
          />
        )}
      </div>
    </div>
  );
}
