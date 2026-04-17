import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceConfig, saveWorkspaceConfig } from "@/lib/folders";

const client = new Anthropic();

// このエンドポイントは廃止済み。会社レベルの masterSheet 保存は別案件のデータ汚染を引き起こすため削除。
// 案件整理データはチャットスレッドの messages として保存される（ChatWorkflow経由）。
export async function POST() {
  return NextResponse.json({ error: "このエンドポイントは廃止されました。案件整理データはチャットスレッドに保存されます。" }, { status: 410 });
}
