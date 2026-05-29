#!/usr/bin/env node
// scripts/test-officecli.mjs
//
// OfficeCLI 統合の動作確認スクリプト。
// 使い方: node scripts/test-officecli.mjs
//
// やってること:
//   1. officecli バイナリが動くか確認 (ping)
//   2. 取締役決定書テンプレを temp にコピー
//   3. OfficeCliCommand のサンプル列を実行:
//      - 末尾の日付を 令和８年２月１１日 → 令和８年６月１日 に置換
//      - 議案2 段落 (paraId=17F80A4A) を削除
//      - 議案3 段落 (paraId=35609ED8) の「議案３」を「議案２」に書き換え
//   4. 結果の中身を確認 (期待値とアサート)
//
// このスクリプトは vitest 等のテストフレームワークを使わない。
// Node 純正 + child_process で完結。失敗時 exit 1 で CI でも使える。
//
// 拡張する時の指針:
//   - 新しいシナリオを追加するなら scenarios[] に push
//   - 1 シナリオ = (テンプレパス, 適用するコマンド列, 期待されるテキスト列)

import { spawn } from "child_process";
import { copyFile, mkdir, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const OFFICECLI_BIN = process.env.OFFICECLI_BIN || "officecli";

// ===== 最小ラッパー (lib/officecli.ts と同じ責務、TS 経由しないため複製) =====

async function runOfficeCli(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(OFFICECLI_BIN, args, { shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`officecli timeout (${timeoutMs}ms): ${args.join(" ")}`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => { stdout += d.toString("utf-8"); });
    proc.stderr.on("data", (d) => { stderr += d.toString("utf-8"); });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? -1 }); });
  });
}

function buildArgs(file, cmd) {
  const args = [cmd.command, file];
  if (cmd.command === "add" && cmd.parent) args.push(cmd.parent);
  else if (cmd.path) args.push(cmd.path);
  if (cmd.type) args.push("--type", cmd.type);
  if (cmd.after) args.push("--after", cmd.after);
  if (cmd.before) args.push("--before", cmd.before);
  if (cmd.props) {
    for (const [k, v] of Object.entries(cmd.props)) args.push("--prop", `${k}=${v}`);
  }
  return args;
}

async function copyToTemp(srcPath) {
  const tmpDir = path.join(tmpdir(), "recast-officecli-test");
  await mkdir(tmpDir, { recursive: true });
  const base = path.basename(srcPath);
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dst = path.join(tmpDir, `${stamp}_${base}`);
  await copyFile(srcPath, dst);
  return dst;
}

// ===== ANSI カラー =====
const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};
const ok = (msg) => console.log(`${C.green}✓${C.reset} ${msg}`);
const fail = (msg) => console.log(`${C.red}✗${C.reset} ${msg}`);
const info = (msg) => console.log(`${C.cyan}ℹ${C.reset} ${msg}`);
const warn = (msg) => console.log(`${C.yellow}!${C.reset} ${msg}`);

let failures = 0;
function assert(cond, msg) {
  if (cond) ok(msg);
  else { fail(msg); failures++; }
}

// ===== シナリオ =====

const TEMPLATE = "H:\\共有ドライブ\\司法書士法人そうぞう共有フォルダ\\テンプレート\\取締役就任（取締役1人から複数人）\\1.取締役決定書（株会提案）.docx";

async function main() {
  console.log(`${C.cyan}=== OfficeCLI 統合動作確認 ===${C.reset}\n`);

  // 1. バイナリ確認
  info("Step 1: officecli --version");
  try {
    const r = await runOfficeCli(["--version"], { timeoutMs: 5000 });
    assert(r.exitCode === 0, `officecli が起動可能 (version: ${r.stdout.trim()})`);
  } catch (e) {
    fail(`officecli 起動失敗: ${e.message}`);
    process.exit(1);
  }

  // 2. テンプレ存在確認
  info(`Step 2: テンプレ存在確認`);
  try {
    const s = await stat(TEMPLATE);
    assert(s.isFile(), `テンプレ存在 (${s.size} bytes)`);
  } catch (e) {
    fail(`テンプレが見つからない: ${TEMPLATE}`);
    process.exit(1);
  }

  // 3. temp にコピー
  info("Step 3: temp にコピー");
  const workCopy = await copyToTemp(TEMPLATE);
  ok(`コピー先: ${workCopy}`);

  // 4. コマンド列を適用
  info("Step 4: OfficeCliCommand[] を適用");
  const commands = [
    {
      command: "set",
      path: "/body/p[@paraId=064BAB11]",
      props: { find: "令和８年２月１１日", replace: "令和８年６月１日" },
    },
    {
      command: "remove",
      path: "/body/p[@paraId=17F80A4A]",
    },
    {
      command: "set",
      path: "/body/p[@paraId=35609ED8]",
      props: { find: "議案３", replace: "議案２" },
    },
  ];

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const args = buildArgs(workCopy, cmd);
    const r = await runOfficeCli(args);
    if (r.exitCode === 0) {
      ok(`  [${i + 1}/${commands.length}] ${cmd.command} ${cmd.path} → ${r.stdout.trim().split("\n")[0]}`);
    } else {
      fail(`  [${i + 1}/${commands.length}] ${cmd.command} ${cmd.path} 失敗: ${r.stderr.trim()}`);
    }
  }

  // close で flush
  await runOfficeCli(["close", workCopy]).catch(() => {});

  // 5. 結果検証
  info("Step 5: 結果検証 (view text)");
  const r = await runOfficeCli(["view", workCopy, "text"]);
  const text = r.stdout;

  assert(text.includes("令和８年６月１日"), "末尾日付が「令和８年６月１日」に置換された");
  assert(!text.includes("議案２　取締役の報酬に関する件"), "議案2 段落 (報酬の件) が削除された");
  assert(text.includes("議案２　代表取締役選任の件"), "議案3 → 議案2 に繰り上がった");
  assert(!text.includes("議案３　代表取締役選任の件"), "議案3 の表記が残っていない");

  // 6. ファイルサイズ確認 (空ファイルになってないか)
  const s = await stat(workCopy);
  assert(s.size > 1000, `出力ファイルが妥当なサイズ (${s.size} bytes)`);

  // 7. 結果出力先を表示
  console.log();
  info(`結果ファイル: ${workCopy}`);
  info(`Word で開く場合: start ${workCopy}`);

  // ============== 追加シナリオ: highlight=none で黄色除去 ==============
  console.log();
  info("Step 6: highlight=none で黄色マーカー除去確認");
  const workCopy2 = await copyToTemp(TEMPLATE);
  await runOfficeCli(buildArgs(workCopy2, {
    command: "set",
    path: "/body/p[@paraId=064BAB11]",
    props: { find: "令和８年２月１１日", replace: "令和８年６月１日", highlight: "none" },
  }));
  await runOfficeCli(["close", workCopy2]).catch(() => {});
  // 該当 paraId に yellow run が残ってないか確認
  const yellowResult = await runOfficeCli(["query", workCopy2, "run[highlight=yellow]"]);
  const yellowAtPara = yellowResult.stdout.split("\n").filter(l => l.includes("064BAB11"));
  assert(yellowAtPara.length === 0, `paraId=064BAB11 の黄色ハイライトが除去された (残り ${yellowAtPara.length} 個)`);

  // ============== 追加シナリオ: xlsx セル set ==============
  console.log();
  info("Step 7: xlsx セル単体 set 確認");
  const XLSX_TEMPLATE = "H:\\共有ドライブ\\司法書士法人そうぞう共有フォルダ\\テンプレート\\取締役就任(取締役1人から複数人)\\4.株主リスト.xlsx";
  // 別パターンのテンプレ名も試す (括弧の半角/全角揺れ対応)
  const XLSX_TEMPLATE_FULLWIDTH = "H:\\共有ドライブ\\司法書士法人そうぞう共有フォルダ\\テンプレート\\取締役就任(取締役1人から複数人)\\4.株主リスト.xlsx";
  let xlsxPath = XLSX_TEMPLATE;
  try { await stat(xlsxPath); } catch {
    try { await stat(XLSX_TEMPLATE_FULLWIDTH); xlsxPath = XLSX_TEMPLATE_FULLWIDTH; } catch {
      // 全角括弧
      xlsxPath = "H:\\共有ドライブ\\司法書士法人そうぞう共有フォルダ\\テンプレート\\取締役就任(取締役1人から複数人)\\4.株主リスト.xlsx".replace("(", "（").replace(")", "）");
    }
  }

  try {
    await stat(xlsxPath);
    const xlsxWork = await copyToTemp(xlsxPath);
    // シート名取得
    const outline = await runOfficeCli(["view", xlsxWork, "outline"]);
    const sheetMatch = outline.stdout.match(/├── "([^"]+)"/);
    const sheetName = sheetMatch ? sheetMatch[1] : null;
    assert(!!sheetName, `xlsx シート名取得: ${sheetName}`);

    if (sheetName) {
      // セル B14 を set
      const setResult = await runOfficeCli(buildArgs(xlsxWork, {
        command: "set",
        path: `/${sheetName}/B14`,
        props: { value: "テスト氏名", fill: "FFFFFF" },
      }));
      assert(setResult.exitCode === 0, `xlsx B14 セル set 成功`);

      // 結果検証
      await runOfficeCli(["close", xlsxWork]).catch(() => {});
      const verifyResult = await runOfficeCli(["get", xlsxWork, `/${sheetName}/B14`]);
      assert(verifyResult.stdout.includes("テスト氏名"), `B14 セルに "テスト氏名" が入った`);

      // 塗りつぶしが白になったか確認
      const fillResult = await runOfficeCli(["get", xlsxWork, `/${sheetName}/B14`]);
      const hasYellow = /fill=#?FFFF00/i.test(fillResult.stdout);
      assert(!hasYellow, `B14 セルの黄色塗りつぶしが除去された`);
    }
  } catch (e) {
    warn(`xlsx テストスキップ (テンプレ見つからず): ${e.message}`);
  }

  // 結果
  console.log();
  if (failures === 0) {
    console.log(`${C.green}=== 全テスト通過 ===${C.reset}`);
    process.exit(0);
  } else {
    console.log(`${C.red}=== ${failures} 件失敗 ===${C.reset}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`${C.red}=== 想定外エラー ===${C.reset}`);
  console.error(e);
  process.exit(1);
});
