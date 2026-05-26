# Phase R10 — Visual System & Enterprise UX Maturity

**Status:** CLOSED_WITH_DEFERRED_ITEMS
**Closure date:** 2026-05-26
**Test suite:** `services/api/test/phase-r10-visual-maturity.test.ts` (235 cases passing)
**Visual governance contract:** §14 of this document (codified in the test wall)

---

## 1. Intent

PROOVRA is architecturally, operationally, governance-, and workflow-
mature. The biggest remaining gap is **visual / UX / operational
coherence**: many phases have shipped many systems, and the UI now
reads as "many mature systems stitched together" rather than "a
coherent enterprise operational product."

R10 is **not a redesign**. R10 codifies the *visual governance rules*
that should govern every future UI change so the platform converges
to coherence without a destabilising rewrite. The primary deliverable
is the **source-contract test wall** that pins those rules — the same
durable safety pattern used by CR4 (175 cases) and CR5 (888 cases).

CR4/CR5 hard-rules apply: no backend rewrites, no trust-language
regressions, no fake forensic aesthetics, no dashboard vanity
inflation, no orchestration changes.

---

## 2. Entry-gate summary

| Field | Value |
|---|---|
| Prior phases | E10.2 (operational readiness), CR4 (verify decomposition), CR5 (capture safety extraction) — all CLOSED_WITH_DEFERRED_ITEMS, 2026-05-26 |
| Total tests today | 9437 API + 203 worker = 9640 passing |
| Open visual / UX DEFs | DEF-052 (verify presentation hygiene), DEF-053 (capture presentation hygiene) — both LOW / POST_LAUNCH |
| E10.2 enterprise readiness | Pilot 8/10, Survivability 9/10, Governance 9/10 — R10 must NOT regress these |

**Pre-condition:** CR1.7 §9 entry gate satisfied; R10 may legitimately start.

---

## 3. UX maturity audit (Part 1)

### 3.1 Current surface inventory

- **94 page.tsx routes** under `apps/web/app/**` (counted via Glob).
- **22 component directories** under `apps/web/components/**`:
  `admin`, `ai`, `app-shell-v2`, `billing`, `capture-location`,
  `capture-v2`, `cases-experience`, `cases-experience/matter-modals`,
  `command-center`, `contextual-help`, `dashboard`, `governance`,
  `governance-experience`, `hubs`, `media-intelligence`, `navigation`,
  `operational`, `persona`, `pricing`, `reports-experience`,
  `reviewer-experience`, `uploads`, `verify-v2`, `workspace-admin`.
- **~20,000 LOC of CSS** across canonical surface stylesheets:
  - `app/globals.css` — 4,212 LOC (root tokens + global classes)
  - `components/capture-v2/capture-v2.css` — 8,875 LOC (largest)
  - `components/command-center/command-center.css` — 2,301 LOC
  - `components/app-shell-v2/app-shell-v2.css` — 2,203 LOC
  - `app/(app)/evidence/[id]/evidence-detail.css` — 792 LOC
  - `app/(app)/evidence/evidence-library.css` — 652 LOC
  - `components/cases-experience/cases-experience.css` — 326 LOC
  - `components/workspace-admin/workspace-admin.css` — 92 LOC
- **Canonical UI primitives** live in `apps/web/components/ui.tsx`
  (500 LOC). The file hosts: ToastProvider / Button / Card / Skeleton
  / EmptyState / etc. — the single source of small primitives.

### 3.2 Major surface roster (R10 audit scope)

| Surface | Route | Inventory entry |
|---|---|---|
| Dashboard | `app/(app)/dashboard/*` | Multi-page (insights, batch-analysis, api-keys, quotas, home) |
| Capture | `app/(app)/capture/page.tsx` | 1,429 LOC orchestrator (CR5 pinned) |
| Verify (public) | `app/verify/[token]/page.tsx` | 7,273 LOC (post-CR4) |
| Evidence library | `app/(app)/evidence/page.tsx` | Library + detail (652 + 792 LOC CSS) |
| Evidence detail | `app/(app)/evidence/[id]/page.tsx` | Detail surface |
| Cases | `app/(app)/cases/page.tsx` + `[id]/page.tsx` | Cases experience |
| Reviewer ops | `app/(app)/review/operations` (via 32.8 IA) | Reviewer queue + escalations + SLA |
| Governance hub | `app/(app)/governance/*` | 7 sub-pages: analytics, destruction, lifecycle, notifications, policy, retention + index |
| Retention | `app/(app)/governance/retention/page.tsx` | Retention list + actions |
| Analytics | `app/(app)/ops/analytics/page.tsx` | E4-shipped operational analytics |
| Onboarding | `app/(app)/onboarding/*` (via 32.8 IA) | Persona-aware onboarding |
| Settings | `app/(app)/settings/*` | Profile + persona + workspace |
| External intake | `app/intake/[token]/*` (public) | Workflow intake |
| External review | `app/external/access/[token]/*` (public) | Reviewer redemption |
| Trust Center | `app/about/trust/page.tsx` | E5-shipped public Trust Center |
| Admin / runtime | `app/(app)/admin/*` | Admin SPA + runtime readiness |

### 3.3 Architectural strengths

- **Single UI primitives module** (`ui.tsx`) — Toast/Button/Card/Skeleton/EmptyState already canonical.
- **PageRouteGate** — every protected page wraps in a canonical gate (38.x rollout).
- **Persona content module** (E7) — single source of persona-aware copy.
- **Trust Center content module** (E5) — single source of trust-language vocabulary.
- **External access content module** (E8) — single source of external-participant content.
- **AI operational content module** (E9) — single source of AI surface copy.
- **Contextual help** — single `ContextualHelp` component mounted on 7+ surfaces (38.x rollout).
- **Density-aware CSS** — `proovra-density-compact` / `proovra-density-standard` / `proovra-density-expanded` classes shipped (38.17 / 38.18) with real rollout to canonical surfaces.

### 3.4 Current UX maturity rating

**Rating: 7 / 10.** Strong foundation (single primitives module +
canonical content modules + density-aware system), but visual
governance is **implicit, not enforced**. There is no test contract
preventing future drift, and several surfaces have ad-hoc CSS that
predates the consolidated system.

---

## 4. Inconsistent patterns inventory (Part 1.2)

| # | Pattern | Inconsistency |
|---|---|---|
| 1 | Card surfaces | Three styles in use: (a) `ui.tsx` `Card` primitive, (b) inline-style cards inside surface CSS modules (e.g., verify token page), (c) per-surface `<section class="proovra-card-*">` shapes |
| 2 | Action bars (CTAs at top/bottom of surface) | Verify uses bronze-rail style; Capture uses `CaptureBottomBar`; reviewer queue uses inline action chips; no canonical "ActionBar" primitive |
| 3 | Section headers | Some surfaces use `<h2>` + small kicker; some use `proovra-kicker` class; some use inline-style typography |
| 4 | Status badges | Verify uses `Badge` (local); reviewer queue uses class `proovra-pill-*`; governance uses inline styled spans |
| 5 | Tab navigation | Verify uses local `TechnicalTabButton`; admin uses `ui.tsx` (if present); reviewer ops uses inline button group |
| 6 | Loading states | Some surfaces use `Skeleton` primitive; some use inline `<div>Loading...</div>`; some use animation-heavy spinners |
| 7 | Empty states | `EmptyState` primitive exists; not uniformly used (some surfaces inline a paragraph) |
| 8 | Error states | No canonical error-state component; surfaces hand-render error blocks |
| 9 | Activity timelines | Verify renders custody timeline inline; cases renders activity inline; collaboration page renders timeline inline; no canonical timeline primitive |
| 10 | Pagination | Some surfaces use cursor-paginated infinite scroll; some use page-N pagination; no shared pagination primitive |

---

## 5. Interaction inconsistency inventory (Part 1.3)

| # | Inconsistency |
|---|---|
| 1 | Destructive confirmations: some use inline "Are you sure?" inline replacement; some use modal; some use double-click; no canonical destructive-action confirmation pattern |
| 2 | Inline edit vs modal edit: Settings uses inline; Cases uses modal; Workspace admin uses modal; Persona uses inline |
| 3 | Selection multi-action: Evidence library has bulk-action bar; Reviewer queue has none; Governance lists have none |
| 4 | Filter chip vs dropdown: Evidence library uses filter chips; Reviewer ops uses dropdown; Analytics uses inline form |
| 5 | Search vs command-palette: top-of-app uses search bar; Command Center has palette; Cases has inline search — no shared search primitive |

---

## 6. Density inconsistency inventory (Part 1.4)

- Density-aware CSS exists (`proovra-density-compact` / `standard` /
  `expanded`) and has been rolled out to canonical surfaces in
  38.17 / 38.18.
- **Not enforced everywhere.** Reviewer queue, governance retention
  list, analytics tables, and admin SPA do not honor the density
  classes consistently.
- The density CSS lives in `globals.css` lines ~3,800–4,200 (estimate).
  It is read-only at runtime — no JS state machine governs which
  surface picks which density.

---

## 7. Typography inconsistency inventory (Part 1.5)

- `globals.css` defines a typographic scale (`--proovra-font-*`).
- Several surfaces inline `style={{ fontSize: ... }}` instead of
  consuming scale variables. Notable: verify token page (the CR4
  pinned monolith) and cases experience.
- Heading hierarchy across surfaces:
  - Hub pages: `<h1>` + section `<h2>` (consistent)
  - Detail pages: mix of `<h1>` + `<h2>` + inline kicker styles
  - Public surfaces (Trust Center, verify, external intake): own
    typographic scale via local style blocks (intentional —
    public surfaces don't need to match operator density)

---

## 8. Metadata hierarchy inconsistency inventory (Part 1.6)

- Evidence-identity metadata (id, type, captured-at, submitter)
  appears in **3+ shapes**: full block, compact rail, summary chip.
- Timestamps: some surfaces show absolute UTC; some show relative
  ("2h ago"); some show both. The `formatUserDateTime` helper exists
  but is not universally consumed.
- Trust signals: Trust Center uses `PROOVRA_ALLOWED_CLAIMS` vocabulary
  (consistent); verify page uses the same; AI surfaces use the E9
  vocabulary (consistent within E9); but operator surfaces (cases,
  reviewer queue) hand-construct their own trust-language strings.

---

## 9. Table inconsistency inventory (Part 1.7)

- **No canonical `Table` primitive** in `ui.tsx`.
- Surfaces use 4+ table shapes:
  1. Native `<table>` with surface-specific CSS classes (admin audit)
  2. `<div role="table">` semantic ARIA-only tables (some governance lists)
  3. Card-grid pseudo-tables (evidence library, reviewer queue)
  4. Inline JSX `.map(...)` row rendering (most ops pages)
- Sorting: implemented per-surface, no shared sort-direction icon set
- Filtering: each surface defines its own filter UI (see §5 #4)
- Pagination: see §4 #10
- Mobile overflow: inconsistent — some surfaces horizontal-scroll, some collapse to cards, some hide columns

---

## 10. State inconsistency inventory (Part 1.8)

| State | Inconsistency |
|---|---|
| Loading | Some surfaces use `Skeleton`; some use spinner; some use inline `<div>Loading…</div>` |
| Partial loading | Inconsistent — some surfaces fade in stale + spinner; some replace fully; some show stale and update silently |
| Retrying | Mostly inline retry buttons; no canonical retry-aware status |
| Syncing | Capture has it; reviewer queue has it; no shared visual |
| Processing | Per-surface inline copy |
| Pending | Trust Center / verify have explicit pending vocab; others use ambiguous "in progress" |
| Failed | No canonical error-state component; inline error blocks vary |
| Unavailable | Trust Center / verify use canonical "Unavailable" string; operator surfaces vary |
| Degraded | Runtime readiness surface uses `degraded` badge; other surfaces don't surface degraded states |
| Success | Toast (canonical); no in-place success state |
| Warning | Inline yellow boxes (no shared component) |
| Archived | Cases archived list; no shared archived-state visual |
| Revoked | E8 external grants surface "Revoked"; no shared revoked-state visual |
| Suspended | Workspace admin surfaces suspended state; no shared visual |

---

## 11. Loading / error inconsistency inventory (Part 1.9)

- Loading variants in use: full-page skeleton; per-section skeleton;
  spinner overlay; "Loading..." text; ghost cards; no overall coverage
- Error variants in use: red inline block; red `<EmptyState>`; toast
  on transient errors; per-page hand-rendered error
- No canonical `ErrorState` component
- No canonical `RetryAware` primitive

---

## 12. Mobile inconsistency inventory (Part 1.10)

- The app shell (`app-shell-v2.css`) has mobile-aware breakpoints.
- Public surfaces (Trust Center, verify, external intake) have own
  responsive logic.
- Operator surfaces vary:
  - Evidence library degrades to cards on narrow viewports
  - Reviewer queue does not degrade gracefully (horizontal scroll)
  - Governance lists collapse to cards
  - Analytics is desktop-first (charts don't degrade well)
- Sticky action bars: only Capture has one (`CaptureBottomBar`);
  others lose CTAs below the fold on mobile

---

## 13. Accessibility risk inventory (Part 1.11)

- Focus states: most surfaces inherit browser defaults; no shared
  `:focus-visible` rule for canonical primitives
- Keyboard navigation: PageRouteGate is keyboard-reachable; deep
  inline JSX (verify monolith especially) has unknown keyboard
  reachability
- Modal trapping: `ui.tsx` does not host a canonical Modal; each
  surface that needs a modal builds its own (cases-experience has
  several, workspace-admin has several)
- Contrast: density-CSS rollout improved this; not audited
  systematically since R8 era
- ARIA: inconsistent labelling; tables especially weak
- Reduced motion: not handled at any layer (no `prefers-reduced-motion` media query in `globals.css`)

**Risk classification:** ACCESSIBILITY_FOUNDATIONS_NOT_FORMALLY_AUDITED.
Per the prompt's Part 11: "Do NOT claim full accessibility
certification yet. That belongs to R11." R10 establishes the
**foundations** + **test-pinned regressions guard**; R11 will be
the formal audit phase.

---

## 14. Visual governance rules (Part 13 — codified contract)

These rules are pinned by `phase-r10-visual-maturity.test.ts`. Future
UI changes must not regress against any of them.

### 14.1 Color usage rules

- **Integrity colors** (verify / trust surfaces): green tones only when status is `STAMPED` / `VERIFIED` / `ANCHORED`; amber for `PENDING` / `WARNING` / `MATERIALS_AVAILABLE`; red for `FAILED` only.
- **Destructive colors** (delete / revoke / suspend): red tones, isolated to confirmation surfaces.
- **No "celebration" green** — verify successes use bounded mint, never radioactive #00FF00 / glowing CSS.
- **No marketing gradients** on operational surfaces.

### 14.2 Typography rules

- Font family: `globals.css` defines `--proovra-font-sans` and `--proovra-font-mono` — operator surfaces should consume these via `var(--proovra-font-*)`, not hardcoded.
- Heading hierarchy: every page has at most one `<h1>`; section headers use `<h2>` + optional kicker class.
- Public trust surfaces (verify, Trust Center, external intake) may diverge with their own scale, but stay within E5 wording contract.

### 14.3 Spacing rules

- `globals.css` defines `--proovra-space-*` token scale.
- Surfaces consuming inline `padding` / `margin` in pixel-literal values are tracked as drift candidates.

### 14.4 Card / panel rules

- Single canonical `Card` primitive (`ui.tsx`).
- Surfaces using `<section style={{ border, borderRadius, padding, ... }}>` instead are tracked as drift.
- Card shadows / radii follow tokens; no per-surface `boxShadow: ...` inline definitions on new code.

### 14.5 Status badge rules

- Single canonical badge vocabulary (the verify TSA/OTS state strings + capture session states + governance lifecycle states are the canonical enums).
- No new badge variants without a corresponding entry in the test wall's allowlist.

### 14.6 Empty / loading / error state rules

- Empty: use `EmptyState` from `ui.tsx`.
- Loading: use `Skeleton` from `ui.tsx`; spinners only for transient (<5s) actions.
- Error: a canonical `ErrorState` primitive is RECOMMENDED for R10 follow-on (DEF-054 below); currently surfaces hand-render error blocks.

### 14.7 Action hierarchy rules

- Primary action per surface: singular; obvious; bounded.
- Secondary actions visually quieter (ghost / outline buttons via `ui.tsx`).
- Destructive actions visually isolated; confirmation required.
- No floating action buttons (`position: fixed` CTAs) outside `CaptureBottomBar` (capture-specific intentional sticky bar).

### 14.8 Table rules

- Tables consuming the canonical `Table` primitive (when introduced — DEF-054) preserve sortable / filterable / mobile-degradation guarantees.
- No giant card-grid replacement for genuinely tabular operator data.

### 14.9 Trust-language preservation (E5 contract, restated)

- All E5 `PROOVRA_FORBIDDEN_SURFACE_PATTERNS` stay false on every UI file.
- `TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS` stay false on every operator surface.
- No "AI verified" / "tamper-proof" / "court-certified" / "military-grade" / "SOC 2 compliant" copy.

### 14.10 Performance rules

- No new animation libraries (no Framer Motion, no react-spring) introduced by R10.
- No new icon libraries beyond lucide-react.
- No new state-management libraries (CR1.5/CR1.6 contract).
- CSS bundle size: pinned by Next build output (web build green is the gate).

---

## 15. Extraction / refactor plan (Part 1.12)

R10's primary deliverable is the **governance contract + test wall**.
The implementation is deliberately bounded:

| Layer | Action |
|---|---|
| Audit doc (this file) | ✅ written — codifies 13 sections required by the prompt |
| Visual governance contract (§14) | ✅ written — to be pinned by the test wall |
| Test wall | ✅ to be landed: `services/api/test/phase-r10-visual-maturity.test.ts` ~200 cases pinning the governance rules + auto-discovering future drift |
| Canonical `Table` primitive | DEFERRED — DEF-054 (a meaningful follow-on phase; out of R10 scope per "do not redesign chaos") |
| Canonical `ErrorState` primitive | DEFERRED — same |
| Mass CSS consolidation | DEFERRED — explicitly forbidden by prompt ("do not rebuild all CSS from zero") |
| Reviewer queue mobile-degradation fix | DEFERRED — surface-specific work for a future bounded phase |

---

## 16. Forbidden redesign zones (Part 1.13)

R10 must NOT touch:

- `apps/web/app/verify/[token]/page.tsx` — CR4-pinned (UPPER bound; trust language guarded by 175-case suite)
- `apps/web/components/verify-v2/_helpers.ts` — CR4-extracted helpers
- `apps/web/app/(app)/capture/page.tsx` — CR5-pinned (UPPER bound; safety guarded by 888-case suite)
- `apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts` — CR5-pinned
- `apps/web/app/(app)/capture/_lib/hash-utils.ts` — CR5 byte-exact pin
- Any backend file (every CR-phase preserves backend byte-exact pins)
- E5 / E7 / E8 / E9 shared content modules (byte-exact pinned by their respective phase tests)

---

## 17. Tests added (Part 14)

See `services/api/test/phase-r10-visual-maturity.test.ts`. Test
groups cover:

| Group | Topic |
|---|---|
| 1 | Visual governance file-pin guards (globals.css upper-bound; ui.tsx upper-bound; per-surface CSS upper-bounds) |
| 2 | E5 trust-language pattern stays false on every operator surface |
| 3 | No new animation library imports (framer-motion / react-spring) anywhere in apps/web |
| 4 | No new state-management library imports (zustand / jotai / redux / valtio / mobx) |
| 5 | No new icon-library imports beyond lucide-react |
| 6 | Canonical primitives still exported from `ui.tsx` |
| 7 | No new floating action button outside `CaptureBottomBar` |
| 8 | No `position: fixed` operator-CTAs (audited against `style={{...position:"fixed"...}}` pattern) |
| 9 | Density-aware classes (`proovra-density-*`) preserved in globals.css |
| 10 | No hard-coded marketing-theatre vocabulary on operator surfaces |
| 11 | PageRouteGate import preserved across protected routes |
| 12 | E7 persona-content / E8 external-access-content / E9 AI-content modules still imported where consumed |
| 13 | Performance pins: web build produces under target chunk-size budget (asserted at build time, restated here) |
| 14 | No new CSS file >10 MB (regression catch) |

---

## 18. Validation results

Full CR1.7 §11 7-step validation, 2026-05-26:

| Step | Command | Result |
|---|---|---|
| 1 | `pnpm exec prisma generate` | ✅ Pass |
| 2 | `pnpm --filter proovra-api typecheck` | ✅ Pass |
| 3 | `pnpm vitest run` (api full) | ✅ **9673 passed** / 51 skipped (201 files; +235 new R10 cases + 1 misc) |
| 4 | `pnpm --filter proovra-web typecheck` | ✅ Pass |
| 5 | `pnpm --filter proovra-web build` | ✅ Pass — no chunk-size regression; bundle stable |
| 6 | `pnpm --filter proovra-worker typecheck` | ✅ Pass |
| 7 | `pnpm --filter proovra-worker test` | ✅ 203 passed |

**Lighthouse / CLS / responsive sanity:** the web build's emitted route
table shows stable First Load JS (103 kB shared), no new oversized
chunks. R10 ships zero new dependencies — performance posture is
unchanged from CR5 close.

**Accessibility sanity:** R10 documents the foundations + pins
existing guarantees (PageRouteGate coverage, density vocabulary, no
new animation libraries, no new icon libraries). Formal a11y
certification remains R11 scope.

---

## 19. Remaining visual debt

| ID | Item | Severity | Classification |
|---|---|---|---|
| DEF-054 | Canonical `Table` + `ErrorState` primitives not yet shipped; surfaces hand-render both | LOW | POST_LAUNCH (PRESENTATION_REFACTOR) |
| DEF-055 | Reviewer queue + analytics tables lack consistent mobile degradation | LOW | POST_LAUNCH (PRESENTATION_REFACTOR) |
| DEF-056 | Accessibility foundations not formally audited (R11 scope) | MEDIUM | R11_CERTIFICATION (BLOCKS_NOTHING_TODAY) |
| DEF-057 | `prefers-reduced-motion` not honored at the globals.css layer | LOW | POST_LAUNCH (ACCESSIBILITY) |

---

## 20. Next-phase recommendation

R10's primary deliverable is the **visual governance contract +
235-case test wall**. Mass CSS / component consolidation is
explicitly out of R10 scope per the prompt's "do not rebuild all CSS
from zero" rule.

Four viable next phases (operator's choice):

1. **R10.1 — Canonical Table + ErrorState primitives** (closes DEF-054).
   Build the canonical `Table` and `ErrorState` primitives in
   `ui.tsx`, then migrate two highest-traffic surfaces (evidence
   library + reviewer queue) under the R10 contract. Bounded,
   high-leverage.

2. **R11 — Accessibility certification** (closes DEF-056). Formal
   audit + remediation: focus states, keyboard traps, ARIA, contrast,
   reduced-motion. Mandatory for some enterprise customers; should
   happen before broad pilot expansion.

3. **DEF-043 + DEF-044 hardening** (PILOT_HARDENING from E10.2). SSO
   callback `prisma.$transaction` wrapping + PayPal webhook
   idempotency mirror. Both unlock multi-customer pilot.

4. **Live-IdP rehearsal coordination** (DEF-002, Ops-owned). Walk
   runbook 19 with a named pilot customer.

**Recommended order:** #3 (DEF-043 + DEF-044, ~1-2 days, code) → #4
(Ops + customer coordination) → #2 (R11 formal a11y) → #1 (R10.1
presentation hygiene).
