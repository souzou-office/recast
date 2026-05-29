#!/usr/bin/env node
// scripts/extract-thread-docs.mjs
// thread.json から generatedDocuments の docxBase64 を取り出して個別ファイルに書き出す。
// 使い方: node scripts/extract-thread-docs.mjs <thread.json> [出力先ディレクトリ]

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const threadFile = process.argv[2];
const outDir = process.argv[3] || "K:/recast/dev.thread-docs";

if (!threadFile) {
  console.error("Usage: node scripts/extract-thread-docs.mjs <thread.json> [outDir]");
  process.exit(1);
}

const raw = await readFile(threadFile, "utf-8");
const thread = JSON.parse(raw);

if (!thread.generatedDocuments || thread.generatedDocuments.length === 0) {
  console.error("No generatedDocuments in thread");
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

for (const doc of thread.generatedDocuments) {
  const buf = Buffer.from(doc.docxBase64, "base64");
  const outPath = path.join(outDir, doc.fileName);
  await writeFile(outPath, buf);
  console.log(`✓ ${outPath} (${buf.length} bytes)`);
}

console.log(`\nDone. ${thread.generatedDocuments.length} files written to ${outDir}`);
