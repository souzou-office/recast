import { NextRequest, NextResponse } from "next/server";
import { listFoldersGoogle } from "@/lib/files-google";
import { listFoldersDropbox } from "@/lib/files-dropbox";

// ベースフォルダの子フォルダ一覧を取得
export async function POST(request: NextRequest) {
  const { folderId, provider } = await request.json();

  if (!folderId || !provider) {
    return NextResponse.json({ error: "folderId, provider は必須です" }, { status: 400 });
  }

  try {
    let folders: { name: string; id: string }[] = [];
    let files: { name: string; mimeType: string }[] = [];

    if (provider === "google") {
      const result = await listFoldersGoogle(folderId);
      folders = result.dirs.map(d => ({ name: d.name, id: d.path }));
      files = result.files || [];
    } else if (provider === "dropbox") {
      const result = await listFoldersDropbox(folderId);
      folders = result.dirs.map(d => ({ name: d.name, id: d.path }));
    }

    return NextResponse.json({ folders, files });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "スキャンに失敗しました" },
      { status: 500 }
    );
  }
}
