import type { Metadata } from "next";
import { Noto_Sans_JP, Noto_Serif_JP, Fraunces } from "next/font/google";
import "./globals.css";

const notoSans = Noto_Sans_JP({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-sans-jp",
  display: "swap",
});

const notoSerif = Noto_Serif_JP({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-noto-serif-jp",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["500", "600"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});

export const metadata: Metadata = {
  title: "recast - バックオフィス支援AI",
  description: "起きた事実を、相手の要求仕様に合う型に流し込み直す",
  icons: { icon: "/favicon.png" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" className={`${notoSans.variable} ${notoSerif.variable} ${fraunces.variable}`}>
      <body className="h-screen overflow-hidden antialiased bg-[var(--color-bg)] text-[var(--color-fg)]">{children}</body>
    </html>
  );
}
