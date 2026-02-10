# PHASE 3: VERIFY PAGE & BILLING — PREVIEW

**Status**: Ready for Planning  
**Estimated Duration**: 6-8 hours  
**Priority**: HIGH (Completes core MVP)

---

## Objectives

### 1. Verify Page (`/verify/[token]`)

**Purpose**: Public-facing evidence verification page  
**URL**: `app.proovra.com/verify/[signature_token]`

**Requirements**:
- Display evidence metadata (type, timestamp, uploader)
- Show file hash (SHA-256)
- Show digital signature
- Display chain of custody timeline
- Verify signature authenticity
- Show tamper detection status
- No authentication required (public link)

**Components Needed**:
- Verify page component (`apps/web/app/verify/[token]/page.tsx`)
- Signature verification logic
- Timeline display component
- Tamper detection indicator

**Estimated Implementation**: 2-3 hours

### 2. Billing Integration (Stripe)

**Purpose**: Connect payment system to pricing/checkout  
**Integration Points**:
- `/pricing` page → Stripe checkout modal
- Webhook handlers → Update plan in database
- `/settings` → Show current plan + upgrade button
- `/billing` → Manage subscription

**Requirements**:
- Stripe checkout modal (hosted)
- Webhook signature verification
- Update user plan on successful payment
- Handle plan downgrades
- Show invoice history
- Cancel subscription option

**Components Needed**:
- Billing page component (`apps/web/app/(app)/billing/page.tsx`)
- Stripe integration module (`lib/stripe.ts`)
- Webhook handler (`app/api/webhooks/stripe/route.ts`)

**Estimated Implementation**: 2-3 hours

### 3. Dashboard/Home Page (`/home`)

**Purpose**: User's evidence list and management  
**URL**: `app.proovra.com/home`

**Requirements**:
- Display all user's evidence in a list/grid
- Filter by type (PHOTO, VIDEO, DOCUMENT)
- Filter by date range
- Sort by date, type, size
- Pagination (20 items per page)
- Search by filename
- Quick actions: Share, Download, Delete
- Evidence count summary
- Empty state for new users

**Components Needed**:
- Home/dashboard page component
- Evidence list component
- Filter sidebar component
- Evidence card component
- Pagination component

**Estimated Implementation**: 2-3 hours

---

## Current State (Before Phase 3)

### What's Working
- ✅ `/evidence/[id]` — Evidence detail page
- ✅ `/capture` — Upload page
- ✅ `/settings` — Profile page
- ✅ OAuth login flows
- ✅ Toast notifications throughout

### What's Missing
- ❌ `/verify/[token]` — Public verification page
- ❌ `/home` — Dashboard/evidence list
- ❌ `/billing` — Subscription management
- ❌ Stripe checkout integration
- ❌ Webhook handlers

---

## Implementation Order

### Step 1: Verify Page (Highest Priority)

**Why First**:
- Minimal dependencies
- Can be tested independently
- Critical for MVP (public sharing feature)
- No payment system needed

**Tasks**:
1. Create `/verify/[token]/page.tsx`
2. Fetch evidence by signature token
3. Parse and display metadata
4. Verify signature authenticity
5. Add Toast feedback
6. Handle errors gracefully
7. Add EmptyState if token invalid

**Files to Create/Modify**:
- `apps/web/app/verify/[token]/page.tsx` — NEW (150 lines)

**Estimated Time**: 1-2 hours

### Step 2: Dashboard/Home (Next Priority)

**Why Second**:
- Depends on evidence endpoint (already exists)
- Needed for user engagement
- No payment system needed

**Tasks**:
1. Create `/home/page.tsx`
2. Fetch user's evidence list
3. Add filter sidebar (type, date range)
4. Add sort options
5. Add pagination
6. Add search functionality
7. Add quick action buttons
8. Add empty state
9. Integrate Toast for actions

**Files to Create/Modify**:
- `apps/web/app/(app)/home/page.tsx` — MODIFY/CREATE (200 lines)
- `apps/web/components/evidence-card.tsx` — NEW (80 lines)
- `apps/web/components/filter-sidebar.tsx` — NEW (120 lines)

**Estimated Time**: 2-3 hours

### Step 3: Billing Integration (Last)

**Why Last**:
- Most complex
- Payment system integration
- Depends on Stripe account setup
- Requires webhook configuration

**Tasks**:
1. Setup Stripe keys in .env
2. Create billing page (`/billing/page.tsx`)
3. Create Stripe integration module
4. Add checkout modal on `/pricing`
5. Create webhook handler
6. Test payment flow
7. Verify plan updates

**Files to Create/Modify**:
- `apps/web/lib/stripe.ts` — NEW (150 lines)
- `apps/web/app/(app)/billing/page.tsx` — NEW (200 lines)
- `apps/web/app/api/webhooks/stripe/route.ts` — NEW (100 lines)
- `apps/web/app/pricing/page.tsx` — MODIFY (add checkout button)

**Estimated Time**: 3-4 hours

---

## Design System Components Needed

From Phase 1 (already available):
- ✅ Toast — For user feedback
- ✅ Card — Evidence card layout
- ✅ Button — Actions
- ✅ Input — Search field
- ✅ Select — Filter dropdowns
- ✅ EmptyState — No results state
- ✅ Skeleton — Loading state

New components (if needed):
- Modal (already built) — Stripe checkout
- Pagination (simple, inline)
- Badge (filter tags)

---

## API Endpoints Required

### Verify Page
```
GET /v1/evidence/verify/[token]
→ Returns: { evidence, hash, signature, chain, tamper_detected }
```

### Dashboard
```
GET /v1/evidence?filter=type&sort=date&page=1&limit=20
→ Returns: { evidence[], total, page, pages }

GET /v1/evidence/count
→ Returns: { total, byType: {} }
```

### Billing
```
GET /v1/billing/status
→ Returns: { plan, invoice_history }

POST /v1/billing/checkout
→ Returns: { session_id, checkout_url }

POST /webhooks/stripe
→ Handles: charge.succeeded, subscription.updated, subscription.deleted
```

---

## Estimated Timeline for Phase 3

| Task | Duration | Status |
|------|----------|--------|
| Verify Page | 1-2 hours | ⏳ Queued |
| Home/Dashboard | 2-3 hours | ⏳ Queued |
| Billing Integration | 3-4 hours | ⏳ Queued |
| **TOTAL** | **6-9 hours** | |

---

## Success Criteria

### Verify Page
- ✅ Public link shares evidence
- ✅ Signature verified
- ✅ Tamper detection works
- ✅ Timeline displays chain of custody
- ✅ No auth required
- ✅ Graceful error handling

### Dashboard
- ✅ Lists all user evidence
- ✅ Filters work correctly
- ✅ Sort works correctly
- ✅ Pagination works
- ✅ Search works
- ✅ Quick actions work
- ✅ Empty state for new users
- ✅ Responsive design

### Billing
- ✅ Stripe checkout opens
- ✅ Payment processing works
- ✅ Webhook updates plan
- ✅ User can view invoices
- ✅ Plan upgrade/downgrade works
- ✅ Cancel subscription works

---

## Known Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Signature verification complex | HIGH | Request help from crypto team |
| Stripe account setup | MEDIUM | Contact Stripe support early |
| Webhook security | MEDIUM | Use webhook signature verification |
| API endpoint delays | MEDIUM | Have fallback UI states |
| Payment processing errors | MEDIUM | Comprehensive error handling |

---

## Next After Phase 3

Once Phase 3 is complete:
- **Phase 4**: Share page, PDF reports, retention policies
- **Phase 5**: Legal pages, support system
- **Phase 6**: CI/CD, performance, testing
- **Phase 7**: Mobile deployment, web deployment
- **Phase 8**: Polish, launch, monitoring

---

## Resources Needed

### Documentation
- Stripe API docs
- Evidence verification algorithm
- Chain of custody requirements

### External Services
- Stripe account
- Stripe API keys
- Webhook endpoint

### Team
- Crypto specialist (for signature verification)
- Stripe integration experience (helpful but not required)

---

## Recommended Starting Point

**Once Phase 2 testing passes:**

1. Start with Verify page (simplest, highest value)
2. Then Home/Dashboard (commonly used)
3. Finally Billing (complex, can be refined later)

This order ensures:
- Quick wins early
- Core features working fast
- Complex features last

---

**Phase 3 is the final phase before deployment!**

Current plan:
1. ✅ Phase 0: Audit (COMPLETE)
2. ✅ Phase 1: Design System (COMPLETE)
3. ⏳ Phase 2: Auth & Profile (TESTING)
4. ⏳ Phase 3: Verify & Billing (NEXT)
5. ⏳ Phase 4: Share & Reports (AFTER)
6. ⏳ Phases 5-8: Final phases

---

**Ready for Phase 3 planning after Phase 2 completion!**
