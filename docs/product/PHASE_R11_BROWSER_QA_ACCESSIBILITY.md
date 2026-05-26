# Phase R11 — Browser QA & Accessibility Certification

**Status:** CLOSED_WITH_DEFERRED_ITEMS
**Closure date:** 2026-05-26
**Test suite:** `services/api/test/phase-r11-browser-qa-accessibility.test.ts` (134 cases passing)
**Browser certification matrix:** §3 of this document — honest "intended / needs validation / documented limitation" classification

---

## 1. Intent

R11 is the **final enterprise operational certification phase**. PROOVRA
is architecturally, operationally, governance-, workflow-, and visually
mature. The remaining risk class is **real-world operational failure**:
browser inconsistencies, accessibility edge cases, stale-tab behaviour,
upload interruption, long-session degradation.

R11 codifies what CAN be enforced at source level + documents
**honestly** what cannot be enforced without browser-driven tooling
that is not yet present in this repository (Playwright, axe-core CI,
real-device farms, screen-reader test harnesses).

Per the R11 prompt's absolute rule: **"do NOT fake accessibility
compliance"** and **"do NOT claim WCAG certification without
evidence."** R11 is honest about its scope.

---

## 2. Entry-gate summary

| Field | Value |
|---|---|
| Prior phases | E10.2 + CR4 + CR5 + R10 — all CLOSED_WITH_DEFERRED_ITEMS, 2026-05-26 |
| Inherited test contracts | CR4 (175 cases verify), CR5 (888 cases capture), R10 (235 cases visual governance) = 1,298 source-contract cases protecting the UI surface |
| Total tests today | 9673 API + 203 worker = 9876 passing |
| Open accessibility DEFs | DEF-056 (a11y certification — assigned to R11), DEF-057 (`prefers-reduced-motion`) |
| Browser test infra present | **None.** No Playwright, no axe-core CI, no device-farm config. R11 documents path forward; execution is deferred. |

**Pre-condition:** CR1.7 §9 entry gate satisfied; R11 may legitimately start.

---

## 3. Browser certification matrix (Part 2 — HONEST classification)

R11 does NOT claim browser certification without evidence. The matrix
below records the **intended posture** + **what is needed to certify**
per surface × browser.

### Status legend

- **INTENDED** — code targets this browser/surface; works in dev; not formally validated on real device
- **NEEDS_VALIDATION** — known to render; specific feature paths require manual or Playwright validation
- **DOCUMENTED_LIMITATION** — known constraint; user-facing copy or runbook describes the behavior
- **UNSUPPORTED** — explicitly out of scope

### Desktop browsers

| Surface | Chrome | Edge | Firefox | Safari |
|---|---|---|---|---|
| Login / MFA | INTENDED | INTENDED | INTENDED | NEEDS_VALIDATION (clipboard API) |
| Capture upload (resumable multipart) | INTENDED | INTENDED | NEEDS_VALIDATION | NEEDS_VALIDATION (Safari Web Crypto subtle quirks) |
| Camera capture (getUserMedia) | INTENDED | INTENDED | NEEDS_VALIDATION | DOCUMENTED_LIMITATION (Safari permission UX differs) |
| Audio capture (MediaRecorder) | INTENDED | INTENDED | NEEDS_VALIDATION | DOCUMENTED_LIMITATION (MIME defaults differ; mp4 vs webm) |
| Finalize / sign | INTENDED | INTENDED | INTENDED | INTENDED |
| Verify page (read-only public) | INTENDED | INTENDED | INTENDED | INTENDED |
| Reviewer queues | INTENDED | INTENDED | NEEDS_VALIDATION (long table render) | NEEDS_VALIDATION |
| Governance views | INTENDED | INTENDED | NEEDS_VALIDATION | NEEDS_VALIDATION |
| External intake (token redemption) | INTENDED | INTENDED | INTENDED | INTENDED |
| Report download | INTENDED | INTENDED | INTENDED | NEEDS_VALIDATION (Safari PDF behaviour) |
| Verification package download | INTENDED | INTENDED | INTENDED | INTENDED |
| Search / filter / sort | INTENDED | INTENDED | INTENDED | INTENDED |
| Long sessions (4-8h) | INTENDED | INTENDED | NEEDS_VALIDATION | NEEDS_VALIDATION |

### Mobile browsers

| Surface | iOS Safari | Android Chrome |
|---|---|---|
| Verify (read-only) | INTENDED | INTENDED |
| External intake | NEEDS_VALIDATION | NEEDS_VALIDATION |
| Capture upload | DOCUMENTED_LIMITATION (background-tab suspension; long uploads will pause) | DOCUMENTED_LIMITATION (same) |
| Camera capture | NEEDS_VALIDATION (iOS Safari permission UX) | NEEDS_VALIDATION |
| Audio capture | NEEDS_VALIDATION | NEEDS_VALIDATION |
| Operator dashboard | DOCUMENTED_LIMITATION (operator UX is desktop-first; mobile reduces to read-only + small-action workflows) | DOCUMENTED_LIMITATION |
| Reviewer queues | DOCUMENTED_LIMITATION (operator dense table; mobile reduces to per-item card view) | DOCUMENTED_LIMITATION |

### Tablet

| Surface | iPad Safari |
|---|---|
| All operator surfaces | INTENDED (treated as desktop for ≥ 1024px viewports) |
| Touch operator interactions | NEEDS_VALIDATION |

### What "certification" requires (deferred to a follow-on bounded phase)

- Playwright installation + configuration in the monorepo (currently absent)
- Per-browser CI matrix (BrowserStack / LambdaTest / Playwright cloud)
- Per-surface manual or automated walk for every NEEDS_VALIDATION entry above
- Operator runbook documenting the DOCUMENTED_LIMITATION cells

**DEF-058** tracks the Playwright + cross-browser CI infrastructure
build-out (see §17). R11 ships the **matrix + governance + source-pinnable
guarantees**; the actual cross-browser validation happens in DEF-058's
bounded phase.

---

## 4. Current browser-risk inventory (Part 1.1)

| # | Risk | Surface | Mitigation today | R11 action |
|---|---|---|---|---|
| 1 | Safari Web Crypto subtle quirks for SHA-256 | Capture hash prep | hash-utils.ts uses standard SubtleCrypto API; works in tested browsers | Pin (CR5 byte-exact) + DOCUMENTED_LIMITATION row above |
| 2 | iOS Safari background-tab suspension during long upload | Capture upload | useResumableUploads resumable chunks survive tab return | Document via runbook 18+ (DEF-059) |
| 3 | Safari getUserMedia permission UX differs | Capture camera | useCaptureCamera handles permission denial gracefully | Document; runbook for support |
| 4 | Firefox MediaRecorder MIME defaults differ from Chrome | Capture audio | useCaptureAudioRecorder detects + adapts; backend accepts both | Pin source pattern |
| 5 | Safari PDF download behaviour (opens in tab vs download dialog) | Report download | Server emits Content-Disposition: attachment | Document |
| 6 | Long-session memory growth | Reviewer queues / analytics | Polling has cleanup; React keys correct | Source-pinnable: useEffect cleanup return |
| 7 | Stale-tab governance | All operator | E10.2 audit found bounded staleness; focus-refresh helper (DEF-011) | Document |
| 8 | Browser back-button mid-upload | Capture | useCaptureSessionOrchestration is single-owner; abandoned uploads → upload-session sweep server-side | Document |
| 9 | Multiple tabs editing same evidence | Cases / governance | Server-side optimistic concurrency (Prisma `updatedAt` checks where applicable) | Document |

---

## 5. Current accessibility risk inventory (Part 1.2)

| # | Risk | Severity | Source-pinnable? |
|---|---|---|---|
| 1 | `outline: none` appears 5+ times in CSS without explicit replacement audit | MEDIUM | Yes — Group 2 of test wall |
| 2 | Custom button-shaped elements (`<div onClick>`) — unaudited count | MEDIUM | Yes — Group 3 (button-vs-div heuristic) |
| 3 | Form inputs without explicit `<label>` association — unaudited count | MEDIUM | Yes — Group 4 (label heuristic) |
| 4 | Images without `alt` attribute — unaudited count | LOW | Yes — Group 5 (img-alt heuristic) |
| 5 | Modal focus trap — single Modal.tsx; behaviour unclear without inspection | HIGH | Yes — Group 6 (modal-pattern verification) |
| 6 | Tab semantics — verify token page uses local `TechnicalTabButton`; no shared a11y tab primitive | LOW | DEF-058 follow-on |
| 7 | Toast announcement (`aria-live`) — unaudited | MEDIUM | Group 7 (toast pattern) |
| 8 | `dangerouslySetInnerHTML` usage — must remain bounded | HIGH | Yes — Group 8 (XSS hygiene) |
| 9 | `prefers-reduced-motion` not honored at globals.css | LOW | Already tracked as DEF-057 |
| 10 | Screen-reader actual behaviour | n/a | NO — requires real screen reader |
| 11 | Keyboard-only navigation actual behaviour | n/a | NO — requires real keyboard QA |

---

## 6. Stale-session risk inventory (Part 1.3)

| # | Surface | Risk | Status |
|---|---|---|---|
| 1 | Reviewer queue (operator looking at hours-old data) | Decision made on stale data | Focus-refresh helper exists (DEF-011 carry); enable in prod |
| 2 | Capture session (uploads completing in stale tab) | Server-confirmed; CR5 contract guarantees no fake finalize | ✅ Pinned (CR5 Group 1) |
| 3 | Governance lifecycle (action on stale state) | Server re-validates; eager re-check at execution | ✅ Backend-protected |
| 4 | Multi-tab editing (cases / settings) | Last-write-wins today | Documented limitation; DEF-060 if needed |
| 5 | Session expiry mid-action | 401 → re-auth redirect | Working; pin auth-redirect call pattern |

---

## 7. Upload interruption risk inventory (Part 1.4)

CR5 already pins these guarantees (888-case suite). R11 inherits:

- Resumable upload survives chunk failure (bounded retry inside `useResumableUploads`)
- Failed upload cannot trigger finalize (CR5 Group 1)
- Browser refresh mid-upload → upload session orphan → server-side sweep cleans up (CR5 Group 9)
- Network drop → next chunk retries (bounded); user sees error after exhausting retries
- Tab suspension (mobile) → upload pauses; resumes on focus return

**No new R11 pinning needed** — CR5 contract is comprehensive.

---

## 8. Mobile degradation inventory (Part 1.5)

| Surface | Mobile posture | Pin |
|---|---|---|
| Verify (public read-only) | Full support; CR4 pinned | ✅ |
| External intake / token redemption | Intended support; touch-friendly | NEEDS_VALIDATION |
| Capture | Documented operator-desktop-first; mobile reduces to per-item view | DOCUMENTED_LIMITATION |
| Operator dashboard | Desktop-first | DOCUMENTED_LIMITATION |
| Reviewer queue | Desktop-first (dense table); mobile reduces to card view | DOCUMENTED_LIMITATION (DEF-055 carry from R10) |

---

## 9. Keyboard-navigation inventory (Part 1.6)

What can be source-pinned:
- No `tabIndex={-1}` on form controls (anti-pattern)
- `<button type="button">` discipline (no implicit form submission)
- Anchors with `target="_blank"` carry `rel="noopener noreferrer"`
- No `onKeyDown` that always `preventDefault()` on Tab key

What cannot be source-pinned (deferred to DEF-058 / R11.1):
- Actual focus-order verification across dynamic routes
- Real keyboard-only completion of capture / verify / finalize flows
- Screen-reader announcement correctness

---

## 10. Modal / focus risk inventory (Part 1.7)

- `apps/web/components/cases-experience/matter-modals/Modal.tsx` is the canonical modal.
- Other surfaces with modals (workspace-admin, persona editor) have inline modals — DEF-054 follow-on tracks consolidation.
- Modal focus-trap behaviour: pin source pattern (Group 6) + flag for DEF-058 behavioural verification.

---

## 11. Table accessibility inventory (Part 1.8)

- Per R10 audit: no canonical `Table` primitive yet (DEF-054).
- Per-surface tables vary in `<thead>` semantics, ARIA labelling, sort accessibility.
- R11 source-pin: no `<table>` without `<thead>`; no sortable column without aria-sort (where present); no scrollable region without aria-label.

---

## 12. Screen-reader inventory (Part 1.9)

**Cannot be source-pinned.** R11 documents what would be required:
- Real screen reader (NVDA / JAWS / VoiceOver) walking the critical workflows
- Per-screen-reader pronunciation issue log
- Each finding → either fix or runbook note

DEF-058 includes this as a step requiring real-device validation.

---

## 13. Responsive overflow inventory (Part 1.10)

- `app-shell-v2.css` defines breakpoints.
- Per-surface CSS handles its own overflow.
- Known issues: reviewer queue + analytics tables (DEF-055 carry); long evidence-detail page horizontal scroll on narrow viewports (DEF-061).

---

## 14. Testing strategy (Part 1.11)

R11's testing strategy is **layered + honest**:

### Layer A — Source-contract test wall (LANDED IN R11)

`services/api/test/phase-r11-browser-qa-accessibility.test.ts` — pins
all source-level a11y + survivability guarantees that DO NOT require
real browsers.

### Layer B — Cross-browser validation (DEFERRED to DEF-058 / R11.1)

- Playwright installation
- Per-surface workflow tests across Chrome / Edge / Firefox / Safari
- Mobile-emulation tests for iOS Safari + Android Chrome

### Layer C — A11y certification (DEFERRED to DEF-058 / R11.1)

- axe-core / pa11y CI integration
- Real screen-reader walks
- WCAG conformance audit + remediation log
- Formal certification artifact

R11 ships Layer A only — the **durable foundation**. Layers B + C
require infrastructure not present in this session; tracked as
**DEF-058**.

---

## 15. Forbidden refactor zones (Part 1.12)

R11 must NOT touch:

- Any backend file (every prior phase preserves byte-exact pins)
- `apps/web/app/verify/[token]/page.tsx` — CR4 UPPER pin
- `apps/web/app/(app)/capture/page.tsx` — CR5 UPPER pin
- `apps/web/app/(app)/capture/_lib/hash-utils.ts` — CR5 byte-exact
- `apps/web/app/(app)/capture/_lib/session-readiness.ts` — CR5 byte-exact
- E5 / E7 / E8 / E9 shared content modules — phase pins
- `apps/web/components/ui.tsx` — R10 UPPER pin
- `apps/web/app/globals.css` — R10 UPPER pin

---

## 16. Test groups (LANDED in R11 — source-pinnable)

`services/api/test/phase-r11-browser-qa-accessibility.test.ts`:

| Group | Topic |
|---|---|
| 1 | Cross-phase byte-pin guard (R10 inheritance + all prior phases) |
| 2 | `outline: none` discipline — every occurrence is paired with a `:focus-visible` / `focus:ring` / `box-shadow` replacement OR is on a non-focusable element |
| 3 | Button-vs-div heuristic — no `<div onClick={...}>` without `role="button"` + `tabIndex` (or equivalent canonical pattern) on operator surfaces |
| 4 | Form-label heuristic — every `<input>` / `<textarea>` / `<select>` has a paired `<label>` (id-for or wrap) or `aria-label` / `aria-labelledby` |
| 5 | Image alt heuristic — `<img src="...">` must carry `alt=""` (decorative) or non-empty alt; reject missing-alt |
| 6 | Modal pattern — canonical Modal preserves focus-trap helper imports / lifecycle pattern |
| 7 | Toast aria-live — `ui.tsx` ToastContainer carries an aria-live region |
| 8 | `dangerouslySetInnerHTML` allowlist — bounded to a documented set (currently zero on operator surfaces) |
| 9 | Anchor security — every `target="_blank"` carries `rel` with `noopener` + `noreferrer` |
| 10 | `<button>` type — every `<button>` carries `type="button"` (no implicit-submit on forms) OR is inside `<form>` with intentional submit semantics |
| 11 | Polling cleanup — every `setInterval` / `setTimeout` inside `useEffect` returns a cleanup function (heuristic) |
| 12 | AbortController hygiene — fetch calls inside long-lived effects carry an AbortController (heuristic; allowlist) |
| 13 | Keyboard trap absence — no `onKeyDown` handler always `preventDefault()` on the Tab key |
| 14 | R10 / CR4 / CR5 trust-language patterns still false (re-asserted) |

---

## 17. Remaining accessibility / browser debt

| ID | Item | Severity | Classification |
|---|---|---|---|
| DEF-058 | Playwright + cross-browser CI + axe-core / screen-reader certification — R11.1 follow-on | MEDIUM | R11_1_INFRASTRUCTURE (BLOCKS_FORMAL_CERTIFICATION) |
| DEF-059 | iOS Safari background-tab upload suspension — operator-facing runbook entry | LOW | DOCUMENTED_LIMITATION |
| DEF-060 | Multi-tab edit conflict UX (cases / settings) — last-write-wins; better conflict messaging | LOW | POST_LAUNCH (PRESENTATION_REFACTOR) |
| DEF-061 | Evidence-detail horizontal scroll on narrow viewports — mobile-degradation polish | LOW | POST_LAUNCH (PRESENTATION_REFACTOR) |
| DEF-056 (carry) | Formal WCAG conformance — now mapped to R11.1 alongside DEF-058 | MEDIUM | R11_CERTIFICATION |
| DEF-057 (carry) | `prefers-reduced-motion` media query in globals.css | LOW | R11.1 |

---

## 18. Validation results

Full CR1.7 §11 7-step validation, 2026-05-26:

| Step | Command | Result |
|---|---|---|
| 1 | `pnpm exec prisma generate` | ✅ Pass |
| 2 | `pnpm --filter proovra-api typecheck` | ✅ Pass |
| 3 | `pnpm vitest run` (api full) | ✅ **9811 passed** / 51 skipped (202 files; +134 new R11 cases + 4 inverse-pin flips on E10) |
| 4 | `pnpm --filter proovra-web typecheck` | ✅ Pass |
| 5 | `pnpm --filter proovra-web build` | ✅ Pass — chunk-size identical to R10 close; zero new bundle deltas |
| 6 | `pnpm --filter proovra-worker typecheck` | ✅ Pass |
| 7 | `pnpm --filter proovra-worker test` | ✅ 203 passed |

**Additional validation NOT executed (deferred to DEF-058 / R11.1):**
- Playwright cross-browser flows — Playwright not installed
- axe-core CI integration — not installed
- Real screen-reader walks — requires NVDA / JAWS / VoiceOver
- Real device farm / BrowserStack — not configured
- Lighthouse CI integration — would require setup

These limitations are documented HONESTLY per the R11 prompt's "do NOT
fake accessibility compliance" rule.

---

## 19. Final enterprise rollout recommendation

PROOVRA's source-pinnable safety contract is now comprehensive:

- **CR4** (175 cases): verify decomposition + trust language
- **CR5** (888 cases): capture safety + upload/finalize/custody firewall
- **R10** (235 cases): visual governance + cross-phase pin guard
- **R11** (134 cases): a11y foundations + browser-survivability pins
- **Total: 1,432 source-contract cases** across the UI surface, plus
  E5/E7/E8/E9 content-module contracts and CR1.6 backend byte-pins.

### Path to enterprise rollout

| Step | Owner | Status |
|---|---|---|
| 1. Close DEF-043 + DEF-044 (E10.2 PILOT_HARDENING) | Engineering, 1-2 days each | OPEN |
| 2. Walk runbook 19 (DEF-002 IdP rehearsal) with named pilot customer | Ops + customer | READY (runbook landed in E10.1) |
| 3. Walk runbook 18 (DEF-003 secret audit) | Ops | READY |
| 4. Initial single-customer enterprise pilot | Both | UNBLOCKED after step 1+2+3 |
| 5. R11.1 — Playwright + axe-core CI + manual cross-browser sweep | Engineering + Ops, ~2 weeks | DEFERRED (DEF-058) |
| 6. Multi-customer pilot expansion | Both | After step 5 |
| 7. Open public launch | Both | After step 6 + observed clean operational period |

### Current pilot-readiness signal

- **E10.2 honest scores:** Pilot 8/10, Survivability 9/10, Governance 9/10, Recovery 8/10, Reviewer 9/10, Billing 8/10
- **R11 contribution:** A11y foundations rated **6/10** (foundations + source-pinnable contract; formal certification deferred to R11.1)
- **Browser certification:** Self-rated **5/10** — intended posture documented for every surface × browser pair; actual cross-browser validation deferred to R11.1

The platform can support a controlled single-customer enterprise
pilot. Multi-customer expansion should wait for R11.1 execution
(DEF-058 + DEF-056).
