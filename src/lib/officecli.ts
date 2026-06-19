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
    const proc = spawn(OFFICECLI_BIN, args, {
      cwd,
      shell: false,
      // batch を --input で渡すと「stdin も redirect されてる」警告が出るので抑止。
      env: { ...process.env, OFFICECLI_BATCH_ALLOW_STDIN_REDIRECT: "1" },
    });
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
  if (commands.length === 0) return [];

  // officecli batch で「1 回の open/save cycle」にまとめて実行する。
  // 旧実装はコマンドごとに officecli プロセスを起動 (+末尾 close) しており、produce-v2 の
  // 14 書類並列と相まって Windows のプロセス資源を枯渇させ (exit 0xC0000142)、後段の
  // verify コメント書き込み等が固まる原因だった。batch なら 1 書類 = 1 プロセス・1 開閉。
  const batchInput = commands.map((c) => {
    const o: Record<string, unknown> = { command: c.command };
    if (c.path) o.path = c.path;
    if (c.parent) o.parent = c.parent;
    if (c.type) o.type = c.type;
    if (c.after) o.after = c.after;
    if (c.before) o.before = c.before;
    if (c.props) o.props = c.props;
    return o;
  });

  const fsp = await import("fs/promises");
  const tmpDir = path.join(os.tmpdir(), "recast-officecli");
  await fsp.mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  await fsp.writeFile(tmp, JSON.stringify(batchInput), "utf-8");

  // 大量コマンドでも CLI 長制限に当たらないよう --input (ファイル) で渡す。
  type BatchItem = { index: number; success: boolean; output?: string; error?: string };
  let resultsArr: BatchItem[] = [];
  let runErr = "";
  try {
    const r = await runOfficeCli(["batch", file, "--input", tmp, "--json"], { timeoutMs: 120_000 });
    try {
      const j = JSON.parse(r.stdout) as { data?: { results?: BatchItem[] } };
      resultsArr = j.data?.results ?? [];
      if (resultsArr.length === 0 && r.exitCode !== 0) runErr = r.stderr.trim() || `exit=${r.exitCode}`;
    } catch {
      runErr = (r.stderr || "batch 出力を JSON parse できません").trim();
    }
  } catch (e) {
    runErr = e instanceof Error ? e.message : String(e);
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }

  const byIndex = new Map(resultsArr.map((x) => [x.index, x]));
  return commands.map((cmd, i) => {
    const x = byIndex.get(i);
    if (!x) {
      return { command: cmd, result: { stdout: "", stderr: runErr, exitCode: -1 }, ok: false, error: runErr || "batch 結果なし" };
    }
    return {
      command: cmd,
      result: { stdout: x.output ?? "", stderr: x.error ?? "", exitCode: x.success ? 0 : -1 },
      ok: x.success,
      error: x.success ? undefined : x.error,
    };
  });
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
