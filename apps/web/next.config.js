/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.NEXT_STANDALONE === "false" ? undefined : "standalone",
  transpilePackages: ["@proovra/shared", "@proovra/ui"],

  // ✅ لا نضع CSP هنا لأن middleware.ts هو المصدر الوحيد للهيدرز الأمنية
  // (حتى ما يصير تضارب/تكرار ويطلع unsafe-eval بالغلط)

  // CR1 Part 2 — canonical Phase-32.8B backward-compat redirects.
  // Previously each route had its own JSX page that called
  // `next/navigation`.redirect(). The pages were single-purpose, 14-line
  // files. Moving them here makes routing the source of truth and keeps
  // app/(app)/ clean. End-user behavior is identical (308 permanent
  // redirect to the same destination, queries preserved as-is).
  async redirects() {
    return [
      { source: "/dashboard", destination: "/home", permanent: true },
      {
        source: "/archive",
        destination: "/evidence?filter=archived",
        permanent: true,
      },
      {
        source: "/deleted",
        destination: "/evidence?filter=deleted",
        permanent: true,
      },
      {
        source: "/locked",
        destination: "/evidence?filter=locked",
        permanent: true,
      },
      { source: "/operations", destination: "/ops", permanent: true },
      { source: "/review", destination: "/reviewer-ops", permanent: true },
      {
        source: "/reviewer-ops/policy",
        destination: "/governance/policy",
        permanent: true,
      },
      {
        source: "/security",
        destination: "/security-center",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
