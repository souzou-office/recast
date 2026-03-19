import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "recast - バックオフィス支援AI",
  description: "起きた事実を、相手の要求仕様に合う型に流し込み直す",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="h-screen overflow-hidden antialiased">{children}</body>
    </html>
  );
}
