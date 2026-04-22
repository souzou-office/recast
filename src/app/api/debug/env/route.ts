import { NextResponse } from "next/server";

// キー本体は返さず、存在の有無と先頭6文字だけ返す
export async function GET() {
  const key = process.env.ANTHROPIC_API_KEY;
  return NextResponse.json({
    hasAnthropicKey: !!key,
    keyPrefix: key ? key.slice(0, 10) + "..." : null,
    keyLength: key ? key.length : 0,
    cwd: process.cwd(),
    nodeEnv: process.env.NODE_ENV,
    nextPublicAppUrl: process.env.NEXT_PUBLIC_APP_URL || null,
  });
}
