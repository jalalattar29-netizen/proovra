/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.NEXT_STANDALONE === "false" ? undefined : "standalone",
  transpilePackages: ["@proovra/shared", "@proovra/ui"],
  async headers() {
    const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "https://api.proovra.com";
    const csp = [
      "default-src 'self'",
      "script-src 'self' https://accounts.google.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self' " + apiBase,
      "frame-src https://accounts.google.com https://appleid.apple.com",
      "base-uri 'self'",
      "form-action 'self' https://appleid.apple.com"
    ].join("; ");
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "geolocation=(self)" },
          { key: "Content-Security-Policy", value: csp }
        ]
      }
    ];
  }
};

export default nextConfig;
