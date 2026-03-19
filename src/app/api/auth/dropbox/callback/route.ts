import { NextRequest, NextResponse } from "next/server";
import { exchangeDropboxCode } from "@/lib/oauth";
import { getTokenStore, saveTokenStore } from "@/lib/tokens";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(new URL("/?error=dropbox_no_code", request.url));
  }

  try {
    const tokenData = await exchangeDropboxCode(code);
    const store = await getTokenStore();
    store.dropbox = tokenData;
    await saveTokenStore(store);
    return NextResponse.redirect(new URL("/?connected=dropbox", request.url));
  } catch {
    return NextResponse.redirect(new URL("/?error=dropbox_auth_failed", request.url));
  }
}
