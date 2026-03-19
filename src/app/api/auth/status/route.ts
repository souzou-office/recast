import { NextResponse } from "next/server";
import { getTokenStore } from "@/lib/tokens";

export async function GET() {
  const store = await getTokenStore();
  return NextResponse.json({
    google: !!store.google,
    dropbox: !!store.dropbox,
  });
}

// 接続解除
export async function DELETE(request: Request) {
  const { provider } = await request.json();
  const { getTokenStore: getStore, saveTokenStore: saveStore } = await import("@/lib/tokens");
  const store = await getStore();

  if (provider === "google") delete store.google;
  if (provider === "dropbox") delete store.dropbox;

  await saveStore(store);
  return NextResponse.json({ google: !!store.google, dropbox: !!store.dropbox });
}
