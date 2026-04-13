import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, Inter_Tight, Noto_Sans_Arabic } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import CookieConsentInit from "./CookieConsentInit";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const headerFont = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-header",
  display: "swap",
});

const notoArabic = Noto_Sans_Arabic({
  subsets: ["arabic"],
  variable: "--font-arabic",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PROOVRA — Verifiable Digital Evidence",
  description:
    "Turn files into verifiable digital evidence with signed integrity records, trusted timestamps, and a review-ready verification workflow.",
  icons: {
    icon: [{ url: "/brand/favicon.png" }],
    apple: "/brand/apple-touch-icon.png",
  },
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html
      lang="en"
      dir="ltr"
      className={`${inter.variable} ${headerFont.variable} ${notoArabic.variable}`}
    >
      <head>
        <meta name="theme-color" content="#13252a" />
      </head>

      <body className="font-sans antialiased">
        <CookieConsentInit />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}