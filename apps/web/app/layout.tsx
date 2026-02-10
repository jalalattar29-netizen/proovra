import type { ReactNode } from "react";
import { headers } from "next/headers";
import { Inter, Montserrat, Noto_Sans_Arabic } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

export const metadata = {
  title: "PROO✓RA",
  description: "Capture truth. Prove it forever."
};

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap"
});

const headerFont = Montserrat({
  subsets: ["latin"],
  variable: "--font-header",
  display: "swap"
});

const notoArabic = Noto_Sans_Arabic({
  subsets: ["arabic"],
  variable: "--font-arabic",
  display: "swap"
});

/**
 * ✅ IMPORTANT:
 * globals.css is the source of truth for theme tokens (navy, bg, buttons...).
 * We only define extra semantic tokens here if needed, WITHOUT overriding
 * --color-primary / --color-bg / --color-text etc. to avoid conflicts.
 */
const extraTokenCss = `
:root {
  /* Optional semantic accents (safe) */
  --color-teal: #1ecad3;
  --color-blue: #1f4fbf;
  --color-green: #2f8f6b;
  --color-red: #ef4444;

  /* Keep theme-color consistent with lighter navy from globals */
  --theme-color: var(--navy-900);
}
`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="en"
      dir="ltr"
      className={`${inter.variable} ${headerFont.variable} ${notoArabic.variable}`}
    >
      <head>
        {/* ✅ Extra tokens only (no overriding globals theme tokens) */}
        <style nonce={nonce}>{extraTokenCss}</style>

        {/* ✅ Icons */}
        <link rel="icon" href="/brand/favicon.ico" />
        <link rel="apple-touch-icon" href="/brand/icon-192.png" />
        <link rel="manifest" href="/manifest.webmanifest" />

        {/* ✅ Theme color */}
        <meta name="theme-color" content="#0b1a33" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
