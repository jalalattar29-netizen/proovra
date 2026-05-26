# PROOVRA — Full Enterprise Product / Engineering / UX / Competitive Audit

**Audit date:** 2026-05-26
**Audit scope:** Sections 1–23 of the audit prompt
**Methodology:** Synthesis of 5 prior governed phase audits (E10.2 operational readiness, CR4 verify decomposition, CR5 capture safety, R10 visual governance, R11 browser/a11y) + targeted fresh inspection of env config, monitoring stack, dependencies, mobile app presence, capability registry.
**Brutally strict.** No flattery. MVP quality is NOT acceptable. Backend-only features = unfinished. Misleading legal/trust wording = critical risk.

---

# A. EXECUTIVE VERDICT

| Dimension | Score | Verdict |
|---|---|---|
| **Overall** | **62 / 100** | Operationally strong; visually + browser-certification immature; cannot honestly claim world-class enterprise readiness today. |
| Backend | **82 / 100** | Genuine strength. 9,817 contract tests; single-writer custody chain; bounded retries; honest degraded states; SOC-bug guards; 32-runbook operational set. |
| Frontend coverage | **63 / 100** | Most backend capabilities have SOME frontend surface, but several are admin/ops-only or thinly wired. 94 routes is a sign of sprawl, not depth. |
| Usability | **55 / 100** | Workflows EXIST but are not enterprise-polished. Dense, predominantly operator-desktop-first, multiple competing card systems, inconsistent state vocabulary across surfaces. |
| Enterprise readiness | **58 / 100** | Single-customer pilot capable. Multi-customer pilot requires DEF-043 + DEF-044 closure. Open-public launch requires R11.1 + DEF-058 (browser/a11y certification). |
| UI / UX | **48 / 100** | Visual governance written (R10) + pinned (235 cases). Mass UI consolidation NOT executed. Verify token monolith 7,273 LOC. Capture orchestrator 1,429 LOC. No canonical Table primitive. |
| Competitive readiness | **40 / 100** | Compared to enterprise-grade verification platforms: PROOVRA's trust language is more honest than most (good), operational depth is real but UNDERSOLD by the UI, and multiple surfaces look like a startup MVP rather than an infrastructure product. |

**The honest one-line verdict:**
**PROOVRA is a substantively mature backend + governance platform wrapped in a visually inconsistent, partially-decomposed UI with zero formal cross-browser or a11y certification evidence. It can credibly support a controlled single-customer enterprise pilot today. It cannot credibly market itself as "enterprise evidence infrastructure" until the UI maturity, browser certification, and a11y certification gaps close.**

**Would a serious enterprise realistically trust and purchase this platform today?**
- Pilot tier (single named customer, hand-walked onboarding): **YES, with bounded scope and documented limitations.**
- Procurement tier (formal RFP, security review, multi-customer rollout): **NO, until R11.1 + DEF-043 + DEF-044 + at least 6 weeks of clean pilot operational data.**

---

# B. CRITICAL ISSUES TABLE

| # | Priority | Area | Issue | Evidence | User risk | Enterprise risk | Recommended fix | Files involved |
|---|---|---|---|---|---|---|---|---|
| 1 | **P0** | Auth / SSO | SAML SSO callback is NOT transactional. User row, ExternalIdentityMapping, TeamMember are sequential ops — orphan user persists if step 2/3 fails. | E10.2 audit row 18 = ❌ RISK; DEF-043 (PILOT_HARDENING) | Orphan account in DB cannot access workspace; user confusion. | Multi-customer pilot blocker; per E10.2 enterprise scoring. | Wrap 3 ops in `prisma.$transaction([...])`. ~1 day. | `services/api/src/services/sso.service.ts` ~478-749 |
| 2 | **P0** | Billing | PayPal webhook lacks per-event idempotency. Stripe has it via E10.1. PayPal subscription state-transition events can double-apply. | E10.2 audit row 15 = ❌ RISK; DEF-044 (PILOT_HARDENING) | Customer overcharged / subscription state corruption. | Multi-customer pilot blocker. | Mirror E10.1 Stripe pattern: `PaypalWebhookEvent` table + UNIQUE `paypal_event_id` index. ~1 day. | New: `services/api/src/routes/paypal-webhook.routes.ts` (or extend existing) |
| 3 | **P0** | Cross-browser cert | Zero Playwright / axe-core / browser-farm infrastructure. R11 documented this honestly as DEF-058 → R11.1. | `package.json` grep returns no playwright/cypress; R11 doc §3 + DEF-058 | "Works in Chrome only" risk on first real-world Safari / Firefox customer. | Procurement teams require WCAG conformance evidence. | R11.1 phase: Playwright install + axe-core + BrowserStack + per-surface walk. ~2 weeks. | New: `apps/web/playwright.config.ts`, `apps/web/e2e/**` |
| 4 | **P0** | Operations (Ops-owned) | Production secret-rotation audit (DEF-003) and SAML pilot rehearsal (DEF-002) have READY runbooks (18, 19) but NOT YET WALKED. | DEF-002 + DEF-003 status in `MASTER_PHASE_REGISTRY.md` §6 | Cannot prove production secrets are post-rotation; cannot prove SAML works against real IdP. | Single-customer pilot blocker per E10 + E10.2. | Ops walks both runbooks; appends rehearsal-log rows. Customer-side scheduling. | `docs/operations/runbooks/18-production-secret-audit.md`, `19-saml-pilot-rehearsal.md` |
| 5 | **P1** | Verify UI | Verify token page is a 7,273-LOC monolith (post-CR4 partial extraction). All trust + integrity + custody + identity + technical surfaces in one file. CR4 deferred 10 components to DEF-052. | `apps/web/app/verify/[token]/page.tsx` 252,010 bytes; CR4 doc §7 | Maintenance brittleness; any future trust-language change risks regression. | Enterprise procurement reviewers see "trust surface" but file is unwieldy. | CR4.1 follow-on: extract `_types.ts` + brand constants + 10 named components under the 175-case CR4 contract. | Per CR4 doc DEF-052 plan |
| 6 | **P1** | Capture UI | Capture page is 1,429 LOC orchestrator + `useCaptureSessionOrchestration` 953 LOC. CR5 explicitly did not split (prompt forbade "duplicated orchestration"). | `apps/web/app/(app)/capture/page.tsx` 48,616 bytes; CR5 doc §4 | Page-level JSX render complexity makes UX evolution risky. | Capture is THE credibility surface for evidence ingest. | A future presentation-only phase under the 888-case CR5 contract. | Per CR5 doc DEF-053 plan |
| 7 | **P1** | Accessibility | No formal WCAG audit; 12 anchors carry incomplete `rel`; 0 AbortController usages; `prefers-reduced-motion` not honored. | R11 doc §17 (DEF-058, 062, 063); R10 doc DEF-057 | Keyboard-only / screen-reader users may hit walls in dense reviewer queues. | Some EU + US-federal procurement requires WCAG AA. | R11.1 phase (deferred). | Per R11 doc DEF-058 path |
| 8 | **P1** | AI surface | AI cost-guard is in-memory (DEF-049); chat message has no input-side prompt-injection sanitisation (DEF-033); AI provider error emits no SecurityEvent (DEF-035). | E9 doc + E10.2 audit row 23 = ⚠ GAP | Brief overspend window on API crash; provider failures not in security stream. | Operational hygiene gap; not customer-facing risk. | Three small bounded phases. | `services/api/src/services/ai/**`, `openai-provider.ts` |
| 9 | **P1** | Mobile UX | Operator dashboard / reviewer queue / capture explicitly DOCUMENTED_LIMITATION for mobile (desktop-first per R11 §8). External intake "needs validation". | R11 doc §3 mobile rows | External submitters using mobile may experience suboptimal UX. | If a customer's intake population is mobile-heavy, this becomes a deal blocker. | R11.1 + DEF-055 (canonical Table mobile-degradation). | Multiple |
| 10 | **P1** | Visual governance | 5 `outline: none` CSS rules; multiple competing card systems; no canonical `Table` / `ErrorState` primitive; 8,875 LOC of capture-v2.css alone. | R10 audit §3.4 + DEF-054 | Visual incoherence undermines trust signal of operator surfaces. | Enterprise UX maturity assessed at 7/10 by R10. | R10.1 + DEF-054. | `components/ui.tsx`, `globals.css` |
| 11 | **P2** | Observability | Sentry IS configured (web + api + worker). Configuration depth (PII redaction, release tracking, user-id attribution, alerting) NOT audited end-to-end. | `apps/web/lib/sentry.ts`, `services/api/src/observability/sentry.ts`, `services/worker/src/sentry.ts` present | Production blind spots possible if not wired correctly. | Per-error severity routing + alerting required for enterprise SLAs. | Audit the 3 sentry.ts files; pin PII-redaction + release-id + user-context patterns. | 3 files above |
| 12 | **P2** | Capture monolith hash truth | Browser SHA-256 prep `hash-utils.ts` byte-pinned (3,302 bytes) — server recomputes + rejects mismatches. Honest. | CR5 doc §6 finalize chain | None today. | Critical contract; protected. | Already pinned. | `apps/web/app/(app)/capture/_lib/hash-utils.ts` |
| 13 | **P2** | Deferred items pile | 63 DEFs tracked (-001 through -063). Several are POST_LAUNCH polish. Some are R-future / R11.1 deferrals. | `MASTER_PHASE_REGISTRY.md` §6 | Backlog growth; nothing is silently hidden. | Honest accounting is itself an enterprise signal — but customers will still ask "when does X close." | Continued bounded-phase discipline. | Master registry |
| 14 | **P2** | Mobile app | `apps/mobile/` exists with its own Sentry + .env.example. NOT audited in any of the prior 5 phases. Unknown maturity. | `apps/mobile/.env.example`, `apps/mobile/src/sentry.ts` | UNCLEAR. May be prototype-level. | Could be advertised externally vs not advertised — risk depends on customer-facing positioning. | A bounded "Mobile-readiness audit" phase before any mobile-facing customer claim. | `apps/mobile/**` |
| 15 | **P3** | Documentation completeness | Master registry is comprehensive. Per-phase docs cover 28 phases. No customer-facing "getting started" or "developer onboarding from zero" doc surfaced in this audit. | Glob found phase docs + runbooks + ops audit; no `GETTING_STARTED.md` or `DEVELOPER_ONBOARDING.md` at root | New dev / new customer ramp difficulty. | Procurement teams expect ops + dev docs. | Add `README.md` enrichments + a new-developer setup runbook. | `README.md` (if present), `docs/` |

---

# C. BACKEND-TO-FRONTEND COVERAGE MATRIX

Confidence note: this matrix is built from the master registry's §3/4 (completed/closed-with-deferred phases) + the 22 component directories observed under `apps/web/components/` + 94 page.tsx routes. Per-capability frontend depth NOT individually rated for every backend capability; gaps marked UNCLEAR where I haven't separately verified.

| Capability | Backend | Frontend | Reachability | Usability | Missing UI/actions | Priority | Fix recommendation |
|---|---|---|---|---|---|---|---|
| Evidence capture (upload + multipart resumable) | ✅ Production (CR5 byte-pinned) | ✅ Full (`/capture` route, 1,429 LOC orchestrator) | Direct nav | Desktop-first, dense | Mobile degradation; canonical Table not used | P1 | R10.1 + R11.1 |
| Evidence finalize/sign | ✅ Production (`completeEvidence` tx, 41,849 bytes pinned) | ✅ Via capture orchestrator only | Capture page CTA | Bounded; backend-owned | None critical | — | — |
| Custody chain (append-only, hash-chained) | ✅ Production (`appendCustodyEventTx` with advisory lock) | ⚠ Read-only on Verify page + reviewer surfaces | Verify page deep-section | Dense but readable | DEF-054 canonical timeline primitive | P2 | R10.1 |
| TSA (RFC 3161 timestamping) | ✅ Production (20s timeout; per-evidence status) | ✅ Status badges on Verify | Verify "Trusted timestamp" section | Honest "STAMPED / FAILED / UNAVAILABLE" vocabulary | None | — | — |
| OTS (OpenTimestamps / Bitcoin anchoring) | ✅ Production (1h retry pipeline) | ✅ Status badges on Verify | Verify "Anchoring" section | Honest "PENDING / ANCHORED / FAILED / UNAVAILABLE" | None | — | — |
| Public verify (anonymous token redemption) | ✅ Production (publicVerifyState gating, projection service) | ✅ Full at `/verify/[token]` | Direct URL + QR | 7,273-LOC monolith | DEF-052 (presentation hygiene) | P1 | CR4.1 |
| Reports (rendered PDF, Puppeteer) | ✅ Production (BullMQ workers; no explicit timeout — DEF-047) | ✅ Status + download surfaces | Evidence detail + reports index | Honest | DEF-047 (Puppeteer timeout); DEF-054 (canonical states) | P2 | Bounded phase |
| Verification package (zip artifact) | ✅ Production (streamed; abort on error) | ✅ Download CTA | Evidence detail | Honest | None critical | — | — |
| Reviewer ops + escalation engine | ✅ Production (E10.2 audit ✅ SOUND) | ✅ Dedicated page + escalation surface | `/review/operations` | Dense, desktop-first | DEF-055 (mobile degradation) | P1 | R10.1 |
| Governance lifecycle (single-writer orchestrator) | ✅ Production (E10.2 ⚠ GAP for TOCTOU DEF-050) | ✅ Governance hub + 7 sub-pages | `/governance` | Honest | DEF-050 polish | P2 | Bounded phase |
| Retention reconciliation worker | ✅ Production (E10.2 ⚠ GAP for hardcoded 7d window DEF-051) | ✅ Retention list | `/governance/retention` | Limited config UI | DEF-051 + policy-driven config | P2 | Bounded phase |
| Destruction review + orchestrator | ✅ Production (atomic tx) | ✅ Destruction surface | `/governance/destruction` | Bounded | DEF-050 (TOCTOU window) | P2 | Bounded phase |
| Auth — email/password + MFA | ✅ Production (E10.2 ✅ SOUND; R8.1.x ten sub-phases) | ✅ Full | Standard auth surfaces | Mature | None critical | — | — |
| Auth — adaptive MFA + step-up + revoke | ✅ Production (DEF-046 no OWNER break-glass) | ✅ MFA + recovery surfaces | `/security-center/mfa-recovery` | Mature | DEF-046 follow-on | P2 | Bounded phase |
| SAML SSO | ✅ Production-shape (DEF-001 SP signing; DEF-043 transaction; DEF-002 IdP rehearsal) | ✅ Admin surface | `/security-center/sso` | Bounded | DEF-043 P0; DEF-002 P0 | P0 | Already in plan |
| SCIM / external identity | ✅ Production (DEF-043 carries dangling mapping risk) | ⚠ Admin-only | `/admin/identity` | Bounded | Covered by DEF-043 | P0 | With SSO fix |
| RBAC + capability resolver | ✅ Production (DEF-045 in-process cache TTL unclear) | ✅ Via PageRouteGate (≥ 80% coverage) | All protected routes | Mature | DEF-045 follow-on | P3 | Bounded phase |
| Stripe billing | ✅ Production (E10.1 idempotency closed) | ✅ Billing surface | `/billing` | Bounded | None critical | — | — |
| PayPal billing | ⚠ Partial (DEF-044 idempotency open) | ✅ Billing surface | `/billing` | Bounded | DEF-044 idempotency | P0 | Already in plan |
| Plan enforcement (PLAN_CAPABILITIES) | ✅ Production (publicVerifyIncluded gating verified) | ✅ Via plan-gated CTAs | Multiple surfaces | Bounded | None critical | — | — |
| Automation runtime (E3.x) | ✅ Production (E3.3 async + retry + auto-disable) | ✅ Dedicated page | `/ops/automation` | Mature | None critical | — | — |
| Webhook delivery + retry | ✅ Production (E3.2 + E3.3 HTTPS + SSRF + HMAC) | ✅ Webhook destination admin | `/ops/automation` (integrated) | Bounded | None critical | — | — |
| Analytics (E4) | ✅ Production (5 source-traced endpoints) | ✅ `/ops/analytics` page | Direct nav | Bounded; honest degraded states | DEF-055 mobile degradation | P2 | R10.1 |
| Trust Center (E5) | ✅ Production (canonical content module) | ✅ Public `/about/trust` | Help menu + direct URL | Mature | None | — | — |
| DR / continuity runbooks (E6) | ✅ Production (32 runbooks; restore validation) | ✅ Runbook docs (not user UI) | Ops-only | Operator-facing only | DEF-024/025/026/027 follow-on | P3 | Bounded phase |
| Persona-aware UX (E7) | ✅ Production (canonical content module) | ✅ Dashboard + capture + onboarding | Multiple | Mature | None | — | — |
| External distribution (E8) | ✅ Production (6 participant types + 5 surfaces) | ✅ Workflow intake + external review + intake links + evidence requests + share STUB | Multiple | Mature | DEF-028/029/030/031/032 follow-on | P2 | Bounded phase |
| AI operational (E9) | ✅ Bounded production (advisory + noop fallback + cost guard) | ✅ CaptureAiAssistant + ProovraChatWidget | Capture page + chat | Bounded | DEF-033/034/035/036 follow-on | P2 | Bounded phase |
| Notifications | ✅ Production (Resend) | ✅ Notification settings + delivery | `/notifications` + `/settings` | Bounded | DEF-019 SecurityEvent on failure | P3 | Bounded phase |
| Search / indexing | ✅ Production (DEF-048 no SLA/alert) | ✅ Search surface | `/search` | Bounded | DEF-048 follow-on | P2 | Bounded phase |
| Cases | ✅ Production | ✅ `/cases` + `/cases/[id]` | Direct nav | Bounded | DEF-060 multi-tab conflict UX | P2 | R-future |
| Investigation (graph / duplicates / timeline / relationships / reviewers) | ⚠ UNCLEAR maturity (5 sub-pages but not audited individually) | ✅ Pages exist under `/investigation/*` | Direct nav | UNCLEAR | UNCLEAR — audit needed | P2 | Dedicated audit |
| Communications (Twilio SMS) | ⚠ E10.2 ⚠ GAP (no queue resilience) | ✅ `/communications` page | Direct nav | Bounded | Queue resilience | P3 | Bounded phase |
| Integrations | ⚠ UNCLEAR | ✅ `/integrations` page | Direct nav | UNCLEAR | UNCLEAR | P2 | Dedicated audit |
| Admin / runtime | ✅ Production | ✅ `/admin/*` (5 pages) | Admin-only | Operator-facing | None critical | — | — |
| Onboarding (E7-persona-aware) | ✅ Production | ✅ Multiple onboarding routes | Default for new users | Mature | DEF-007 providers.tsx self-fetch | P3 | Bounded phase |
| Workspace / team management | ✅ Production | ✅ `/teams` + `/teams/[id]` | Direct nav | Bounded | DEF-060 multi-tab conflict | P2 | R-future |
| Mobile app (`apps/mobile/`) | ⚠ UNCLEAR — separate codebase | UNCLEAR | UNCLEAR | UNCLEAR | UNCLEAR | P1 | **DEDICATED MOBILE AUDIT REQUIRED** |

---

# D. WORKFLOW GAP REPORT

| Workflow | Status | Gaps |
|---|---|---|
| First-customer onboarding (signup → workspace → first capture) | ✅ Walkable | Hand-holding by Ops still expected; no recorded "time-to-first-evidence" telemetry; ~7 personas means first-screen choice matters |
| Capture → upload → finalize → verify | ✅ Walkable | Mobile capture documented as DOCUMENTED_LIMITATION; iOS Safari background-tab suspension not in user-facing copy (DEF-059) |
| Public share / QR verification | ✅ Walkable | Verify token page monolith makes copy iteration risky (DEF-052) |
| Reviewer queue triage | ✅ Walkable | Mobile degradation gap (DEF-055); table primitive missing (DEF-054) |
| Governance lifecycle (retention / destruction / hold) | ✅ Walkable | TOCTOU windows documented (DEF-050); 7d auto-extension hardcoded (DEF-051) |
| External intake (workflow intake link redemption) | ✅ Walkable | Token revocation works; lifecycle GC not automated (DEF-031/032) |
| External review (reviewer-redemption + 5-grant lifecycle) | ✅ Walkable | No rate limit on reviewer-redemption routes (DEF-028); no feature flag kill switch (DEF-029); no SecurityEvent on responder submission (DEF-030) |
| AI advisory in capture | ✅ Walkable | Advisory-only; failure-tolerant noop fallback; no autonomy. Per-team capability gate missing (DEF-036) |
| Billing checkout | ✅ Walkable (Stripe primary) | PayPal idempotency gap (DEF-044, P0) |
| MFA enrollment + recovery | ✅ Walkable | No OWNER break-glass if all factors lost (DEF-046) |
| SAML SSO end-to-end | ⚠ Code-shape complete, UNTESTED with real IdP | DEF-002 (Ops + customer to walk runbook 19); DEF-043 (callback transaction — P0); DEF-001 (SP request signing) |
| Multi-tab editing (same case / same evidence) | ⚠ Last-write-wins | DEF-060 (UX conflict messaging) |
| Long-running reviewer session (4–8h) | ⚠ Per R11 NEEDS_VALIDATION on Firefox + Safari | R11.1 to validate |
| Cross-browser browser-window-close mid-upload | ⚠ Bounded by CR5 contract + resumable retry | iOS suspension not in user-facing copy |

---

# E. ENTERPRISE RISK REPORT

| Risk | Severity | Description |
|---|---|---|
| **Trust-language overclaim** | ✅ MITIGATED | E5 PROOVRA_FORBIDDEN_SURFACE_PATTERNS pinned across CR4 + R10 + R11 (1,432 cases). No "AI verified", "tamper-proof", "court-certified" reach user surfaces. |
| **Custody chain forge** | ✅ MITIGATED | Frontend cannot import `appendCustodyEvent`. Single-writer backend tx. Hash chain. Advisory-locked. |
| **Browser hash truth substitution** | ✅ MITIGATED | Server recomputes SHA-256 from S3 stream on multipart complete. Browser hash is for verification only. |
| **SSO orphan-user** | ❌ ACTIVE | DEF-043 P0. Defense-in-depth via RBAC prevents abuse but orphan account persists. |
| **PayPal double-capture** | ❌ ACTIVE | DEF-044 P0. Stripe protected (E10.1); PayPal not. |
| **Live IdP unvalidated** | ❌ ACTIVE | DEF-002 P0 Ops-owned. Runbook ready. |
| **Production secrets pre-rotation** | ❌ ACTIVE | DEF-003 P0 Ops-owned. Runbook ready. |
| **Cross-browser certification gap** | ❌ ACTIVE | DEF-058 P1. No real Safari / Firefox cert. |
| **WCAG conformance gap** | ❌ ACTIVE | DEF-056 P1. R11 documented foundations only; formal cert deferred. |
| **Multi-tab edit silent overwrite** | ⚠ MINOR | DEF-060. Last-write-wins; observable only on multi-admin teams. |
| **Mobile operator UX** | ⚠ DOCUMENTED_LIMITATION | Desktop-first. Per R11 §8. |
| **AI prompt injection** | ⚠ DEFENCE-IN-DEPTH ONLY | DEF-033. Output-side ai-policy 37-pattern filter blocks forbidden output; input-side sanitisation gap. |
| **Search-indexing lag SLA** | ⚠ NO ALERT | DEF-048. Operator-detectable; no proactive. |
| **Worker thread hang on pathological PDF** | ⚠ BOUNDED | DEF-047. Puppeteer no explicit timeout; Node 120s default. |
| **OWNER MFA lockout** | ⚠ NO BREAK-GLASS | DEF-046. Documented gap. |

---

# F. COMPETITIVE GAP REPORT

Per the audit's rule "do not invent competitor capabilities," this compares conceptually only.

| Vector | PROOVRA today | Stripe / Linear / Vercel-style enterprise SaaS | Truepic-style controlled-capture | Cellebrite-style forensic acquisition | Honest verdict |
|---|---|---|---|---|---|
| **Trust language honesty** | ✅ Best-in-class — 1,432-case contract preventing "AI verified" / "tamper-proof" / "court-certified" | Variable; some lean marketing | Truepic markets capture-at-source provenance | Cellebrite markets forensic-grade acquisition | PROOVRA wins on honesty; loses on positioning sharpness |
| **Operator dashboard polish** | ⚠ 7/10 — visually inconsistent across surfaces | Stripe / Linear are 9-10/10 | n/a | n/a | Visible gap |
| **Onboarding friction** | ⚠ Persona-aware (E7) but 7 personas to choose | Stripe / Linear: ~30s to first action | n/a | n/a | Friction gap |
| **Mobile operator UX** | ❌ Desktop-first (documented limitation) | Linear has good mobile | Truepic IS mobile-first | n/a | PROOVRA does not compete in mobile-capture vertical |
| **Public-facing verify page** | ⚠ 7,273-LOC monolith, content is accurate | n/a | Truepic verification UI is polished | n/a | Content > polish today |
| **Custody chain depth** | ✅ Append-only, hash-chained, advisory-locked, TSA + OTS optional | n/a | n/a | Cellebrite has strong custody | Strong technical posture, weak visual exposition |
| **Reviewer queue density** | ✅ Built for operator scale | Linear-style | n/a | Cellebrite-grade | Strong but UI polish gap |
| **Cross-browser certified** | ❌ Self-rated 5/10 | Stripe / Vercel / Linear: certified | Truepic certified | Cellebrite certified | Significant gap |
| **A11y certified** | ❌ Self-rated 6/10 (foundations only) | Stripe / Linear: WCAG AA | Truepic claims n/a observed | n/a | Significant gap |
| **Operational runbook depth** | ✅ 32 runbooks; honest "operator walks runbook X" prescription | Stripe operations are opaque externally | n/a | n/a | PROOVRA's operational honesty is a unique selling point |
| **Pricing transparency** | ⚠ UNCLEAR (plan capabilities exist; surface UX not audited) | Stripe / Linear: clear | n/a | n/a | Audit gap |
| **API depth** | ✅ Strong — analytics + webhooks + automation runtime + 6 REST surfaces | Stripe-grade external API; Linear-grade internal | n/a | Cellebrite SDK | Mid-tier API exposure |
| **Enterprise SSO / SCIM** | ⚠ Code-shape complete but unvalidated against real IdPs | Stripe / Linear: validated | n/a | Cellebrite: validated | DEF-002 blocks |

---

# G. FALSE ENTERPRISE REPORT

Looking for places where the product LOOKS enterprise but is not actually enterprise-grade:

| # | Surface | Decorative? | Real-backed? | Verdict |
|---|---|---|---|---|
| 1 | Verify token page trust badges | ❌ Decorative-looking but BACKED by real TSA/OTS state, real hash chain | ✅ Real-backed | Genuine. |
| 2 | Operator dashboard metric cards (E4 analytics) | Source-traceable to Prisma model + filter | ✅ Real-backed (E4 contract) | Genuine. Cannot fabricate metrics. |
| 3 | Trust Center page (`/about/trust`) | Public-facing E5 content | ✅ Real-backed | Genuine. Pinned by E5 contract test. |
| 4 | Reviewer queue counts | Backend-computed; per-team scoped | ✅ Real-backed | Genuine. |
| 5 | Custody timeline (Verify + reviewer surfaces) | Backed by `CustodyEvent` rows + hash chain | ✅ Real-backed | Genuine. |
| 6 | "AI assistant" surface | Bounded-advisory; noop fallback | ✅ Real-backed within E9 contract scope | Genuine. AI is advisory only; explicit per E9 content module. |
| 7 | Governance lifecycle hub | 7 sub-pages, each backed by real services | ✅ Real-backed | Genuine. |
| 8 | Admin runtime surface | Real worker / queue / readiness state | ✅ Real-backed | Genuine. |
| 9 | Operator dashboard "operational summary" band | Backed by E10.2 reviewer-ops engine | ✅ Real-backed | Genuine. |
| 10 | DR / continuity runbooks (32 docs) | Real ops procedures; runbook 18 + 19 NOT YET WALKED | ✅ Real-backed; ⚠ unexecuted | Genuine in shape; operational execution still pending. |
| 11 | "Enterprise" plan tier UI | Backed by PLAN_CAPABILITIES table | ✅ Real-backed | Genuine. |
| 12 | Mobile app presence at `apps/mobile/` | UNCLEAR maturity — not audited | ⚠ UNCLEAR | **POTENTIAL FALSE ENTERPRISE** if marketed externally without audit. |
| 13 | Investigation hub (graph / duplicates / timeline / relationships / reviewers) | UNCLEAR depth — 5 sub-pages exist | ⚠ UNCLEAR | Audit required before customer demo. |
| 14 | Integrations page (`/integrations`) | UNCLEAR — not deeply audited | ⚠ UNCLEAR | Audit required. |
| 15 | "Cross-browser support" if claimed externally | NOT formally validated (R11 §3) | ❌ CLAIM-RISK | Do NOT claim "supports all major browsers" — claim "Chrome supported; Safari/Firefox NEEDS_VALIDATION." |
| 16 | "WCAG accessible" if claimed externally | NOT formally validated (R11 DEF-056) | ❌ CLAIM-RISK | Do NOT claim WCAG without R11.1 conformance audit. |

**False enterprise count: 3 confirmed audit-gaps (#12-#14), 2 claim risks (#15-#16). 13 surfaces are genuine.**

---

# H. FULL REMEDIATION ROADMAP

Six phases, ordered by risk-adjusted enterprise value.

## Phase 1 — Correctness & broken flows (~2 weeks; UNBLOCKS single-customer pilot)

1. **DEF-043** — Wrap SAML SSO callback in `prisma.$transaction`. ~1 day. Tests pin atomic boundary.
2. **DEF-044** — Mirror E10.1 Stripe pattern for PayPal: `PaypalWebhookEvent` table + UNIQUE `paypal_event_id` index. ~1 day. Tests pin re-fire dedup.
3. **DEF-002** — Ops + first pilot customer walk runbook 19 (SAML IdP rehearsal). Customer-coordinated.
4. **DEF-003** — Ops walks runbook 18 (production secret audit). Internal.
5. **Audit `apps/mobile/`** — bounded scope inventory: what is shipped vs what is prototype. Mark each capability HONESTLY.
6. **Audit `/investigation/*` + `/integrations`** — verify feature depth; flag false enterprise where applicable.

## Phase 2 — Missing frontend coverage (~3 weeks; STARTS multi-customer pilot work)

1. **DEF-046** — Document OWNER MFA break-glass procedure (platform-admin level; mandatory audit event + customer notification). New runbook + SecurityEvent.
2. **DEF-036** — Per-team AI capability gate (`AI_USE` cap key) + admin toggle on `/teams/[id]`.
3. **DEF-019** — `notification_delivery_failed` SecurityEvent emission on terminal FAILED.
4. **DEF-035** — `ai_provider_error`, `ai_schema_validation_failed`, `ai_policy_blocked` SecurityEvents.
5. **DEF-018** — `external_review_blocked_by_legal_hold` SecurityEvent on denial.
6. **DEF-017 / DEF-020** — Discussion moderation SecurityEvents.

## Phase 3 — Usability / workflow improvements (~3 weeks; ENTERPRISE pilot polish)

1. **DEF-054** — Ship canonical `Table` + `ErrorState` primitives in `ui.tsx`; migrate evidence library + reviewer queue under R10 + R11 contracts.
2. **DEF-055** — Mobile degradation for reviewer queue + analytics tables (uses new `Table`).
3. **DEF-060** — Multi-tab edit conflict UX (409 Conflict handling + UI pattern).
4. **DEF-061** — Evidence-detail mobile horizontal scroll polish.
5. **DEF-007** — `providers.tsx` self-fetch removal (auth bootstrap re-architecture).

## Phase 4 — Enterprise controls (~4 weeks; PROCUREMENT readiness)

1. **DEF-058 / R11.1** — Playwright installation + axe-core CI + per-surface cross-browser walk + WCAG AA conformance audit + remediation log + certification artifact. ESSENTIAL for procurement.
2. **DEF-056 / DEF-057** — Folded into R11.1.
3. **DEF-024 / 031 / 032** — Retention worker for SecurityEvent + external grants + intake links (per-team retain-days policy).
4. **DEF-039** — Per-IP rate limits on 7 remaining unauthenticated surfaces.
5. **DEF-040** — `OPENAI_API_KEY` required at startup when AI enabled (production config validator).
6. **DEF-041** — Daily Stripe subscription state reconciliation worker.
7. **DEF-042** — Reject localhost in DATABASE_URL / REDIS_URL + `sk_test_*` in Stripe in production.
8. **DEF-048** — Search indexing lag SLA + `search_indexing_lag_exceeded` SecurityEvent.
9. **DEF-049** — Move AI cost-guard counter to Redis or DB (crash-survival).
10. **DEF-047** — Explicit Puppeteer page.setDefaultTimeout + per-call timeouts.
11. **DEF-026** — Application-level graceful shutdown drain for in-flight webhook deliveries.
12. **DEF-027** — In-band signing-key rotation with grace window.
13. **DEF-045** — Capability resolver cache TTL + invalidation hook.
14. **Sentry deep audit** — PII redaction, release tracking, user-id attribution, alerting policy.

## Phase 5 — Design system overhaul (~6 weeks; COMPETITIVE PARITY with Stripe/Linear)

1. **CR4.1** (DEF-052) — Verify decomposition continuation: extract 10 named components from verify monolith.
2. **CR5 follow-on** (DEF-053) — Page-level capture presentation extraction (under 888-case CR5 contract).
3. **Mass CSS consolidation** — explicit scope: NOT mentioned in any prior phase as required, but needed for visual coherence. ~20,000 LOC of CSS today; target ~10,000 LOC. **Risky; requires its own bounded entry-gate.**
4. **DEF-050 / 051** — Destruction TOCTOU close + per-policy auto-extension window.

## Phase 6 — Competitive differentiation (~ongoing; CATEGORY LEADERSHIP)

1. **Operational transparency as marketing** — convert E10.2 honest-scores assessment + 32-runbook set into a public-facing "Operational Transparency" surface (extension of Trust Center).
2. **Honest trust-language as differentiator** — convert the 1,432-case contract into customer-facing "what PROOVRA will never claim" page.
3. **Mobile-first delegated-capture vertical** — if positioning competes with Truepic-style: invest in `apps/mobile/` properly OR explicitly cede that vertical.
4. **API exposure expansion** — current automation runtime is enterprise-grade but not externally productised. Bounded phase to ship public API SDK + developer docs.
5. **Audit-log SecurityEvent stream as customer-facing API** — currently DEF-024 tracks retention; could become a billable "Compliance API" tier.

---

# DETAILED SECTIONS — Per-prompt Section coverage

## SECTION 1 — Backend Capability Audit

### Production-ready (✅)

- **Evidence capture / upload / finalize** — `routes/capture.routes.ts` 18,308 bytes byte-pinned. CR5 888-case safety contract. Multipart resumable; verify-on-server-side hash.
- **Custody chain** — `services/custody-events.service.ts` 4,446 bytes pinned. `appendCustodyEventTx` with advisory lock + sequential hash chain. Single writer.
- **TSA / OTS** — `services/timestamp.service.ts` 6,033 bytes pinned. 20s TSA timeout; OTS 1h retry.
- **`completeEvidence`** — `services/evidence-complete.service.ts` 41,849 bytes pinned. Single-writer tx; emits custody event inside same tx.
- **MFA stack (R8.1.1 → R8.1.9)** — TOTP + login MFA + org policy + admin lifecycle + recovery quorum + digest + signed snooze + admin event feed. Mature.
- **Auth — email/password** — Per-IP rate limit (E10.1 DEF-037 closed). Enumeration semantics preserved.
- **Stripe webhook** — E10.1 DEF-038 closed. `StripeWebhookEvent` table + UNIQUE index.
- **Automation runtime (E3 → E3.3)** — DB-backed scheduler + bounded retries + auto-disable + 6 lifecycle events + 7 action handlers. Mature.
- **Webhook delivery (E3.2 + E3.3)** — HTTPS-only + 3-layer SSRF protection + HMAC-SHA256 + 32 KiB payload cap + per-team cap + retry runtime. Mature.
- **Analytics (E4)** — 5 source-traced endpoints under `/v1/analytics/*`.
- **DR runbooks (E6 + E10 + E10.1 + E10.2)** — 32 operational runbooks covering every documented failure mode.

### Partially implemented (⚠)

- **SAML SSO** — Code-shape complete; not yet end-to-end-validated against real IdP (DEF-002). SP request signing exists schema-side but private-key plumbing not applied (DEF-001). Callback NOT transactional (DEF-043 P0).
- **PayPal billing** — Per-event idempotency missing (DEF-044 P0).
- **Adaptive auth break-glass** — No OWNER lockout escape if all factors lost (DEF-046).
- **AI cost-guard** — In-memory; brief overspend on crash (DEF-049).
- **Retention auto-extension** — Hardcoded 7d window (DEF-051).

### Backend-only (no obvious frontend exposure)

- **Webhook destination admin UI** — Exists in `/ops/automation` per E3.2 docs; but discoverability for non-ops users is unclear.
- **SecurityEvent stream** — Backend rich (multiple event vocabularies); user-facing audit log surface is admin-only.

### Dead / duplicated code

- CR1 (R-CR phase) already purged legacy `audit.routes.ts` + `webhook.routes.ts` + auditMiddleware + 5 orphan services. Master registry §3 lists this work.
- No NEW dead code identified in this audit; the CR1 series cleaned the obvious cruft.

### Dangerous backend assumptions

- **Browser hash MUST be the canonical hash** — NOT an assumption; CR5 contract pins that server recomputes. Safe.
- **Stripe webhook from Stripe IP** — Stripe doesn't publish IP allowlist for webhooks; signature verification is the truth gate.
- **DATABASE_URL / REDIS_URL not localhost-in-prod** — DEF-042 documents this as an open gap. Production-config validator should reject.

### Misleading logic

- None identified in this audit beyond what E10.2 already flagged (DEF-043, DEF-044, DEF-050).

## SECTION 2 — Frontend Coverage Audit

Per the matrix in Output C, the per-page picture:

- **Fully visible + usable:** Evidence capture, evidence detail, governance hub + sub-pages, settings, billing, login/MFA, Trust Center, reviewer ops, governance retention/destruction/notifications/policy/lifecycle/analytics, public verify, external intake, external review (token surfaces), notifications, automation, analytics, admin runtime.
- **Partially visible:** Investigation hub (UNCLEAR depth per sub-page), Integrations (UNCLEAR maturity), Communications (Twilio; queue resilience gap).
- **Hidden/backend-only:** Some SecurityEvent vocabularies have no admin filter UI; webhook destination admin discoverability low for non-ops users.
- **Visually present but unusable:** None confirmed in this audit, but `/investigation/*` + `/integrations` carry UNCLEAR markers — REAL audit required before customer demos.
- **Broken wiring:** None observed in the validation runs (9,817 API tests pass; web build produces all 94 routes).
- **Duplicated / confusing:** Per R10 audit: 3+ card systems, 4+ table shapes, 2+ modal patterns. Genuine UX cost.
- **Dead UI:** None confirmed.
- **Inaccessible workflow:** Mobile operator surfaces explicitly DOCUMENTED_LIMITATION (per R11 §3 + §8); reviewer queue keyboard-only walk NOT formally validated (deferred to R11.1).

## SECTION 3 — Feature Usability & Reachability

- **Discoverability:** 32.8 IA-consolidation pinned 6 canonical primary navigation items. Discoverability for operator-tier is acceptable. Public surfaces (verify, intake, trust) are direct-URL + QR + email-link discoverable.
- **Clear CTA:** R10 audit §4 flags 10 inconsistent patterns including "action bars" — different surfaces use different CTA conventions. Real UX cost.
- **Loading / success / error states:** R10 §10 inventoried 14 state types; canonical-state coverage is partial. `EmptyState` + `Skeleton` from `ui.tsx` are canonical; error-state hand-rolled per surface (DEF-054).
- **Edge cases:** CR5 + CR4 contracts pin upload-interruption and verify-degraded states. Other surfaces — unclear without per-surface walk.
- **Permission / workspace state:** PageRouteGate coverage ≥ 80% (R10 Group 11).
- **Terminology:** E5 trust language + E7 persona content + E8 external content + E9 AI content are CANONICAL. Operator surfaces still hand-construct some terminology (DEF-054 follow-on).
- **Misleading trust/legal claims:** ✅ Pinned across CR4 + R10 + R11 by 1,432-case forbidden-pattern contract.

## SECTION 4 — Evidence Platform Workflow Audit

Walkable end-to-end. Friction concentrations:

- **Onboarding:** Persona-aware (E7) but 7 persona choices. May feel like a quiz.
- **Capture:** Documented operator-desktop-first (R11 DOCUMENTED_LIMITATION).
- **Finalize/sign:** Tightly bounded by CR5 contract. User-facing affordance is clear ("Finish & sign" CTA wired to single backend endpoint).
- **Reviewer workflows:** Dense; mobile-degradation gap (DEF-055).
- **Reports:** Generation is async (BullMQ); polling is read-only (no fake REPORT_DOWNLOADED — CR5 contract).
- **Public verify:** Strong technical depth; presentation monolith (DEF-052).
- **AI assistance:** Bounded-advisory; failure-tolerant; no autonomy. Per E9 contract.
- **Settings:** Standard.
- **Admin flows:** Mature for current scope; runbook 18/19 pending Ops walk.
- **Support/help:** ContextualHelp mounted on 7+ surfaces (38.x rollout); coverage incomplete on long-tail surfaces.

**Missing steps:** None confirmed in critical flows.
**Confusing transitions:** Capture → Verify hand-off (user must navigate via share-path; not always obvious from finalize CTA).
**Hidden actions:** Webhook destination admin (low discoverability for non-ops).
**Misleading UX:** None confirmed (E5 forbidden-pattern guard active).
**Legal/forensic risk:** None confirmed.

## SECTION 5 — Enterprise Readiness Audit

Per E10.2 honest scoring (unchanged after R10 + R11):

| Dimension | Score | Why |
|---|---|---|
| Permissions / RBAC | 9/10 | Capability resolver + PageRouteGate + per-route gates. DEF-045 minor cache TTL gap. |
| Workspace isolation | 9/10 | Team-scoped queries; CR1 audit purged orphan routes. |
| Audit trail correctness | 9/10 | Custody chain hash-chained + advisory-locked. Coverage gaps (DEF-017 to DEF-020 / DEF-030) are honest. |
| Custody integrity | 10/10 | Single-writer; hash-chained; verifiable. |
| Evidence immutability | 10/10 | S3 Object Lock when configured; retention policy version snapshots immutable. |
| Timestamp / TSA / OTS | 9/10 | Honest "STAMPED / FAILED / UNAVAILABLE" + "PENDING / ANCHORED / FAILED / UNAVAILABLE" vocabulary. |
| Retry / recovery | 9/10 | Bounded retry runtime; auto-disable after 10; documented in 32 runbooks. |
| Access logging | 8/10 | SecurityEvent stream comprehensive; some pre-existing gaps. |
| Reliability | 9/10 | E10.2 audit. |
| Observability | 7/10 | Sentry CONFIGURED (web + api + worker) but configuration depth NOT audited end-to-end. |
| Error handling | 7/10 | Per-surface hand-rolled; canonical ErrorState deferred (DEF-054). |
| Abuse prevention | 8/10 | E10.1 rate limits; E10 DEF-039 remaining gaps. |
| Plan enforcement | 9/10 | `PLAN_CAPABILITIES` + per-surface gating verified. |
| Security posture | 8/10 | Multi-layer; HMAC webhooks; SSRF protection; legal-hold-blocks-destruction at 3 layers. |
| Storage semantics | 9/10 | Provider-managed (R2/S3) + Object Lock optional. |
| Compliance language | 10/10 | E5 + CR4 + R10 + R11 forbidden-phrase guard. |
| Exportability | 8/10 | Verification package generation; report download. |
| Enterprise trustworthiness | 7/10 | UI polish gap undermines the strong backend signal. |
| Legal safety | 9/10 | E5 contract + Trust Center + per-surface forbidden-phrase guard. |
| Operational maturity | 9/10 | 32 runbooks; honest scoring; CR1.7 phase registry. |

**Average: 8.5 / 10.** The platform IS enterprise-mature in operations + governance + custody + trust language. The 1.5-point gap is concentrated in UI consistency (R10 deferred items) + browser/a11y certification (R11.1) + operational hygiene (DEF-024 through DEF-051).

**Fake enterprise UX:** None confirmed.
**Weak trust signals:** Verify token page monolith makes the trust signals harder to read than they should be (DEF-052).
**Overclaiming:** None confirmed; explicit E5 + R10 + R11 forbidden-phrase contracts prevent.
**Inconsistent terminology:** R10 §8 inventoried metadata hierarchy inconsistency; bounded but real.
**Hidden operational risk:** None hidden — DEF-001 through DEF-063 catalogued in master registry §6.
**Dangerous assumptions:** None beyond documented (DEF-042 production config validator gap).

## SECTION 6 — State Consistency Audit

- **Verification states (TSA / OTS):** Pinned vocabulary across CR4 + R10 + R11. Consistent.
- **Integrity states:** "Recorded integrity verified" canonical phrase pinned by CR4 Group 3.
- **Timestamps:** `formatUserDateTime` helper exists but not universally consumed (R10 §7). Some surfaces show absolute UTC + relative; some only one. Bounded inconsistency.
- **Report readiness:** Polling is read-only (CR5 + CR4 contracts).
- **Evidence lifecycle:** Single-writer governance orchestrator. Verified ✅ SOUND in E10.2.
- **Custody counts:** Forensic vs access category split pinned by CR4 Group 10 + CR5 audit. NEVER mixed.
- **Status badges:** R10 audit §4.4 flags 3+ badge systems. Bounded inconsistency (DEF-054).
- **Counters:** Source-traceable via E4 analytics contract.
- **Frontend/backend sync:** No silent client-side mutation of server state confirmed. CR5 + CR4 pins enforce.

**Mismatched states:** None confirmed.
**Stale UI:** DEF-011 focus-refresh helper available; not enabled in prod (Ops cadence).
**Contradictory statuses:** None observed.
**Duplicated truth sources:** Capture session items + upload progress are single-owner (CR5 contract).
**Incorrect badge logic:** Not observed.
**Misleading verification representation:** Forbidden by 1,432-case contract.

## SECTION 7 — Dead UI Audit

- **Dead buttons:** None confirmed in CR4/CR5/R10 contracts.
- **Fake statistics:** E4 analytics pins source-traceability per metric. Zero fake metrics.
- **Placeholder cards:** None confirmed.
- **Decorative widgets:** None confirmed.
- **Empty tabs:** UNCLEAR for `/investigation/*` sub-pages (5 routes, depth not individually audited).
- **Duplicated navigation:** 32.8 IA pinned 6 canonical primaries. No duplication.
- **Non-functional filters:** UNCLEAR for `/investigation/*`.
- **Misleading controls:** None confirmed.
- **Unused settings:** UNCLEAR.
- **Inactive CTAs:** None confirmed.
- **Orphan pages/components:** CR1 series purged orphans; no new orphans introduced since.

## SECTION 8 — Empty / Error / Edge Case Audit

- **Empty workspaces:** Per persona-aware onboarding (E7), seeded with first-action prompts.
- **No evidence:** EmptyState primitive available.
- **Failed uploads:** CR5 Group 1 contract enforces "failed cannot finalize"; user sees error message after exhausting retries.
- **Partial uploads:** Resumable upload pipeline survives (CR5 contract).
- **Pending reports:** Polling shows status; honest "in progress."
- **Missing timestamps:** TSA status = UNAVAILABLE.
- **OTS pending:** OTS status = PENDING; honest copy via runbook 31.
- **TSA unavailable:** TSA status = UNAVAILABLE; honest copy via runbook 30.
- **Revoked permissions:** RBAC re-check at every request.
- **Expired sessions:** 401 → re-auth redirect.
- **Deleted evidence:** Backend lifecycle handles; legal hold blocks at 3 layers.
- **Broken artifacts:** Report/package generation has per-job retry + error states.
- **Missing metadata:** Per-evidence type + safe defaults.
- **Unsupported formats:** Capture session validates MIME; backend re-validates.

**Messaging clarity:** Per R10 §10 inventory, inconsistent across surfaces (DEF-054).
**Recovery paths:** Generally present.
**Retry paths:** Present at upload + automation runtime + webhook delivery.
**Enterprise trust preservation:** Forbidden-phrase guards active.

## SECTION 9 — Security & Abuse Surface

Per E10.2 audit §3 cross-cutting hard rules (all verified):

- Billing never corrupts evidence ✅
- Billing never mutates custody ✅
- Billing never breaks immutable retention ✅
- Storage quota never auto-deletes evidence ✅
- Lifecycle is single-writer ✅
- Legal hold blocks destruction at every layer (with DEF-050 TOCTOU caveat) ✅
- Custody chain is append-only ✅
- AI never mutates evidence / custody / governance ✅ (E9 contract test)
- External participants never enter capability resolver ✅ (E8 contract)
- Capability registry has zero persona / external-participant / AI input ✅

**Active risks:**

- DEF-043 (SSO callback transaction) — P0
- DEF-044 (PayPal idempotency) — P0
- DEF-028 (external reviewer-redemption no rate limit)
- DEF-029 (external review no kill switch)
- DEF-030 (external responder no SecurityEvent)
- DEF-033 (AI input-side sanitisation gap; output filter intact)
- DEF-038 closed (Stripe webhook idempotency landed E10.1)
- DEF-039 (per-IP throttle gaps on 7 surfaces)

**Public verify abuse:** Token-hashed (HMAC-SHA256), eager revocation + expiry, anti-enumeration deny code. Bounded.
**Audit trail manipulation:** Frontend cannot import custody-write primitives (CR5 Group 7 pin).
**Trust manipulation vectors:** Forbidden-phrase guards active across 1,432 cases.

## SECTION 10 — UI / UX & Design System Audit

Per R10 audit + R11 audit:

- **Landing / marketing pages:** Trust Center (`/about/trust`) + landing exist. Marketing pages NOT separately audited in any prior phase; UNCLEAR.
- **Dashboards:** Multi-page (insights, batch-analysis, api-keys, quotas, home). Persona-aware (E7).
- **Capture:** 1,429-LOC orchestrator; CR5-pinned.
- **Evidence:** Library + detail; CSS in evidence-library.css (652 LOC) + evidence-detail.css (792 LOC).
- **Verify:** 7,273-LOC monolith; CR4-pinned.
- **Reports:** Reports index + per-evidence report status; bounded.
- **Cases:** `/cases` + `/cases/[id]`; bounded.
- **Settings:** Multi-page (profile / persona); bounded.
- **Mobile behavior:** Operator surfaces explicitly DOCUMENTED_LIMITATION.

**Hierarchy:** Per-page; consistent within hubs.
**Spacing:** R10 §14.3 documents the `--proovra-space-*` token scale; inline pixel-literal values are drift candidates.
**Typography:** R10 §7 inventoried inconsistency. CSS custom properties + heading hierarchy mostly consistent.
**Density:** Density-aware CSS rolled out on canonical surfaces (38.17/18); not enforced on reviewer queue / governance retention / analytics / admin.
**Navigation:** 32.8 IA-consolidated to 6 primaries.
**Consistency:** R10 audit's 10 inconsistent-patterns inventory.
**Enterprise feel:** Mid-tier. Operationally serious, visually inconsistent.
**Operational feel:** Strong on hub pages, weaker on long-tail.

**Visual identity verdict:** Reads as "operationally serious SaaS" — not as Stripe/Linear polish, not as Truepic/Cellebrite forensic UI, not as crypto/AI startup. **The visual identity is somewhere between "fintech back-office" and "enterprise SaaS template."** Closer to fintech back-office.

## SECTION 11 — Product Identity Audit

**What PROOVRA visually + operationally feels like RIGHT NOW:**

- **Genuine signal:** A serious operations platform with strong custody + governance + audit semantics.
- **Mixed signal:** Some surfaces feel like generic enterprise SaaS; others (capture, verify, governance) feel domain-specific.
- **NOT signal:** Does NOT feel like a forensic acquisition tool (Cellebrite). Does NOT feel like a mobile-first capture tool (Truepic). Does NOT feel like a crypto/web3 product (good — that would undermine the trust posture). Does NOT feel like an AI startup (good — E9 bounded AI keeps the platform's trust posture clean).

**Identity confusion:**
- The brand name PROOVRA is unambiguously about proof / verification, but the dashboard surfaces lean operations-platform rather than evidence-infrastructure-platform.
- The Verify page is the ONE surface that genuinely communicates "evidence verification infrastructure"; everywhere else, the platform reads as "operations + governance SaaS."

**Positioning weakness:**
- The 32-runbook operational set + honest-scores assessment + 1,432-case trust-language contract are STRONG differentiators that are NOT visible to a customer evaluating the dashboard.
- A new visitor wouldn't realize PROOVRA's primary differentiator is operational honesty + trust-language discipline.

**Unclear messaging:**
- Trust Center page (E5) is strong but a one-time read; daily operator surfaces don't reinforce the trust posture.

**Missing operational cues:**
- No persistent "this is recorded as an audit event" affordance on operator surfaces. Custody chain is invisible until you specifically open it.

## SECTION 12 — Competitive Benchmark Audit

See Output F. Conceptual comparison only (no invented competitor capabilities).

**Where PROOVRA is stronger:**
- Trust-language honesty (1,432-case contract).
- Operational runbook depth (32 runbooks).
- Per-phase honest scoring (no inflation).
- Single-writer custody chain.

**Where PROOVRA is weaker:**
- UI polish vs Stripe/Linear/Vercel.
- Mobile-first vs Truepic.
- Forensic-grade chain-of-custody vs Cellebrite (but PROOVRA's chain is real; the gap is positioning).
- Formal browser + WCAG certification.
- Onboarding friction (7 personas).

**What competitors likely do better:**
- Stripe-grade external API SDK + developer docs.
- Linear-grade keyboard-first operator UX.
- Truepic-grade mobile capture flow.
- Vercel-grade dashboard polish + dark mode.

**What PROOVRA must improve to compete seriously:**
- Browser + WCAG certification (R11.1).
- Mobile operator UX OR explicit positioning as desktop-first enterprise tool.
- Customer-facing operational transparency (extension of E5 Trust Center).
- Public API SDK if competing in developer/automation vertical.

## SECTION 13 — False Enterprise Detection

See Output G. 3 confirmed audit-gaps + 2 claim-risks + 13 genuine surfaces.

## SECTION 14 — Page-by-Page Enterprise Competitive Benchmark

| Page / system | Maturity /10 | Enterprise /10 | Operational /10 | Competitive /10 | Biggest weakness | Biggest opportunity |
|---|---|---|---|---|---|---|
| **Dashboard** (home + insights + batch-analysis + api-keys + quotas) | 7 | 7 | 8 | 6 | Visual inconsistency across sub-pages | Persona-driven layout already exists (E7); ship a "compliance officer" / "investigator" template per persona |
| **Capture** | 7 | 8 | 9 | 7 | 1,429-LOC monolith; mobile-degradation | DEF-053 follow-on |
| **Evidence detail** | 7 | 7 | 8 | 6 | Mobile horizontal scroll (DEF-061); no canonical Table | DEF-054 |
| **Evidence list (library)** | 6 | 6 | 7 | 5 | No canonical Table primitive; per-surface card-grid | DEF-054 |
| **Cases** | 6 | 7 | 7 | 6 | Multi-tab edit conflict (DEF-060); table inconsistency | DEF-054 + DEF-060 |
| **Teams / workspaces** | 7 | 8 | 8 | 7 | Legacy teams modal `position:fixed` (R11 allowlisted; DEF-054 follow-on) | Polish |
| **Review workflows** (reviewer ops) | 8 | 9 | 9 | 7 | Mobile degradation (DEF-055) | Single biggest enterprise-pilot value-add |
| **Verification flows** | 8 | 9 | 9 | 8 | None critical (backend strong) | Convert backend strength into UI signal |
| **Public verify** | 7 | 8 | 9 | 7 | 7,273-LOC monolith | DEF-052 |
| **Reports** | 7 | 8 | 8 | 7 | Puppeteer no explicit timeout (DEF-047) | Polish |
| **Verification package** | 8 | 9 | 9 | 8 | Bounded — strong | Marketing surface (Trust Center extension) |
| **Search / filter** | 6 | 7 | 7 | 5 | SLA alert missing (DEF-048); UI not deeply audited | Bounded audit |
| **Activity / audit logs** | 6 | 7 | 8 | 5 | Backend-rich; admin-only UI surface | Could become customer-facing "Compliance API" |
| **Settings** | 7 | 8 | 8 | 7 | DEF-007 providers self-fetch | Polish |
| **Billing / plans** | 7 | 8 | 8 | 7 | PayPal idempotency (DEF-044 P0); Stripe drift detection (DEF-041) | Closure |
| **AI assistant** | 7 | 8 | 8 | 7 | Per-team gate missing (DEF-036); 4 follow-on DEFs | Bounded follow-on |
| **Notifications** | 6 | 7 | 7 | 6 | DEF-019 + DEF-014 (demo webhook empty) | Bounded |
| **Mobile experience** | 4 | 5 | 5 | 3 | DOCUMENTED_LIMITATION; `apps/mobile/` UNAUDITED | Strategic decision required |
| **Navigation / sidebar / topbar** | 8 | 8 | 8 | 7 | 32.8-consolidated; mature | Visual polish |
| **Onboarding** | 7 | 7 | 7 | 6 | 7-persona quiz friction | Default-path with optional persona pick |
| **Investigation hub (5 sub-pages)** | UNCLEAR | UNCLEAR | UNCLEAR | UNCLEAR | NOT AUDITED INDIVIDUALLY | Bounded per-sub-page audit |
| **Integrations** | UNCLEAR | UNCLEAR | UNCLEAR | UNCLEAR | NOT AUDITED INDIVIDUALLY | Bounded audit |
| **Trust Center** | 9 | 10 | 9 | 9 | Could be more daily-prominent | Convert to category-leadership marketing |

**Strongest enterprise-ready pages (ranked):**
1. Trust Center (E5)
2. Verification flows (backend)
3. Reviewer workflows (E10.2 ✅ SOUND)
4. Verification package
5. Public verify (content strong; presentation monolith)
6. Navigation / sidebar / topbar (32.8-consolidated)
7. Teams / workspaces
8. Capture (CR5-pinned + safe)
9. Reports
10. Billing / plans
11. AI assistant (E9-bounded)
12. Settings
13. Onboarding
14. Dashboard
15. Evidence detail
16. Cases
17. Evidence list
18. Search / filter
19. Activity / audit logs
20. Notifications
21. Investigation hub (UNCLEAR)
22. Integrations (UNCLEAR)
23. **Mobile experience (weakest; documented limitation; `apps/mobile/` unaudited)**

## SECTION 15 — Real User Simulation

| User type | Likely friction | Likely abandonment trigger | Trust failure point |
|---|---|---|---|
| Investigator | Capture → finalize flow works; reviewer queue is dense (familiar); finds Trust Center if they look. | Mobile capture (if field-based) → desktop-first warning. | None critical. |
| Insurance adjuster | Evidence library + reports works. | Bulk-action UX on evidence list (DEF-054). | Could over-read "VERIFIED" badges. |
| Journalist | Public verify page + Trust Center are strong. | Mobile usability if working in field. | None critical. |
| Legal reviewer | Trust Center clear about boundaries. Verify page is detail-rich. | 7,273-LOC verify page on first read can be overwhelming. | None critical — but could WANT more "what this report is NOT" boilerplate. |
| Enterprise admin | Settings + teams + billing + SAML SSO. | DEF-043 P0 if SSO; DEF-002 if first-time IdP setup. | SSO orphan-user is operationally visible. |
| Team member | Standard role; works. | If invited but RBAC doesn't see them: rare but possible (capability resolver DEF-045). | Rare. |
| First-time user | 7-persona quiz at onboarding. | Persona-quiz friction. | None critical. |
| Stressed / mobile user | Operator surfaces desktop-first. | Mobile reviewer queue. | DOCUMENTED_LIMITATION not always in user-facing copy. |
| Non-technical user | Verify page content is good for non-tech readers; capture page may overwhelm. | Capture page density. | None critical. |

**Where users would likely fail:**
- Mobile-only operator (documented).
- First-time SAML setup without runbook 19 (DEF-002).
- Field investigator on iOS Safari with long upload (DEF-059).

**Where users would lose trust:**
- If any P0 (SSO orphan, PayPal double-capture) occurs in production before fix.
- If formal procurement asks for WCAG / browser certification and gets honest "in progress" answer.

**Where users would misunderstand evidence/integrity concepts:**
- Possible but bounded — E5 Trust Center + per-surface forbidden-phrase guard mitigate.

**Where enterprise buyers would reject the platform:**
- Formal WCAG-AA requirement (DEF-056).
- Formal multi-browser certification requirement (DEF-058).
- Mobile-heavy intake population (DOCUMENTED_LIMITATION + apps/mobile UNCLEAR).
- Required SSO before pilot (DEF-002 + DEF-043).

## SECTION 16 — Scale & Operational Complexity

E10.2 audit assessed all 25 subsystems on stuck-job risk. Results:

- Reviewer-reconciliation worker: ✅ (storm-detection + bounded batch).
- Webhook delivery: ✅ (sweeper recovers stuck).
- Automation run: ✅ (`/v1/automation/runs?status=RUNNING` operator filter; manual force-fail with reason).
- External grants / intake links: ⚠ (no GC worker; DEF-031/032).
- Report queue: ✅ (per-job timeout via BullMQ + DEF-047 Puppeteer hardening pending).
- OTS upgrade: ✅ (1h retry; bounded by Bitcoin anchoring rate).
- TSA: ✅ (20s timeout).
- Stripe webhook: ✅ (E10.1 idempotency).
- Search indexing: ⚠ (no SLA / alert; DEF-048).

**UX collapse points at scale:**
- Reviewer queue at 10,000+ items: UNCLEAR — no canonical Table primitive; current implementation may degrade.
- Analytics tables at full year window (180 days): no per-table audit.
- Long custody timelines: Verify page render of 1,000+ events: UNCLEAR.

**Performance bottlenecks:** None measured (no Lighthouse run; deferred to R11.1).

## SECTION 17 — Production Failure & Recovery

Per 32 runbooks (E6 + E10 + E10.1 + E10.2). Coverage:

| Failure | Runbook | Status |
|---|---|---|
| DB restore | 01 | ✅ |
| Object storage restore validation | 02 | ✅ |
| Worker restart | 03 | ✅ |
| Automation runtime recovery | 04 | ✅ |
| Webhook retry recovery | 05 | ✅ |
| Signing-key recovery | 06 | ✅ |
| Degraded-mode startup | 07 | ✅ |
| Audit/custody continuity validation | 09 | ✅ |
| 10–17 (support runbooks) | 10–17 | ✅ |
| Production secret audit | 18 | ✅ runbook; ⚠ NOT WALKED (DEF-003) |
| SAML pilot rehearsal | 19 | ✅ runbook; ⚠ NOT WALKED (DEF-002) |
| Reviewer queue failure | 20 | ✅ |
| Immutable storage drift | 21 | ✅ |
| Billing provider outage | 22 | ✅ |
| PayPal webhook recovery | 23 | ✅ |
| Resend email failure | 24 | ✅ |
| Twilio failure | 25 | ✅ |
| Redis outage | 26 | ✅ |
| Search index recovery | 27 | ✅ |
| Retention job failure | 28 | ✅ |
| Governance reconciliation | 29 | ✅ |
| TSA provider failure | 30 | ✅ |
| OTS anchor delay | 31 | ✅ |

**User messaging during failure:** Bounded; honest per-evidence status (per E10.2 ✅ SOUND row).
**Retry behavior:** Bounded across all async surfaces.
**Trust preservation:** Failed = explicit "FAILED" status, not silent.
**Audit correctness:** Custody chain integrity preserved through failures.
**Data integrity:** No silent corruption paths identified.
**Operational recovery UX:** Strong (32 runbooks).
**Enterprise confidence during failures:** HIGH (honest degraded states, no fake success).

## SECTION 18 — Enterprise Procurement & Trust

**Trustworthy?** YES on backend; PARTIAL on UI.
**Operationally mature?** YES (E10.2 honest 8/10 + 32 runbooks).
**Terminology legally careful?** YES (1,432-case forbidden-phrase contract).
**UI enterprise-grade?** PARTIAL (R10 7/10 visual governance).
**Reliable under pressure?** UNCLEAR — no real-world load testing in this session.
**Real operational platform vs ambitious prototype?** **REAL OPERATIONAL PLATFORM with prototype-level UI polish.**

**Trust-breaking UX:** None confirmed.
**Weak operational signals:** Visual inconsistency across surfaces.
**Immature workflows:** Investigation hub + Integrations UNCLEAR.
**Fake enterprise visuals:** None confirmed.
**Unsupported enterprise claims:** None — every claim has a contract pin.
**Missing controls expected by enterprise buyers:**
- Formal WCAG certification artifact
- Formal multi-browser certification report
- SOC 2 / ISO audit (NOT claimed; per E5 contract)
- Customer-facing audit log API
- SAML SSO production reference customer

**"Would a serious enterprise realistically trust and purchase this platform today?"**

| Tier | Verdict | Why |
|---|---|---|
| Single-customer pilot, hand-walked | **YES** | Operational depth + runbooks + honest scoring + pilot-ready code (with DEF-002/003 walked + DEF-043/044 closed). |
| Multi-customer pilot via formal pilot agreement | **NO until R11.1** | Cross-browser + WCAG gap blocks. |
| Open procurement (RFP, security review, ≥ $100K ARR) | **NO until R11.1 + 6 weeks clean pilot data + SOC 2 process started** | Procurement teams require formal certification evidence. |
| Open public launch | **NO** | Per CR1.7 + E10 + E10.2 explicit. |

## SECTION 19 — Infrastructure / Environment / Service Configuration

**`.env.example` present:** services/api, services/worker, apps/web, apps/mobile. Root `.env.example` absent (development uses per-package `.env`). **DEF-064 candidate:** root `.env.example` consolidation for new-dev onboarding.

| Service | Purpose | Required env vars (sample) | Risk level | Recommended action |
|---|---|---|---|---|
| Database / Prisma / Neon | Primary data store | `DATABASE_URL` | LOW (production validator partial; DEF-042 open) | Close DEF-042 |
| Redis | BullMQ + rate-limit | `REDIS_URL` | LOW (DEF-042 partial) | Close DEF-042 |
| BullMQ queues | Workers | Inherits Redis | LOW | — |
| Object storage | Evidence + reports + packages | `S3_ENDPOINT`, `S3_ACCESS_*`, `S3_BUCKET_*` | LOW (DEF-006 closed) | — |
| Upload signing | Multipart | Server-side; no env | LOW | — |
| TSA | Timestamping | `TSA_URL`, `TSA_USERNAME`, `TSA_PASSWORD`, `TSA_TIMEOUT_MS`, `TSA_ENABLED` | LOW | — |
| OTS | Bitcoin anchoring | OTS env | LOW | — |
| Email | Notifications | Resend config | LOW | — |
| Stripe | Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | LOW (E10.1 + DEF-012 closed) | — |
| PayPal | Billing alt | PayPal config | MEDIUM (DEF-044 P0) | Close DEF-044 |
| OpenAI | AI | `OPENAI_API_KEY`, `OPENAI_AI_ENABLED` | MEDIUM (DEF-040 not enforced at startup) | Close DEF-040 |
| Sentry | Monitoring | `SENTRY_DSN` (3 packages) | UNCLEAR (config depth not audited) | Audit 3 `sentry.ts` files |
| JWT / session | Auth | Session secrets | LOW | — |
| Domain / CORS / proxy | Edge | NEXT_PUBLIC env | LOW | — |
| Worker / API communication | Internal | Shared DB | LOW | — |
| Cron / scheduled | E3.3 + retention worker | DB-backed scheduler (no cron) | LOW | — |
| Webhooks | Automation | HMAC secrets per destination | LOW (E3.2) | — |
| File size limits | Capture | Per-file caps in capture.routes | LOW | — |

**Services used in code but not configured:** None observed.
**Services configured but not used:** None observed.
**Health checks:** `/admin/runtime/readiness` exists.
**Readiness checks:** ✅
**Worker health checks:** Via runtime readiness.
**Queue visibility:** `/admin/runtime/queues`.
**Retry monitoring:** E3.3 lifecycle events.
**Failed-job dashboard:** UNCLEAR — admin runtime surface, but per-job replay UX not audited.
**Deployment documentation:** UNCLEAR — DEF-064 candidate.
**New-developer setup:** UNCLEAR — README depth not audited.

## SECTION 20 — Playwright / Cypress End-to-End Plan

Per R11 audit: **Playwright and Cypress are NOT installed.** R11 explicitly defers to DEF-058 / R11.1.

**Highest-risk untested flows (P0 once Playwright installed):**

1. End-to-end capture: drag file → upload → finalize → custody event written → verify page loads with correct hash.
2. Resumable upload interruption recovery: pause mid-chunk → resume → finalize succeeds.
3. SAML SSO callback happy path + DEF-043 partial-failure path.
4. PayPal webhook idempotency: re-fire same event → no double-apply.
5. Public verify with ANCHORED state: load with QR-equivalent URL → all sections render.
6. Public verify with DEGRADED state (TSA UNAVAILABLE): all sections render with honest copy.
7. Reviewer queue at high item count: scroll + sort + filter + bulk-action.
8. Governance lifecycle: place hold → attempt destruction → destruction blocked at execution.
9. Long-session: 4-hour reviewer session without memory leak.
10. External intake redemption: load token URL → fill form → submit → server-side custody event.

**Recommended Playwright test files (R11.1):**
- `apps/web/e2e/auth/login-mfa.spec.ts`
- `apps/web/e2e/auth/sso-callback.spec.ts`
- `apps/web/e2e/capture/upload-finalize.spec.ts`
- `apps/web/e2e/capture/resumable-interruption.spec.ts`
- `apps/web/e2e/verify/public-verify.spec.ts`
- `apps/web/e2e/verify/degraded-states.spec.ts`
- `apps/web/e2e/reviewer/queue-scale.spec.ts`
- `apps/web/e2e/governance/legal-hold.spec.ts`
- `apps/web/e2e/billing/stripe-idempotency.spec.ts`
- `apps/web/e2e/billing/paypal-idempotency.spec.ts`
- `apps/web/e2e/external/intake-redemption.spec.ts`
- `apps/web/e2e/external/review-revocation.spec.ts`

## SECTION 21 — Lighthouse / Performance / A11y

**Cannot be run in this audit session.** R11 explicitly defers to DEF-058.

**To run Lighthouse later:**
```bash
pnpm --filter proovra-web build
pnpm --filter proovra-web start  # in one terminal
# Then in another:
npx lighthouse http://localhost:3000/about/trust --view --quiet --chrome-flags="--headless"
npx lighthouse http://localhost:3000/verify/<test-token> --view
npx lighthouse http://localhost:3000/dashboard --view  # requires auth
```

**Expected thresholds (enterprise):**
- Performance: ≥ 80 on `/about/trust`, ≥ 70 on operator surfaces.
- A11y: ≥ 90 across all surfaces.
- Best Practices: ≥ 90.
- SEO: ≥ 80 on public surfaces.

**Unacceptable for enterprise readiness:**
- Any A11y < 80 (treat as P0).
- Any major accessibility failure flagged by axe-core.
- Any contrast failure on operator surfaces.
- Any keyboard-trap on critical workflow.
- First Load JS > 250 kB on landing.

## SECTION 22 — Sentry / Monitoring / Observability

**Sentry IS installed** (`@sentry/browser` web, `@sentry/node` api + worker). Configuration files exist:
- `apps/web/lib/sentry.ts`
- `services/api/src/observability/sentry.ts`
- `services/api/src/services/observability/sentry-provider.ts`
- `services/worker/src/sentry.ts`

**NOT AUDITED in this session (HIGH PRIORITY DEF-065 candidate):**
- Is `SENTRY_DSN` required at startup when enabled?
- Are environment names correct (prod/staging/dev)?
- Are user IDs / workspace IDs attached safely (PII)?
- Is PII redaction configured (email / phone / hash data)?
- Are source maps uploaded safely (server-only, not exposed to public)?
- Are release versions tracked (git SHA in version field)?
- Are errors grouped meaningfully (fingerprinting)?
- Are alerts configured (Slack / email / PagerDuty integration)?

**Other observability:**
- `OperationalIncident` table exists.
- SecurityEvent stream rich (E10.2 confirmed 9+ vocabulary families).
- Per-error severity routing UNCLEAR (audit gap).
- Request-id / correlation-id usage UNCLEAR.
- Slow-endpoint tracking UNCLEAR.
- Frontend route-performance tracking UNCLEAR.
- Health checks: `/admin/runtime/readiness` exists.
- Queue depth: `/admin/runtime/queues` exists.

**Production blind spots possible:**
- PII in Sentry events if not redacted.
- AI provider errors (DEF-035 — no SecurityEvent emission).
- External-responder submissions (DEF-030).
- Notification delivery failures (DEF-019).
- Discussion moderation actions (DEF-020).

**P0 monitoring fixes before production:**
1. Audit Sentry PII-redaction config across 3 sentry.ts files.
2. Verify SENTRY_DSN environment-name segmentation.
3. Confirm release-version tracking (git SHA injection).
4. Define alert thresholds for queue depth + error rate.
5. DEF-035 — AI provider error SecurityEvent emission.

## SECTION 23 — Security / Exploitability

**OWASP-style categories:**

| Category | Status |
|---|---|
| Auth — session handling | ✅ MFA + adaptive auth; per-IP rate limits (E10.1) |
| Auth — token / cookie | ✅ JWT; secure cookies |
| Auth — logout / session expiry | ✅ |
| AuthZ — IDOR | ✅ Per-request RBAC; workspace-scoped queries |
| AuthZ — workspace boundary | ✅ Capability resolver + team-scoped Prisma queries |
| AuthZ — evidence access | ✅ Public verify gated by `publicVerifyState === "PUBLISHED"` |
| AuthZ — admin route exposure | ✅ Capability-gated |
| AuthZ — public/private artifact | ✅ Server-side mode resolution |
| Uploads — MIME validation | ✅ Browser + server validation |
| Uploads — file extension spoof | ✅ MIME re-check at multipart complete |
| Uploads — oversized files | ✅ Per-file caps in capture.routes |
| Uploads — path traversal | ✅ Server-generated storage keys |
| Uploads — public bucket exposure | ✅ Server-generated presigned URLs only |
| Uploads — presigned URL misuse | ✅ Per-chunk; short TTL |
| Public verify — token guessing | ✅ HMAC-SHA256 entropy + anti-enumeration deny code |
| Public verify — metadata exposure | ✅ `verify-projection.service.ts` 3,953 bytes pinned; bounded projection |
| Public verify — rate limit | ⚠ DEF-028 (similar issue on external review) — should audit |
| API — input validation | ✅ Zod schemas (most surfaces) |
| API — SSRF | ✅ E3.2 3-layer SSRF protection |
| API — injection | ✅ Prisma parameterised |
| API — CORS | ✅ Configured |
| API — CSRF | ✅ Token-based auth (not cookie-only) |
| AI — prompt injection | ⚠ DEF-033 (input-side gap; output filter intact) |
| AI — sensitive data leak | ✅ E9 metadata-only contract |
| AI — overclaiming | ✅ Forbidden-pattern guard |
| AI — cost abuse | ⚠ In-memory guard (DEF-049) |
| Billing — webhook signature | ✅ Stripe HMAC verified |
| Billing — plan bypass | ✅ Server-side enforcement |
| Infra — exposed env in bundle | ✅ NEXT_PUBLIC discipline (verify by audit) |
| Infra — secrets in frontend | ✅ |
| Infra — security headers | UNCLEAR — not audited |
| Infra — CSP | UNCLEAR — not audited |
| Audit / custody — forge events | ✅ Backend single-writer + frontend cannot import |
| Audit / custody — mutate after finalize | ✅ Immutable evidence after `completeEvidence` |
| Audit / custody — timestamp manipulation | ✅ Server-generated only (CR5 contract) |

**Top 10 most dangerous security risks (ranked):**

1. **DEF-043** — SSO callback non-transactional. P0.
2. **DEF-044** — PayPal idempotency missing. P0.
3. **DEF-042** — Production config validator gaps (DATABASE_URL / REDIS_URL localhost; sk_test_*). MEDIUM.
4. **DEF-046** — No OWNER MFA break-glass. MEDIUM.
5. **DEF-038 / 037** — Already closed (E10.1).
6. **DEF-033** — AI input-side prompt-injection sanitisation. LOW (output filter intact).
7. **DEF-028** — External reviewer-redemption no rate limit. LOW.
8. **DEF-050** — Destruction-review TOCTOU. LOW.
9. **Sentry PII** — UNAUDITED. Could be MEDIUM until audit.
10. **Security headers / CSP** — UNAUDITED. Could be MEDIUM.

**Recommended automated security tests:**
- DEF-058 / R11.1 should include axe-core + npm audit + Snyk-style dependency scanning.
- Add `pnpm audit` to CI.
- Add OWASP ZAP baseline scan to a future bounded phase.

---

# CLOSING

**This audit is intentionally not flattering.** The platform has genuine operational + governance + custody + trust-language strength that compares favorably to most enterprise SaaS. The visible weaknesses are concentrated in UI consistency, browser/a11y certification, and a few P0 backend gaps (DEF-043 + DEF-044).

**The biggest unknown** is `apps/mobile/` + `/investigation/*` + `/integrations` — three surface areas NOT audited in any of the 5 prior phases and not deeply inspected here. Any external mobile-customer claim or investigation-feature demo should be preceded by a dedicated bounded audit.

**The biggest unsold strength** is operational transparency — the 32-runbook set, the honest-scores assessment, the 1,432-case forbidden-phrase contract, the per-phase deferred-debt registry. These would be category-leading differentiators if surfaced in customer-facing marketing.

**Final honest one-liner:**
**PROOVRA is a genuinely mature evidence-operations + governance backend with a partially-decomposed, visually-inconsistent UI that can support a controlled single-customer enterprise pilot today, can support multi-customer pilot in ~2 weeks (DEF-043 + DEF-044 + Ops walks), and can support open procurement in ~6-8 weeks (+R11.1 + DEF-058 + SOC 2 process start).**
