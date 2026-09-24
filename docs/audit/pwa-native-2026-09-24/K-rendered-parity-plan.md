# K — PRACTICAL PLAN FOR RENDERED PWA ↔ NATIVE COMPARISON

**Purpose:** close the one dimension the audit could not touch — **actual rendered
visual parity and device behaviour** — without starting another multi-week audit.

**Current state: 0 screenshots, 0 simulator runs, 0 device runs, 0/62 physically
accepted.** Nothing below is done.

---

## K.0 The honest framing

This is not "finish the audit". The source-level work (A–I, J) is done and reproducible.
What remains is **evidence that cannot be produced from a repository at all** — and
roughly half of it cannot be produced from *this host*.

The plan is deliberately staged so that **Stage 1 alone** — a few days, one machine,
no new hardware — converts the largest single class of finding (C.1.1, app-wide) from
UNVERIFIED to decided.

## K.1 What already exists, and what does not

| Half | Tooling | State |
|---|---|---|
| **Web (PWA) reference captures** | Playwright, `playwright.config.ts`, **10 per-surface layout projects** (`search-layout`, `evidence-detail-layout`, `attention-layout`, `operations-layout`, `capture-layout`, `billing-layout`, `settings-layout`, `intake-links-layout`, `point7`, `chromium`) with existing `toHaveScreenshot` usage | **Built. Reuse it.** |
| **Native captures** | Maestro / Detox | **Neither is installed** (`apps/mobile/package.json`, no `.maestro/`) |

So the plan adds **one** tool to the native side and reuses the web side as-is. It does
not introduce a second screenshot framework for the web.

## K.2 The four real blockers, in the order they bite

| # | Blocker | Why it blocks rendering | Cheapest resolution |
|---|---|---|---|
| **B1** | `services/api/.env` holds **live production credentials** | Any local boot to render an authenticated screen reaches production data. This is why the audit rendered nothing. | A dedicated non-production env + seeded DB. **Prerequisite for every authenticated capture, web and native.** |
| **B2** | No Android SDK / AVD on this host | No native rendering at all today | Android Studio + one AVD (Pixel 7, API 34). Runs on this Windows host. |
| **B3** | Host is `win32` | iOS simulators cannot run, ever | A real iPhone/iPad with an EAS `preview` build **or** a macOS runner |
| **B4** | Apple Team ID unreadable (J.5, defect #1) | Universal-link journeys (intake, portal, invites) cannot be exercised on iOS | Read the Team ID from the Apple Developer account, then deploy |

**B1 is the gate.** Unauthenticated surfaces (login, register, legal, verify, pricing,
support) can be captured without it; everything behind auth cannot.

## K.3 Stage 1 — Decide the app-wide visual findings (≈ 1–2 days, this host, no auth)

Smallest step with the largest return. Needs **B2 only**.

1. Install Android Studio; create one AVD (Pixel 7, API 34).
2. `eas build --profile preview --platform android`, or a local dev build, installed on
   the AVD.
3. Capture **8 unauthenticated screens**: launch/splash, `/auth`, `/register`,
   `/forgot-password`, `/legal/[slug]`, `/verify`, `/support`, `/pricing`.

**What this settles immediately**

| Finding | How it is decided |
|---|---|
| **C.1.1** `userInterfaceStyle: "dark"` over a light palette, no `StatusBar` | One screenshot. Either the status-bar glyphs are legible on `#F7F8FC` or they are not. **Affects all 64 routes** — the single highest-value capture in this plan. |
| Splash → first-frame flash (`#0F172A` → `#F7F8FC`) | Screen-record the cold launch |
| **C.1.2** RTL row direction | Set the AVD to Arabic; capture the same 8 screens. 42 of 45 row files are predicted LTR |
| **V-21** German expansion | Set the AVD to German; look for truncation |
| **V-03** `ink.muted` contrast in situ | Confirms *where* the failing token is actually used |

Stage 1 does **not** need B1, B3 or B4. It is genuinely a two-day task.

## K.4 Stage 2 — Authenticated parity on one platform (≈ 1 week, needs B1)

1. **Build a safe environment** (this is the real work): `services/api/.env.staging`
   with non-production credentials, a seeded database, and a guard that refuses to boot
   if the DSN resolves to the production host. Until this exists, no authenticated
   render should be attempted by anyone.
2. Point Playwright's existing layout projects at it and capture the **web reference set**
   for the 64 applicable routes.
3. Add **Maestro** to `apps/mobile` (`.maestro/` YAML flows + `maestro test --format junit`).
   Chosen over Detox because Expo-managed RN needs no native test harness, flows are
   declarative, and it runs on the AVD on Windows *and* on a real iPhone later.
4. Capture the matching native set on the AVD.
5. Produce a **side-by-side contact sheet** per route — web left, native right — and walk
   the 22 element classes in **C.2** against it.

**Priority order** — by control density and endpoint-gap concentration, so the deepest
surfaces are seen first:

```
/home  /evidence  /evidence/[id]  /cases  /cases/[id]  /capture
/settings  /billing  /search  /notifications  /collaboration-teams  …
```

**Deliverable:** C is rewritten from source-inferred to **measured**, per route, per state
(loading / empty / error / success — note 43 of 62 screens have no explicit success
affordance to capture, which is itself the finding).

## K.5 Stage 3 — iOS (needs B3; B4 for link journeys)

Two viable routes; pick one.

| Option | Cost | Gets you |
|---|---|---|
| **A — real iPhone + iPad**, EAS `preview` build, Maestro over USB | An iPhone, an iPad, ~2 days | Real ReplayKit, real `crypto.subtle`, real App Store conditions. **Required regardless** — the `physicallyAccepted` column can only be ticked here. |
| **B — macOS runner** (GitHub Actions `macos-latest`, or a hosted Mac) with the iOS simulator | ~$0.08/min CI, or ~$100/mo | Repeatable simulator screenshots in CI, no hardware. **Cannot** prove ReplayKit, `crypto.subtle`, or that bytes reached storage. |

**Recommendation: A, then B.** Option A is not optional — F.5 lists seven things only
hardware can establish. Option B is worth adding afterwards purely to stop regressions.

iPad is its own line item, not a free extra: `supportsTablet: true` is declared, no
tablet layout code was found, and there is no orientation lock — so **portrait and
landscape are separate captures** (**V-19**, **V-20**).

## K.6 Stage 4 — Lock it in (≈ 2 days)

1. Commit the web and native reference sets as baselines.
2. Run both in CI: Playwright on the existing projects, Maestro on an AVD.
3. A diff beyond threshold fails the build.
4. Execute `apps/mobile/docs/physical-acceptance.md` on real hardware and set
   `physicallyAccepted: true` **per row, by a human**. It may never be set from CI — the
   ledger says so and is right.

## K.7 Sequencing and honest effort

```
Stage 1  Android AVD, 8 unauth screens        1–2 days   host only       ← start here
  └─ settles C.1.1 (app-wide), C.1.2, V-21, V-03

B1       safe non-production API env          2–3 days   BLOCKS Stage 2
Stage 2  authenticated web+Android, 64 routes  ~1 week   needs B1
Stage 3a real iPhone + iPad                    2 days    needs hardware
Stage 3b macOS runner (optional, regression)   1 day
Stage 4  CI baselines + physical acceptance    2 days
                                              ─────────
                                              ~3 weeks wall-clock,
                                              of which Stage 1 is 2 days
```

Do **H-1a / H-1b / H-2** (the App Links deploy) before Stage 3 — otherwise the intake,
portal and invite journeys cannot be exercised on any device, and several steps of
`physical-acceptance.md` will fail for a deployment reason that looks like a code defect.

## K.8 What this plan explicitly refuses to do

- **No second audit.** A–I and J stand; K only adds rendered evidence to C, F and the
  journey matrix.
- **No re-derivation of scope.** The 208/64 inventory is settled and reproducible.
- **No rendering against production.** B1 is a prerequisite, not a nicety.
- **No claim that CI screenshots equal physical acceptance.** They are different
  dimensions and the ledger already separates them correctly.
- **No `physicallyAccepted: true` set by any automation, ever.**

---

**Until Stage 1 is executed, the requested exhaustive visual audit remains incomplete,
and every visual statement in this artifact set stays labelled UNVERIFIED.**
