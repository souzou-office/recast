// このルートは廃止されました。/api/workspace を使用してください。
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.redirect(new URL("/api/workspace"));
}
