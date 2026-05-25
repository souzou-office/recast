// src/lib/officecli.ts
// OfficeCLI (https://github.com/iOfficeAI/OfficeCLI) の薄いラッパー。
//
// recast の Phase 3 (書類生成) と verify (チェック) を OfficeCLI ベースに置き換えるための
// 中核モジュール。AI は JSON で「officecli コマンドの意図」を出力 (C 案)、このモジュールが
// CLI 引数に組み立てて exec する。
//
// 設計原則:
//   - 薄く保つ。officecli の挙動を再実装しない
//   - 引数の組み立て (--prop key=value) と child_process 呼び出しに専念
//   - エラーハンドリング: stderr を必ず捕捉、exit code を判定
//   - resident mode を活用 (連続コマンドの高速化)
//
// 環境変数:
//   - OFFICECLI_BIN: officecli バイナリのパス (デフォルト: PATH から探す)

import { spawn } from "child_process";
import path from "path";
import os from "os";

const OFFICECLI_BIN = process.env.OFFICECLI_BIN || "officecli";

export interface OfficeCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * OfficeCLI コマンドを 1 つ実行する。
 *
 * @param args officecli の引数配列 (例: ["view", "file.docx", "text"])
 * @param options.cwd 作業ディレクトリ
 * @param options.timeoutMs タイムアウト (デフォルト 30 秒)
 */
export async function runOfficeCli(
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<OfficeCliResult> {
  const { cwd = process.cwd(), timeoutMs = 30_000 } = options;
  return new Promise((resolve, reject) => {
    const proc = spawn(OFFICECLI_BIN, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`OfficeCLI timeout (${timeoutMs}ms): ${args.join(" ")}`));
    }, timeoutMs);
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

// ===== C 案: AI が出力する JSON コマンドの型 =====

/**
 * AI が Phase 2 で出力する 1 つのコマンド。
 * recast がこれを officecli の CLI 引数に組み立てる。
 *
 * 例:
 *   { command: "set", path: "/body/p[@paraId=064BAB11]",
 *     props: { find: "令和８年２月１１日", replace: "令和８年６月１日" } }
 *
 * → exec("officecli set <file> '/body/p[@paraId=064BAB11]'
 *            --prop find=令和８年２月１１日 --prop replace=令和８年６月１日")
 */
export interface OfficeCliCommand {
  command: "set" | "add" | "remove" | "get" | "query" | "view" | "validate" | "close";
  path?: string;       // /body/p[@paraId=...] 等。view/validate 等は不要
  parent?: string;     // add のとき (例: "/body")
  type?: string;       // add のとき (例: "paragraph", "comment")
  after?: string;      // add のとき位置指定
  before?: string;     // add のとき位置指定
  props?: Record<string, string>;  // --prop key=value
  reason?: string;     // デバッグ用 (CLI には反映しない)
}

/**
 * OfficeCliCommand を officecli の CLI 引数配列に変換する。
 * exec しやすいように args を返す (実行は呼び出し側で runOfficeCli)。
 */
export function buildArgs(file: string, cmd: OfficeCliCommand): string[] {
  const args: string[] = [cmd.command, file];
  if (cmd.command === "add" && cmd.parent) {
    args.push(cmd.parent);
  } else if (cmd.path) {
    args.push(cmd.path);
  }
  if (cmd.type) {
    args.push("--type", cmd.type);
  }
  if (cmd.after) {
    args.push("--after", cmd.after);
  }
  if (cmd.before) {
    args.push("--before", cmd.before);
  }
  if (cmd.props) {
    for (const [k, v] of Object.entries(cmd.props)) {
      args.push("--prop", `${k}=${v}`);
    }
  }
  return args;
}

/**
 * 一連の OfficeCliCommand をファイルに対して順次実行する。
 * 最後に close でファイルに flush。
 *
 * @returns 各コマンドの結果 (エラー含む)
 */
export interface CommandExecResult {
  command: OfficeCliCommand;
  result: OfficeCliResult;
  ok: boolean;
  error?: string;
}

export async function applyCommands(
  file: string,
  commands: OfficeCliCommand[]
): Promise<CommandExecResult[]> {
  const results: CommandExecResult[] = [];
  for (const cmd of commands) {
    const args = buildArgs(file, cmd);
    try {
      const result = await runOfficeCli(args);
      const ok = result.exitCode === 0;
      results.push({
        command: cmd,
        result,
        ok,
        error: ok ? undefined : `exit=${result.exitCode}: ${result.stderr.trim()}`,
      });
    } catch (e) {
      results.push({
        command: cmd,
        result: { stdout: "", stderr: "", exitCode: -1 },
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // 最後に close でファイルに保存 (resident mode が動いてる場合の flush)
  try {
    await runOfficeCli(["close", file]);
  } catch {
    // resident が動いてなければ No resident running エラーが出るが、無視 OK
  }
  return results;
}

// ===== 読み取り系ヘルパー =====

/** ファイルの全段落をテキストで取得 (AI に渡す用) */
export async function viewText(file: string): Promise<string> {
  const r = await runOfficeCli(["view", file, "text"]);
  if (r.exitCode !== 0) throw new Error(`viewText failed: ${r.stderr}`);
  return r.stdout;
}

/** ファイル構造を JSON で取得 */
export async function getJson(file: string, xpath: string, depth: number = 2): Promise<unknown> {
  const r = await runOfficeCli(["get", file, xpath, "--depth", String(depth), "--json"]);
  if (r.exitCode !== 0) throw new Error(`getJson failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** CSS-like selector でクエリ */
export async function query(
  file: string,
  selector: string,
  asJson: boolean = false
): Promise<string | unknown> {
  const args = ["query", file, selector];
  if (asJson) args.push("--json");
  const r = await runOfficeCli(args);
  if (r.exitCode !== 0) throw new Error(`query failed: ${r.stderr}`);
  return asJson ? JSON.parse(r.stdout) : r.stdout;
}

/** issues / validate でチェック */
export async function viewIssues(
  file: string,
  type?: "format" | "content" | "structure"
): Promise<string> {
  const args = ["view", file, "issues"];
  if (type) args.push("--type", type);
  const r = await runOfficeCli(args);
  if (r.exitCode !== 0) throw new Error(`viewIssues failed: ${r.stderr}`);
  return r.stdout;
}

// ===== ユーティリティ =====

/** バイナリが動くか確認 (起動チェック用) */
export async function ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const r = await runOfficeCli(["--version"], { timeoutMs: 5000 });
    if (r.exitCode === 0) {
      return { ok: true, version: r.stdout.trim() };
    }
    return { ok: false, error: r.stderr };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 作業用 docx のテンポラリコピーを作る (元テンプレを汚さないため) */
export async function copyToTemp(srcPath: string, label?: string): Promise<string> {
  const fs = await import("fs/promises");
  const tmpDir = path.join(os.tmpdir(), "recast-officecli");
  await fs.mkdir(tmpDir, { recursive: true });
  const base = path.basename(srcPath);
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const safeLabel = label ? label.replace(/[\\/:*?"<>|]/g, "_") + "_" : "";
  const dst = path.join(tmpDir, `${stamp}_${safeLabel}${base}`);
  await fs.copyFile(srcPath, dst);
  return dst;
}
