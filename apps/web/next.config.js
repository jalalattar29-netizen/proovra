/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.NEXT_STANDALONE === "false" ? undefined : "standalone",
  transpilePackages: ["@proovra/shared", "@proovra/ui"],

  // ✅ لا نضع CSP هنا لأن middleware.ts هو المصدر الوحيد للهيدرز الأمنية
  // (حتى ما يصير تضارب/تكرار ويطلع unsafe-eval بالغلط)
};

export default nextConfig;