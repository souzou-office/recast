import { NextResponse } from "next/server";
import { getDropboxAuthUrl } from "@/lib/oauth";

export async function GET() {
  return NextResponse.redirect(getDropboxAuthUrl());
}
