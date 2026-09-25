# C — GLOBAL SHARED-COMPONENT AND DESIGN-SYSTEM AUDIT (v2)

**Frozen revision:** `71e148f34410c7c231f8930d1387d8924b10b4e5`
Source-only. Nothing was rendered. No claim here is a rendered claim.

---

## C.1 The token pipeline is sound, and it is not the problem

| | |
|---|---|
| Authored authority | `apps/web/lib/design-tokens/tokens.css` |
| Generator | `packages/ui/tools/generate-tokens.mjs` |
| Emitted module | `packages/ui/src/tokens/proovra.generated.ts` (`proovraTokens`) |
| Native adapter | `apps/mobile/src/theme/theme.ts` (101 lines) — the ONE bridge |
| Guard | `packages/ui/tests/tokens-generated.test.mjs` |

The native adapter is well built. It passes colours through as strings, keeps
spacing/radii as RN numbers, and **parses the canonical CSS `box-shadow` strings
into RN shadow triples** (`theme.ts:36-45`) rather than hand-copying them.
Native source contains only **6** hardcoded hex literals across all of
`apps/mobile/src` + `apps/mobile/app` — the adapter rule is genuinely obeyed.

**So the divergence is not native drifting from the tokens.**

## C.2 The divergence is that the WEB does not use its own tokens

Independently measured at the frozen revision, over the **30** authored web
stylesheets (build output under `.next/` excluded — an earlier count of 58 in
this audit was contaminated by build artifacts and is withdrawn):

| Measure | Count |
|---|---:|
| Hex occurrences in authored web CSS | **1,857** |
| Distinct hex colours, all authored web CSS | **305** |
| Distinct hex colours in `tokens.css` (the legitimate home) | **53** |
| **Distinct hex colours in component CSS, outside the token layer** | **295** |
| Occurrences outside the token layer | **1,752** |
| Distinct hex colours in the native token set | **46** |

The web renders from a palette of roughly **295 colours that exist in no token**,
on top of the ~53 that do. Native renders the **46**-colour token palette
faithfully. Those two surfaces cannot look alike, and no amount of token sharing
will make them alike.

This independently corroborates the prior audit's central visual finding
(it reported 222 distinct / 2,079 occurrences using different extraction rules;
same conclusion, same order of magnitude). **CONFIRMED.**

### Why no existing guard catches it

`packages/ui/tests/tokens-generated.test.mjs` proves that
`proovra.generated.ts` is a faithful regeneration of `tokens.css`, that every
`var()` alias is flattened, that radii/spacing are numbers, and that badge tones
are complete. Every one of those tests is about **the token module**.

Nothing in the repository asserts that a **web component actually uses a token**.
The guard's scope cannot reach the defect. This is not a broken guard; it is a
guard aimed at a different question.

### Concentration
The prior audit's `hardcodedByFile` ranking (independently re-read here) puts the
bypass overwhelmingly in a few surfaces:

| File | Hardcoded hex |
|---|---:|
| `components/capture-v2/capture-v2.css` | 776 |
| `components/command-center/command-center.css` | 344 |
| `components/capture-v2/capture-workspace.css` | 243 |
| `app/globals.css` | 123 |
| `app/(app)/settings/settings.css` | 112 |

Note that `command-center.css` (344) serves the **enterprise-only** Home and is
therefore outside the applicable set (see §C.5), while `capture-v2*` (1,019
combined) serves `/capture`, which is squarely inside it.

---

## C.3 The app shell — the largest single structural divergence

Full detail in `E-ROOT-CAUSE-REGISTER.md` V2-005. Summary:

| | PWA | Native |
|---|---|---|
| Implementation | `components/app-shell-v2/` — **2,757 lines**, 6 components + CSS | `src/ui/shell.tsx` — **175 lines** |
| Header | yes, on every authenticated page | **none** |
| Global search / command palette | yes (`AppAccountToolbar.tsx:328`, `AppShellV2.tsx:252`) | **none** |
| Workspace switcher | yes, in the header (`:402`) | only a row in the Settings tab |
| Account menu / avatar | yes (`:583`, `:708`) | **none** |
| Notification bell | yes (`NotificationBell.tsx`, 722 lines) | **none** (an "Alerts" nav item instead) |
| Language selector | yes (`:373`) | **none** in the shell |
| System status | yes (`:365`) | **none** |
| Skip link | yes (`AppShellV2.tsx:195`) | **none** |
| Degraded-workspace panels | `WorkspaceRecoveryPanel`, `PersonalSpaceUnavailablePanel` (`:241`,`:243`) | **none** |
| Nav source | derived: `ROUTE_REGISTRY` → access → exposure → disclosure → grouping resolvers, with per-route icons, groups, disclosure tiers and degradation chips | **hardcoded 7-item array**, `useNavItems()` |
| Nav icons | yes (`lib/navigation/routeIcons.ts`) | **none** — text label + a 2-colour indicator bar |
| Capability gating of nav | yes | **none** |

### Consequences, each established from source

1. **Global search does not exist in native.** Exhaustive scan of every
   `router.push` / `router.replace` / `href` in `apps/mobile/app` and
   `apps/mobile/src` finds exactly **one** route into `/search`:
   `app/(tabs)/index.tsx:280`, a card on Home. Five of the seven primary
   destinations offer no search at all.
2. **No workspace switcher in the chrome** — `/spaces` only from
   `app/(tabs)/settings.tsx:174`.
3. **The Settings tab is doing the sidebar's job.** It is the sole in-app entry
   point for 14+ surfaces (billing, quotas, batch-analysis, organizations, AI,
   notification settings, privacy, reviewer-criteria, security, spaces, support,
   trust-center, evidence-requests, intake-links, legal, teams, verify,
   workspace-people).
4. **`app/(tabs)/teams.tsx` is not in the nav** despite being a tab screen.

---

## C.4 Shared primitives — the native design system is real but narrower

Native ships a genuine primitive set (`src/ui/index.tsx` 607 lines,
`src/ui/patterns.tsx` 728 lines): `ProovraScreen`, `ProovraCard`,
`ProovraSection`, `ProovraButton`, `ProovraBadge`, `ProovraInput`,
`ProovraListRow`, `ProovraEmptyState`, `ProovraFilterChips`, `ProovraText`,
`ProovraResultCount`, `ProovraCursorPager`, `ProovraErrorState`,
`ProovraLoadingState`, `ProovraStatusTone`.

This is a coherent system and is **not** a defect. It maps recognisably onto the
web's `app-primitives` layer. What it lacks relative to the web shell is listed
in C.3; what it lacks at element level is the subject of `F-COVERAGE-LEDGER.md`.

**Important measurement caveat carried forward:** a raw element-count ratio
(native 5,455 : web 19,788 = 27.6%) **overstates** the gap, because one
`<ProovraListRow>` replaces a nested stack of web `<div>`s. The handler ratio
(native 1,215 : web 2,703 = **45%**) is the fairer of the two mechanical
measures, and the module-level reading in `D-HOME-PER-PAGE.md` is fairer still.
All three are reported rather than the most flattering one.

---

## C.5 Enterprise branch scoping — a false-positive class in the prior audit

`/home` does **not** render one surface. `app/(app)/home/page.tsx:83-107` forks on
a pure function `resolveHomeSurface`:

* `command-center` → **platform admin / enterprise workspace ONLY**
* `loading` → `HomeSkeleton`
* `self-serve` → `SelfServeHomeDashboard` — **every resolved non-enterprise user**

The applicable audience therefore gets `SelfServeHomeDashboard` (281 lines →
`HomeSections` 1,865 + `HomeDashboardSections` 1,428), and **never**
`CommandCenter`.

The prior audit's findings register attributes **51 unpaired items** on route
`/home` to `components/command-center/CommandCenter.tsx`. Those are
**NOT_APPLICABLE** for the audited audience — a false-positive class created by
attributing a route's whole import graph to the route without resolving the
conditional branch that selects between them.

The same caution applies wherever a web route forks on
`isEnterpriseWorkspace` / `isPlatformAdmin`. This audit corrects the `/home`
case explicitly and flags the general class; it does not claim to have found
every instance (see `F-COVERAGE-LEDGER.md` §5).
