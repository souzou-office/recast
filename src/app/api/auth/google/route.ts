import { NextResponse } from "next/server";
import { getGoogleAuthUrl } from "@/lib/oauth";

export async function GET() {
  return NextResponse.redirect(getGoogleAuthUrl());
}
