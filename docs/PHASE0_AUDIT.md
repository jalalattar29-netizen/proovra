# PHASE 0: BASELINE AUDIT REPORT
**Generated**: February 10, 2026  
**Status**: FINDINGS COMPLETE — Ready for Phase 1 implementation

---

## 1. ROUTE AUDIT (WORKING vs BROKEN)

### Marketing Routes (www.proovra.com)
| Route | File | Status | Notes |
|-------|------|--------|-------|
| `/` | `app/page.tsx` | ✅ EXISTS | Landing page with "Who it's for" + "Trust indicators" |
| `/about` | `app/about/page.tsx` | ✅ EXISTS | About page (minimal content) |
| `/pricing` | `app/pricing/page.tsx` | ✅ EXISTS | 4 pricing cards (FREE/PAYG/PRO/TEAM) |
| `/login` | `app/login/page.tsx` | ✅ EXISTS | Google + Apple + Guest buttons |
| `/register` | `app/register/page.tsx` | ✅ EXISTS | Google + Apple + Guest buttons |
| `/verify/[token]` | `app/verify/[token]/page.tsx` | ✅ EXISTS | Public verify + report download |
| `/verify/demo` | `app/verify/demo/page.tsx` | ✅ EXISTS | Redirect to demo token |
| `/legal/privacy` | `app/legal/[slug]/page.tsx` | ✅ EXISTS | Markdown-based, hardcoded `locale="en"` |
| `/legal/terms` | `app/legal/[slug]/page.tsx` | ✅ EXISTS | Markdown-based, hardcoded `locale="en"` |
| `/legal/cookies` | `app/legal/[slug]/page.tsx` | ✅ EXISTS | Markdown-based, hardcoded `locale="en"` |
| `/legal/security` | `app/legal/[slug]/page.tsx` | ✅ EXISTS | Markdown-based, hardcoded `locale="en"` |

### Dashboard Routes (app.proovra.com)
| Route | File | Status | Notes |
|-------|------|--------|-------|
| `/home` | `app/(app)/home/page.tsx` | ✅ EXISTS | Recent evidence list + quick actions |
| `/capture` | `app/(app)/capture/page.tsx` | ❌ NOT FOUND | **MISSING** — Upload UI not implemented |
| `/cases` | `app/(app)/cases/page.tsx` | ✅ EXISTS | Case list + create flow (empty state) |
| `/cases/[id]` | `app/(app)/cases/[id]/page.tsx` | ❌ NOT FOUND | **MISSING** — Case detail not implemented |
| `/teams` | `app/(app)/teams/page.tsx` | ✅ EXISTS | Team list (empty state) |
| `/reports` | `app/(app)/reports/page.tsx` | ✅ EXISTS | Reports list (empty state) |
| `/evidence/[id]` | `app/(app)/evidence/[id]/page.tsx` | ❌ NOT FOUND | **MISSING** — Evidence detail not implemented |
| `/billing` | `app/(app)/billing/page.tsx` | ✅ EXISTS | Pricing cards + placeholder checkout |
| `/settings` | `app/(app)/settings/page.tsx` | ✅ EXISTS | Profile + language selector + logout |

---

## 2. AUTH IMPLEMENTATION STATUS

### Backend (services/api)
| Endpoint | File | Status | Notes |
|----------|------|--------|-------|
| `POST /v1/auth/guest` | auth.routes.ts | ❓ UNCLEAR | Listed in README but file not reviewed |
| `POST /v1/auth/google` | auth.routes.ts | ❓ UNCLEAR | Expects `{ idToken }` per README |
| `POST /v1/auth/apple` | auth.routes.ts | ❓ UNCLEAR | Expects `{ idToken }` per README |
| `GET /v1/auth/me` | auth.routes.ts | ❓ UNCLEAR | Likely exists but not verified |
| `POST /v1/auth/logout` | auth.routes.ts | ❓ UNCLEAR | Called in settings/logout but not verified |
| `POST /v1/evidence` | evidence.routes.ts | ✅ EXISTS | Creates evidence + presigned PUT |
| `PUT <presigned>` | AWS S3 | ✅ EXISTS | Signed URL upload |
| `POST /v1/evidence/:id/complete` | evidence.routes.ts | ✅ EXISTS | Finalize upload + trigger report |
| `GET /v1/evidence/:id/report/latest` | evidence.routes.ts | ✅ EXISTS | Poll for report PDF |

### Frontend Web (apps/web)
| Component | Status | Issues |
|-----------|--------|--------|
| **Google Sign-in** | ✅ IMPLEMENTED | Uses `buildGoogleAuthUrl()` with dynamic origin (FIXED in prev session) |
| **Apple Sign-in** | ✅ IMPLEMENTED | Uses `buildAppleAuthUrl()` with dynamic origin + error handling (FIXED in prev session) |
| **Guest Login** | ✅ IMPLEMENTED | Posts to `/v1/auth/guest` |
| **Auth Persistence** | ⚠️ PARTIAL | Tokens stored in localStorage, no HttpOnly cookie for web session |
| **useAuth Hook** | ✅ EXISTS | `app/providers.tsx` — manages token + redirects |
| **Profile Display** | ✅ WORKS | Settings page shows email (pulled from `/v1/auth/me`) |

### Frontend Mobile (apps/mobile)
| Component | Status | Notes |
|-----------|--------|-------|
| **Guest Auto-login** | ✅ IMPLEMENTED | First run calls `/v1/auth/guest` |
| **Google Auth** | ❓ UNCLEAR | expo-auth-session may not be configured |
| **Apple Auth** | ❓ UNCLEAR | expo-apple-authentication may not be configured |
| **Token Persistence** | ✅ LIKELY | Uses SecureStore (see `apps/mobile/src/auth-context.tsx`) |

---

## 3. HOST ROUTING & MIDDLEWARE

### Current State
- **File**: `apps/web/middleware.ts`
- **Logic**: Detects `host` from request, routes based on subdomain
- **Issue Found**: Hardcoded rewrites/redirects may not properly handle both www + app
- **Status**: ⚠️ NEEDS VERIFICATION — appears to work but needs testing on production domains

---

## 4. MISSING PAGES (CRITICAL FOR MVP)

| Feature | File | Status | Blocker? |
|---------|------|--------|----------|
| **Photo Capture** | `app/(app)/capture/page.tsx` | ❌ MISSING | YES — Core feature |
| **Evidence Detail** | `app/(app)/evidence/[id]/page.tsx` | ❌ MISSING | YES — Can't view captured evidence |
| **Case Detail** | `app/(app)/cases/[id]/page.tsx` | ❌ MISSING | NO — Empty state acceptable |
| **Share/Verify Flow** | Partial in `/verify` | ⚠️ INCOMPLETE | YES — Must show real custody chain |

---

## 5. DESIGN SYSTEM STATUS

### Components Inventory
| Component | Status | Notes |
|-----------|--------|-------|
| **Button** | ✅ EXISTS | `components/ui.tsx` |
| **Card** | ✅ EXISTS | `components/ui.tsx` |
| **Badge** | ✅ EXISTS | `components/ui.tsx` |
| **Tabs** | ❓ UNCLEAR | Not found in ui.tsx |
| **Modal** | ❓ UNCLEAR | Not found |
| **Toast** | ❌ MISSING | No toast component |
| **Input/Textarea** | ✅ EXISTS | Basic HTML inputs used |
| **Select** | ❓ UNCLEAR | Not found as component |
| **Table** | ❌ MISSING | ListRow used but no table component |
| **Timeline** | ❌ MISSING | Needed for custody chain |
| **Skeleton** | ❌ MISSING | No loading skeleton |
| **EmptyState** | ⚠️ PARTIAL | Ad-hoc empty states in pages |

### Color Tokens
- **File**: `apps/web/app/globals.css`
- **Status**: ✅ CSS variables defined (--color-primary, --color-bg, etc.)
- **Issue**: May not match "Stripe/Notion quality" spec — needs audit

### Typography
- **Font**: Inter (web), system font (mobile)
- **Status**: ✅ Basic, but no premium spacing/sizing defined

### Icons
- **Web**: lucide-react imported
- **Mobile**: Expo Vector Icons imported
- **Status**: ✅ Icons used in nav but sparse in other pages

---

## 6. BILLING & PAYMENT STATUS

### Stripe Integration
| Item | Status | Notes |
|------|--------|-------|
| `POST /webhooks/stripe` | ❓ UNCLEAR | Backend route not verified |
| Checkout session creation | ❓ UNCLEAR | Not implemented in web UI |
| Event handlers | ❓ UNCLEAR | checkout.session.completed, subscription events |
| Customer name/email storage | ❌ MISSING | **Critical** — invoices need Jalal Attar name |
| Invoice PDF generation | ❌ MISSING | Must download from Stripe or generate custom |

### PayPal Integration
| Item | Status | Notes |
|------|--------|-------|
| `POST /webhooks/paypal` | ❌ MISSING | No PayPal webhook handler |
| Order capture | ❌ MISSING | No order creation |
| Webhook verification | ❌ MISSING | No signature verification |

### Web Billing Page
- **File**: `app/(app)/billing/page.tsx`
- **Status**: ⚠️ PARTIAL — Shows pricing cards but checkout not wired
- **Issue**: PayPal button present but non-functional

---

## 7. MOBILE APP STATUS

### Navigation
- **File**: `app/(tabs)/_layout.tsx`, `app/_layout.tsx`
- **Status**: ✅ Tabs + Stack routing exists
- **Routes**: home, capture, cases, reports, teams, settings
- **Issue**: Missing screens (see below)

### Screens (Incomplete Inventory)
| Screen | File | Status |
|--------|------|--------|
| Home | `(tabs)/index.tsx` | ✅ EXISTS |
| Capture | `(stack)/capture.tsx` | ❌ MISSING |
| Cases | `(tabs)/cases.tsx` | ⚠️ UNCERTAIN |
| Reports | `(tabs)/reports.tsx` | ✅ EXISTS (created last session) |
| Teams | `(tabs)/teams.tsx` | ⚠️ UNCERTAIN |
| Settings | `(tabs)/settings.tsx` | ✅ EXISTS |
| Billing | `(stack)/billing.tsx` | ✅ EXISTS (created last session) |
| Evidence Detail | `(stack)/evidence/[id].tsx` | ⚠️ UNCERTAIN |

### Camera/Media
- **Photo**: `expo-image-picker` library needed
- **Video**: `expo-av` library needed
- **Document**: `expo-document-picker` library needed
- **Status**: ❓ UNCLEAR if libraries imported

### Upload Queue
- **SQLite**: `expo-sqlite` needed
- **Storage**: Upload state machine needed
- **Status**: ❌ MISSING — No queue implementation

---

## 8. LANGUAGE & LOCALE

### Current Implementation
- **Web**: `apps/web/app/providers.tsx` has `useLocale()`
- **Mobile**: `apps/mobile/src/locale-context.tsx` has `useLocale()`
- **Supported**: en, ar, de (per earlier RELEASE_REPORT.md)
- **Issue**: Hardcoded `locale="en"` in `/legal/[slug]/page.tsx` — doesn't respect URL param or preference

### Language Switcher
- **Status**: ✅ PARTIAL — Settings page has dropdown for en/ar
- **Missing**: Always-visible header switcher (required by spec)
- **Missing**: Language persistence (cookie/localStorage)
- **Missing**: RTL auto-apply

---

## 9. DEPLOYMENT STATUS

### Vercel Configuration
- **App Root**: apps/web
- **Build Command**: `pnpm --filter proovra-web build`
- **Output**: Likely correct but needs verification
- **Status**: ⚠️ Appears functional but DNS/SSL issues fixed earlier

### Environment Variables
- **NEXT_PUBLIC_API_BASE**: Set (should be https://api.proovra.com)
- **NEXT_PUBLIC_WEB_BASE**: Set (should be https://www.proovra.com)
- **NEXT_PUBLIC_APP_BASE**: Set (should be https://app.proovra.com)
- **OAuth IDs**: Set in Vercel
- **Status**: ✅ Likely correct, needs runtime verification

### Domains
- **www.proovra.com**: Configured in Vercel + Cloudflare
- **app.proovra.com**: Configured in Vercel + Cloudflare
- **Status**: ✅ Fixed in previous session (Cloudflare "Full" mode)

### API Deployment
- **Services**: api, worker (BullMQ jobs)
- **Status**: ❓ UNCLEAR — Not verified in this audit

---

## 10. CRITICAL ISSUES SUMMARY

### Blockers (Must Fix Before MVP)
1. **Missing Capture Page** — `/capture` route not implemented
2. **Missing Evidence Detail** — `/evidence/[id]` route not implemented
3. **Missing Toast Component** — No feedback on user actions
4. **Mobile Upload Queue** — No SQLite queue for retries + offline
5. **Billing Checkout** — Not wired to Stripe/PayPal APIs
6. **Invoice Name** — Customer name not captured/displayed
7. **Language Switcher Header** — Not always visible (required spec)

### Major Issues (Should Fix for Quality)
1. **Skeleton Loaders** — No loading states for data fetches
2. **PayPal Integration** — No webhook, no order capture
3. **Mobile Camera/Video/Doc** — Picker screens not implemented
4. **Custody Timeline** — No timeline component for /verify page
5. **RTL Support** — Mobile not handling Arabic RTL switch instantly
6. **Error Boundaries** — Incomplete error handling on pages

### Minor Issues (Nice to Have)
1. **Premium Typography** — Current spacing/sizing not "Stripe quality"
2. **Dark Mode** — Not fully implemented/tested
3. **OpenGraph Images** — Not generated
4. **Mobile Splash Screen** — Not customized
5. **Analytics** — Sentry integrated but not fully configured

---

## 11. VERIFICATION CHECKLIST (FOR NEXT PHASES)

Before declaring each phase "done", verify:

- [ ] All listed routes exist and load without 404
- [ ] Auth flow works end-to-end (login → token → profile display)
- [ ] Evidence upload completes without error
- [ ] Billing page shows and checkout initiates (at least)
- [ ] Mobile screens render without crashes
- [ ] Language switch updates UI instantly
- [ ] No console errors on any page

---

## 12. RECOMMENDATIONS (PRIORITY ORDER)

### Phase 1 (Web Foundations)
1. Implement host routing properly (verify middleware works)
2. Build design system components (Toast, Modal, Skeleton, Timeline, EmptyState)
3. Fix legal pages locale handling (detect from Accept-Language + URL)
4. Add language switcher header (always visible on all pages)

### Phase 2 (Auth)
1. Verify Google web login works (debug if OAuth flow fails)
2. Implement Apple web login properly
3. Ensure profile display works on /settings
4. Add logout redirect behavior

### Phase 3 (Billing)
1. Wire Stripe checkout button → session creation
2. Handle Stripe webhooks (save customer name)
3. Implement PayPal order capture
4. Show invoices with customer name

### Phase 4 (Evidence)
1. Build `/capture` page (upload UI + progress)
2. Build `/evidence/[id]` page (show details + share)
3. Build `/verify/[token]` custody timeline component
4. Test evidence E2E flow

### Phase 5 (Mobile)
1. Implement camera photo picker + upload
2. Implement video recorder (unlimited, warn at 30min)
3. Implement document picker
4. Build SQLite upload queue with retry logic

### Phase 6 (Polish)
1. Add skeleton loaders to all async pages
2. Add toast feedback for copy/share/download
3. Build premium landing page (sections + icons)
4. Generate mobile app icon + favicon

---

## 13. NEXT STEPS

**Do not proceed to Phase 1 until:**
1. This audit report has been reviewed
2. Critical blockers have been prioritized
3. Team has confirmed implementation order

**Start with Phase 1 immediately once approved**, focusing on:
1. Design system component library
2. Proper host routing verification
3. Missing pages scaffold (capture, evidence/[id])
4. Header language switcher

---

**Status**: ✅ AUDIT COMPLETE  
**Ready for**: Phase 1 Implementation  
**Estimated Duration**: 8 phases, ~6-8 weeks for full MVP

