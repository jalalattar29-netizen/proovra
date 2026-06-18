import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  Inter_Tight,
  Noto_Sans_Arabic,
  Plus_Jakarta_Sans,
} from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import CookieConsentInit from "./CookieConsentInit";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-jakarta",
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
  title: {
    default: "PROOVRA",
    template: "%s | PROOVRA",
  },
  description: "Digital evidence infrastructure for high-trust operations.",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
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
      className={`${jakarta.variable} ${headerFont.variable} ${notoArabic.variable}`}
    >
      <head>
        {/* Phase 32.5 — mobile viewport. Without this the iOS/Android
            browsers render at desktop-virtual-width and pinch-zoom,
            making touch targets and form inputs unusable. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, viewport-fit=cover"
        />
        <meta name="theme-color" content="#FFFFFF" />
      </head>

<body className="antialiased" style={{ fontFamily: "var(--font-jakarta)" }}>
          <CookieConsentInit />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
