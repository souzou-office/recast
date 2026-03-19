import fs from "fs/promises";
import path from "path";

const TOKEN_PATH = path.join(process.cwd(), "data", "tokens.json");

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix ms
}

export interface TokenStore {
  google?: TokenData;
  dropbox?: TokenData;
}

export async function getTokenStore(): Promise<TokenStore> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveTokenStore(store: TokenStore): Promise<void> {
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export async function getValidGoogleToken(): Promise<string | null> {
  const store = await getTokenStore();
  if (!store.google) return null;

  // 5分の余裕を持って更新
  if (store.google.expires_at < Date.now() + 5 * 60 * 1000) {
    const refreshed = await refreshGoogleToken(store.google.refresh_token);
    if (!refreshed) return null;
    store.google = { ...store.google, ...refreshed };
    await saveTokenStore(store);
  }

  return store.google.access_token;
}

export async function getValidDropboxToken(): Promise<string | null> {
  const store = await getTokenStore();
  if (!store.dropbox) return null;

  if (store.dropbox.expires_at < Date.now() + 5 * 60 * 1000) {
    const refreshed = await refreshDropboxToken(store.dropbox.refresh_token);
    if (!refreshed) return null;
    store.dropbox = { ...store.dropbox, ...refreshed };
    await saveTokenStore(store);
  }

  return store.dropbox.access_token;
}

async function refreshGoogleToken(
  refreshToken: string
): Promise<{ access_token: string; expires_at: number } | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      access_token: data.access_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
  } catch {
    return null;
  }
}

async function refreshDropboxToken(
  refreshToken: string
): Promise<{ access_token: string; expires_at: number } | null> {
  try {
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: process.env.DROPBOX_APP_KEY!,
        client_secret: process.env.DROPBOX_APP_SECRET!,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      access_token: data.access_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
  } catch {
    return null;
  }
}
