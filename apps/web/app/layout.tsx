import type { ReactNode } from "react";
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
 * ✅ CSS Tokens ثابتة (بدون @proovra/ui) لتختفي أخطاء الألوان نهائياً
 * إذا بدك نرجع لاحقاً نربطها بـ @proovra/ui بنعملها بس بعد ما يستقر كل شي.
 */
const tokenCss = `
:root {
  --color-primary: #0b1f53;
  --color-bg: #f7f9fc;
  --color-text: #0f172a;

  --color-teal: #1ecad3;
  --color-blue: #3b82f6;
  --color-green: #2bb673;
  --color-red: #ef4444;
  --color-white: #ffffff;

  --color-border: #e6ecf4;
  --color-shadow: rgba(15, 23, 42, 0.10);

  --radius-sm: 10px;
  --radius-md: 16px;
  --radius-lg: 22px;
  --radius-pill: 999px;

  --space-xs: 6px;
  --space-sm: 10px;
  --space-md: 14px;
  --space-lg: 18px;
  --space-xl: 24px;
  --space-xxl: 48px;

  --text-hero: 46px;
  --text-h1: 34px;
  --text-h2: 26px;
  --text-h3: 20px;
  --text-body: 14px;
  --text-body-lg: 16px;
  --text-label: 12px;

  --lh-hero: 1.1;
  --lh-h1: 1.2;
  --lh-h2: 1.25;
  --lh-h3: 1.25;
  --lh-body: 1.55;
  --lh-body-lg: 1.55;
  --lh-label: 1.35;
}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      dir="ltr"
      className={`${inter.variable} ${headerFont.variable} ${notoArabic.variable}`}
    >
      <head>
        <style>{tokenCss}</style>

        {/* ✅ أيقونات التطبيق والمتصفح */}
        <link rel="icon" href="/brand/favicon.ico" />
        <link rel="apple-touch-icon" href="/brand/icon-192.png" />
        <link rel="manifest" href="/manifest.webmanifest" />

        {/* ✅ Theme color (يعطي شكل احترافي بالموبايل) */}
        <meta name="theme-color" content="#0f1d36" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
