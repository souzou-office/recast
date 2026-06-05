// クライアント側プレビューキャッシュ + プリフェッチユーティリティ。
//
// サーバの /api/workspace/preview-html 自体もキャッシュを持つが、
// クライアント側にもキャッシュを持っておくと:
//   - サーバへの fetch すら省ける (タブ切替でフリッカーなし)
//   - 自動展開時に裏で prefetch しておけば、ユーザークリック時に瞬時表示
//
// LRU 等の凝った仕組みは持たない: FIFO で上限到達したら最古を捨てるだけ。

const MAX_CACHE = 30;
const cache = new Map<string, string>();
// レンダリング設定変更時にここを bump → 古い PNG を invalidate
// (サーバ側の RENDER_VERSION と同じ値を入れること)
const RENDER_VERSION = "v7-docx-html-always";

export function getCacheKey(args: { filePath?: string; docxBase64?: string }): string | null {
  if (args.filePath) return `f:${RENDER_VERSION}:${args.filePath}`;
  if (args.docxBase64) return `b:${RENDER_VERSION}:${args.docxBase64.length}:${args.docxBase64.slice(0, 64)}`;
  return null;
}

export function getCached(key: string): string | undefined {
  return cache.get(key);
}

export function setCached(key: string, html: string): void {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, html);
}

// 裏で preview-html を fetch して結果をキャッシュに格納。
// 既にキャッシュにあれば何もしない。エラーは握り潰す (本表示時に再度試される)。
export async function prefetch(args: {
  filePath?: string;
  docxBase64?: string;
  fileName?: string;
}): Promise<void> {
  const key = getCacheKey(args);
  if (!key || cache.has(key)) return;
  try {
    const res = await fetch("/api/workspace/preview-html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: args.filePath,
        docxBase64: args.docxBase64,
        fileName: args.fileName,
      }),
    });
    const data = await res.json();
    if (data?.html) setCached(key, data.html);
  } catch {
    /* ignore */
  }
}
