# Proovra Release Checklist

## Pre-release
- [ ] `pnpm -r lint` passes
- [ ] `pnpm -r typecheck` passes
- [ ] `pnpm -r test` passes
- [ ] `pnpm --filter proovra-api build` passes
- [ ] `pnpm --filter proovra-worker build` passes
- [ ] `pnpm --filter proovra-web build` passes

## Database
- [ ] `prisma migrate deploy` applied
- [ ] Signing key seeded

## Worker
- [ ] Worker health endpoint OK
- [ ] Report generation confirmed

## Verify
- [ ] `/v1/evidence` -> upload -> complete -> report -> verify
- [ ] Signed report URL downloads successfully

## Billing
- [ ] Stripe live webhook received
- [ ] PayPal live webhook received
- [ ] Pro/Team entitlement updates

## Security
- [ ] `S3_PUBLIC_BASE_URL` unset in production
- [ ] TLS enforced for `S3_ENDPOINT`
- [ ] CORS allowlist set to production domains

## Domain routing (see DEPLOYMENT.md)
- [ ] `app.proovra.com` → app shell; `/` redirects to `/home`
- [ ] `www.proovra.com` → marketing; app routes redirect to app.proovra.com
- [ ] `NEXT_PUBLIC_APP_BASE` and `NEXT_PUBLIC_WEB_BASE` set correctly
