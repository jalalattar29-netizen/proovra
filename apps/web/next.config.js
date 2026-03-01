/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.NEXT_STANDALONE === "false" ? undefined : "standalone",
  transpilePackages: ["@proovra/shared", "@proovra/ui"],

  async headers() {
    // ✅ عدّل هالدومينات حسب بيئتك
    const R2_HOST = "https://*.r2.cloudflarestorage.com";
    const API_HOST = process.env.NEXT_PUBLIC_API_BASE
      ? process.env.NEXT_PUBLIC_API_BASE.replace(/\/$/, "")
      : "https://api.proovra.com";

    // CSP عملية ومرنة (تخليك تشتغل بدون ما تكسر auth)
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",

      // scripts/styles (إذا عندك Stripe/Google login قد تحتاج توسعة لاحقاً)
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",

      // الصور والفيديو (blob/data للـ previews بالكاميرا)
      `img-src 'self' data: blob: https: ${R2_HOST}`,
      `media-src 'self' blob: https: ${R2_HOST}`,
      "font-src 'self' data: https:",

      // ✅ المهم: السماح لاتصالات fetch/XHR للـ API و R2
      `connect-src 'self' https: http: wss: ws: ${API_HOST} ${R2_HOST}`,

      // لو عندك OAuth popup/iframe
      "frame-src 'self' https:",
    ]
      .join("; ")
      .trim();

    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: csp,
          },
        ],
      },
    ];
  },
};

export default nextConfig;