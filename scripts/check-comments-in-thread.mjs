// 最新 thread の generatedDocuments を取り出して、各 docx にコメントが入ってるか officecli query で確認。
import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

function findLatestThread() {
  const root = "data/chat-threads";
  const dirs = readdirSync(root).map(d => join(root, d));
  let latest = null;
  for (const dir of dirs) {
    try {
      const entries = readdirSync(dir).filter(f => f.startsWith("thread_") && f.endsWith(".json"));
      for (const e of entries) {
        const p = join(dir, e);
        const st = statSync(p);
        if (!latest || st.mtimeMs > latest.mtime) latest = { path: p, mtime: st.mtimeMs };
      }
    } catch { /* ignore */ }
  }
  return latest;
}

const latest = findLatestThread();
if (!latest) { console.error("no thread"); process.exit(1); }
console.log("thread:", latest.path);

const t = JSON.parse(readFileSync(latest.path, "utf-8"));
const docs = t.generatedDocuments || [];
console.log(`generatedDocuments count: ${docs.length}`);
console.log("");

for (const d of docs) {
  const fn = d.fileName || "?";
  const b64 = d.docxBase64 || "";
  if (!b64 || /\.xlsx?$/i.test(fn)) continue;
  const tmp = join(tmpdir(), `check_${Date.now()}_${Math.random().toString(36).slice(2,8)}.docx`);
  writeFileSync(tmp, Buffer.from(b64, "base64"));
  let n = "?";
  try {
    const out = execFileSync("officecli", ["query", tmp, "comment", "--json"], { encoding: "utf-8" });
    const data = JSON.parse(out);
    n = data?.data?.matches ?? 0;
  } catch (e) {
    n = `err: ${e.message?.slice(0, 50)}`;
  }
  try { unlinkSync(tmp); } catch {}
  console.log(`  ${String(n).padStart(3)} comments — ${fn}`);
}
