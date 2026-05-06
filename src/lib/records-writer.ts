/**
 * 作業記録の自動書き出し。
 *
 * 設計方針:
 *   recordsBasePath が設定されていれば、スレッドが更新されるたびに以下を書き出す:
 *     <recordsBasePath>/<会社名>/<案件名>/
 *       00_案件整理.md          ← masterSheet.content
 *       01_質問回答.json        ← clarification cards から抽出
 *       02_生成書類/<filename>  ← generatedDocuments の docxBase64 を docx として保存
 *       03_検証結果.md          ← verify の結果（issues + 確認済み）
 *       meta.json              ← updatedAt, displayName 等
 *
 *   クラウドストレージ (Google Drive for Desktop / OneDrive 等) のフォルダを
 *   recordsBasePath に指定すれば、自動同期で他 PC・他人と即共有できる。
 *
 *   ファイル名に使えない文字（\ / : * ? " < > |）はサニタイズする。
 *   既存ファイルは上書き（最新が常に正、履歴はクラウドストレージのバージョン管理に任せる）。
 *
 *   失敗してもスレッド保存自体は止めない（書き出しは best-effort）。
 */

import fs from "fs/promises";
import path from "path";
import type { ChatThread, Company, ClarificationCard, GeneratedDocument } from "@/types";

// ファイル名に使えない文字を置換
function sanitize(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
}

// 会社名 → フォルダ名（ID は会社のローカルパス自体なので末端だけ使う）
function companyFolderName(company: Company): string {
  if (company.name) return sanitize(company.name);
  // フォールバック: ID 末端
  const last = company.id.split(/[\\/]/).pop() || "company";
  return sanitize(last);
}

// 案件（スレッド）→ フォルダ名
function threadFolderName(thread: ChatThread): string {
  const display = thread.displayName || "案件";
  return sanitize(`${display}_${thread.id}`);
}

// clarification cards から Q&A を抽出
function extractQA(thread: ChatThread): { placeholder: string; question: string; answer: string; options?: string[] }[] {
  const result: { placeholder: string; question: string; answer: string; options?: string[] }[] = [];
  for (const m of thread.messages || []) {
    for (const c of (m.cards || [])) {
      if (c.type !== "clarification") continue;
      const card = c as ClarificationCard;
      for (const q of card.questions || []) {
        let ans = "";
        if (q.selectedOptionId === "_manual") ans = q.manualInput || "";
        else if (q.selectedOptionId) {
          const opt = q.options.find(o => o.id === q.selectedOptionId);
          ans = opt?.label || "";
        }
        if (!ans) continue;
        result.push({
          placeholder: q.placeholder,
          question: q.question,
          answer: ans,
          options: q.options.map(o => o.label),
        });
      }
    }
  }
  return result;
}

// 検証結果を Markdown 化
function buildVerifyMarkdown(thread: ChatThread): string {
  const lines: string[] = ["# 検証結果", ""];
  // document-result カードから issues を集める
  let totalIssues = 0;
  for (const m of thread.messages || []) {
    for (const c of (m.cards || [])) {
      if (c.type !== "document-result") continue;
      for (const doc of c.documents || []) {
        const active = (doc.issues || []).filter(i => !i.acknowledged);
        const acked = (doc.issues || []).filter(i => i.acknowledged);
        if (active.length === 0 && acked.length === 0) continue;
        lines.push(`## ${doc.name}`);
        lines.push(`ステータス: ${doc.checkStatus || "未検証"}`);
        if (active.length > 0) {
          lines.push("");
          lines.push("### 未解決の指摘");
          for (const iss of active) {
            const sev = iss.severity === "error" ? "🔴" : iss.severity === "warn" ? "🟡" : "🔵";
            lines.push(`- ${sev} ${iss.problem}${iss.expected ? ` （正: ${iss.expected}）` : ""}`);
            totalIssues++;
          }
        }
        if (acked.length > 0) {
          lines.push("");
          lines.push("### 確認済みの指摘");
          for (const iss of acked) {
            lines.push(`- ✓ ${iss.problem}`);
          }
        }
        lines.push("");
      }
    }
  }
  if (totalIssues === 0 && lines.length === 2) {
    lines.push("（指摘なし）");
  }
  return lines.join("\n");
}

// メイン: スレッドを recordsBasePath 以下に書き出す
export async function writeThreadRecords(
  thread: ChatThread,
  company: Company,
  recordsBasePath: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!recordsBasePath || !recordsBasePath.trim()) {
    return { ok: false, error: "recordsBasePath が未設定" };
  }
  try {
    const baseExists = await fs.stat(recordsBasePath).then(s => s.isDirectory()).catch(() => false);
    if (!baseExists) {
      return { ok: false, error: `recordsBasePath が存在しないかフォルダではない: ${recordsBasePath}` };
    }

    const targetDir = path.join(recordsBasePath, companyFolderName(company), threadFolderName(thread));
    await fs.mkdir(targetDir, { recursive: true });

    // 00 案件整理
    if (thread.masterSheet?.content) {
      await fs.writeFile(path.join(targetDir, "00_案件整理.md"), thread.masterSheet.content, "utf-8");
    }

    // 01 Q&A
    const qa = extractQA(thread);
    if (qa.length > 0) {
      await fs.writeFile(path.join(targetDir, "01_質問回答.json"), JSON.stringify(qa, null, 2), "utf-8");
    }

    // 02 生成書類
    const docs: GeneratedDocument[] = thread.generatedDocuments || [];
    if (docs.length > 0) {
      const docDir = path.join(targetDir, "02_生成書類");
      await fs.mkdir(docDir, { recursive: true });
      for (const d of docs) {
        if (!d.docxBase64 || !d.fileName) continue;
        const buf = Buffer.from(d.docxBase64, "base64");
        await fs.writeFile(path.join(docDir, sanitize(d.fileName)), buf);
      }
    }

    // 03 検証結果
    const verifyMd = buildVerifyMarkdown(thread);
    if (verifyMd.trim().length > "# 検証結果".length + 5) {
      await fs.writeFile(path.join(targetDir, "03_検証結果.md"), verifyMd, "utf-8");
    }

    // メタ
    const meta = {
      threadId: thread.id,
      displayName: thread.displayName,
      companyName: company.name,
      companyId: company.id,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      generatedDocumentCount: docs.length,
      qaCount: qa.length,
      lastWrittenAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(targetDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");

    return { ok: true, path: targetDir };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
