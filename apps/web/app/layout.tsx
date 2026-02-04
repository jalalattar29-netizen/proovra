import type { ReactNode } from "react";
import { Inter, Noto_Sans_Arabic } from "next/font/google";
import { colors, radius, spacing, typography } from "@proovra/ui";
import "./globals.css";
import { Providers } from "./providers";

export const metadata = {
  title: "Proovra",
  description: "Capture truth. Prove it forever."
};

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap"
});

const notoArabic = Noto_Sans_Arabic({
  subsets: ["arabic"],
  variable: "--font-arabic",
  display: "swap"
});

const tokenCss = `
:root {
  --color-primary: ${colors.primaryNavy};
  --color-bg: ${colors.lightBg};
  --color-text: ${colors.textDark};
  --color-teal: ${colors.teal};
  --color-blue: ${colors.blueAccent};
  --color-green: ${colors.greenValid};
  --color-red: ${colors.redError};
  --color-white: ${colors.white};
  --color-border: ${colors.border};
  --color-shadow: ${colors.shadow};
  --radius-sm: ${radius.sm}px;
  --radius-md: ${radius.md}px;
  --radius-lg: ${radius.lg}px;
  --radius-pill: ${radius.pill}px;
  --space-xs: ${spacing.xs}px;
  --space-sm: ${spacing.sm}px;
  --space-md: ${spacing.md}px;
  --space-lg: ${spacing.lg}px;
  --space-xl: ${spacing.xl}px;
  --space-xxl: ${spacing.xxl}px;
  --text-hero: ${typography.size.hero}px;
  --text-h1: ${typography.size.h1}px;
  --text-h2: ${typography.size.h2}px;
  --text-h3: ${typography.size.h3}px;
  --text-body: ${typography.size.body}px;
  --text-body-lg: ${typography.size.bodyLg}px;
  --text-label: ${typography.size.label}px;
  --lh-hero: ${typography.lineHeight.hero}px;
  --lh-h1: ${typography.lineHeight.h1}px;
  --lh-h2: ${typography.lineHeight.h2}px;
  --lh-h3: ${typography.lineHeight.h3}px;
  --lh-body: ${typography.lineHeight.body}px;
  --lh-body-lg: ${typography.lineHeight.bodyLg}px;
  --lh-label: ${typography.lineHeight.label}px;
}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr" className={`${inter.variable} ${notoArabic.variable}`}>
      <head>
        <style>{tokenCss}</style>
        <link rel="icon" href="/brand/favicon.ico" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
