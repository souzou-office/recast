// Anthropic API の response.content (block 配列) から text を抽出するヘルパー。
//
// 旧コードは `response.content[0].type === "text" ? response.content[0].text : ""` という
// 雑なパターンで書かれていて、Claude API が複数 block (thinking / tool_use / 複数 text) を
// 返したときに、最初が text 型でないと全文を取りこぼす致命的バグがあった。
//
// このヘルパーを使うと「全 text block を結合して 1 つの文字列にする」を 1 行で書ける。

import type Anthropic from "@anthropic-ai/sdk";

export function textFromContent(content: Anthropic.ContentBlock[]): string {
  return content
    .filter(b => b.type === "text")
    .map(b => b.type === "text" ? b.text : "")
    .join("");
}
