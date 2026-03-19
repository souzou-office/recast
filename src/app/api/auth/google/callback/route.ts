import { NextRequest, NextResponse } from "next/server";
import { exchangeGoogleCode } from "@/lib/oauth";
import { getTokenStore, saveTokenStore } from "@/lib/tokens";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(new URL("/?error=google_no_code", request.url));
  }

  try {
    const tokenData = await exchangeGoogleCode(code);
    const store = await getTokenStore();
    store.google = tokenData;
    await saveTokenStore(store);
    return NextResponse.redirect(new URL("/?connected=google", request.url));
  } catch {
    return NextResponse.redirect(new URL("/?error=google_auth_failed", request.url));
  }
}
