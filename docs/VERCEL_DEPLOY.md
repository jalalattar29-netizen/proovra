# Vercel Deploy (apps/web)

1) Create a new Vercel project from `apps/web`.
2) Set environment variables:
   - `NEXT_PUBLIC_API_BASE=https://api.proovra.com`
   - `NEXT_PUBLIC_WEB_BASE=https://www.proovra.com`
   - `NEXT_PUBLIC_APP_BASE=https://app.proovra.com`
3) Add domains in Vercel:
   - `www.proovra.com`
   - `app.proovra.com`
4) In Cloudflare DNS, point both domains to Vercel as instructed in the Vercel domain UI.
5) Ensure HTTPS is active on both domains.

Notes:
- The Next.js middleware routes users between www and app based on host.
- `/verify/*` remains public on www.
