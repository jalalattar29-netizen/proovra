# C — ELEMENT-LEVEL VISUAL DISCREPANCY REGISTER

> **Currency:** this document reports the BASELINE run at `f822de79a`. It was re-run on `uc6-public-launch` @ `10668edbe` — see **[J](J-reconciliation-on-recovery-branch.md)**. All findings persist; the Android fingerprint is now fixed in-repo but undeployed, and the measured counts moved slightly (tests 942→946, controls 484→485).

**Audited SHA:** `f822de79ad9397928cb59d1760e42bd63e583457`

## C.0 The honesty gate on this document

**No screenshots were captured. No simulator or device was run. Therefore no
rendered visual comparison exists, and this audit makes no rendered visual claim
for any of the 64 applicable routes.**

Why not, stated so it is not mistaken for an omission:

| Target | Blocker |
|---|---|
| iOS simulator | The audit host is `win32`. iOS simulators cannot run on Windows. |
| Android emulator | No Android SDK/AVD on the host; an Expo dev build was not produced. |
| Authenticated web render (for the comparison side) | **Deliberately not attempted.** `services/api/.env` holds live production credentials, so a local API boot reaches production data. |

What follows is therefore split into two strictly separated classes:

- **SOURCE-DEFINITIVE** — a contradiction visible in the source itself. The
  *consequence* on screen still needs a device, but the contradiction is not in doubt.
- **UNVERIFIED** — cannot be decided without rendering. Listed so it is inspected on
  hardware rather than assumed.

Every row's rendered confirmation belongs in `apps/mobile/docs/physical-acceptance.md`,
which already exists and is the correct vehicle. This register does not duplicate it.

---

## C.1 SOURCE-DEFINITIVE findings

### C.1.1 — `userInterfaceStyle: "dark"` over a light token palette, with no `StatusBar` anywhere

**Affects: all 64 applicable routes, both platforms.**

| Fact | Evidence |
|---|---|
| The shared token authority is a **light** palette | `packages/ui/src/tokens/proovra.generated.ts`: `surface.app = #F7F8FC`, `surface.card = #FFFFFF`, `ink.primary = #0F172A` (dark text) |
| Generated from the web | header: *"Source: `apps/web/lib/design-tokens/tokens.css` (:root)"*, guard `packages/ui/tests/tokens-generated.test.mjs` |
| The native shell paints with it | `apps/mobile/src/ui/shell.tsx:145` — `screen: { backgroundColor: theme.color.surface.app }` |
| **But the app declares itself dark** | `apps/mobile/app.json:12` — `"userInterfaceStyle": "dark"` |
| …with a dark splash and icon background | `app.json:15` and `:80` — `"backgroundColor": "#0F172A"` |
| **And `StatusBar` is never used** | `grep -rn "StatusBar" app/ src/` → **no matches** |

Three consequences follow from the source alone:

1. **Status-bar content is light over a near-white surface.** With
   `userInterfaceStyle: "dark"` and no explicit `StatusBar` component, iOS renders
   status-bar glyphs in the dark-mode style (light/white). The app surface is
   `#F7F8FC`. The clock, battery and signal are then white-on-near-white — **on every
   screen of the app**.
2. **A dark-to-light flash at every cold launch.** Splash `#0F172A` → first frame
   `#F7F8FC`.
3. **System-provided UI arrives dark inside a light app** — share sheet, keyboard
   appearance, system alerts, date pickers — because the OS was told the app is dark.

This is a single-line configuration contradiction with app-wide visual reach. It is the
highest-value visual item in this register and the cheapest to fix.

*Rendered severity: UNVERIFIED (needs a device). Source contradiction: not in doubt.*

### C.1.2 — RTL mirrors text but not layout direction

**Affects: all screens, Arabic locale.** Full measurement in report **A §4.2**.

| Element class | Arabic behaviour | Evidence |
|---|---|---|
| Typography | **Correct** — swaps to *Noto Sans Arabic* | `src/locale-context.tsx:111–112` |
| Text alignment | **Correct** where the primitive opts in | `src/ui/index.tsx:165–166` (`textAlign`, `writingDirection`) |
| Input alignment | **Correct** | `src/ui/index.tsx:360` |
| **Row direction** | **NOT mirrored in 42 of 45 files** | 45 files use `flexDirection: "row"`; 3 read `isRTL` |
| Logical edge styles | **Would not help** — `I18nManager.forceRTL` is never called, so `marginStart`/`paddingEnd` cannot flip. 0 uses anyway. | `grep forceRTL\|allowRTL` → none |

Concretely: icon-before-label rows, chevron affordances, list-row leading/trailing
content and section headers keep LTR order under Arabic. Text inside them is
right-aligned. The result is a mixed-direction layout.

### C.1.3 — Elevation is translated, not copied (this is correct, and is recorded so it is not re-flagged)

`apps/mobile/src/theme/theme.ts` **parses** the canonical CSS `box-shadow` strings into
RN `shadowOffset` / `shadowOpacity` / `shadowRadius`, and derives Android `elevation`
from the blur radius. Android has no offset-shadow primitive, so an exact match is
impossible; the adapter says so in its own comment.

**Expect a visible difference in shadow shape between iOS and Android.** It is a
platform limit, not a defect — but it must be *looked at* on both, because "derived
from blur radius" can still land visibly wrong.

### C.1.5 — `ink.muted` fails WCAG AA contrast on every surface it can sit on

Computed from the generated token values (`packages/ui/src/tokens/proovra.generated.ts`):

| Foreground | Background | Ratio | AA normal (4.5) | AA large (3.0) |
|---|---|---:|:--:|:--:|
| `ink.muted #94A3B8` | `surface.muted #F1F4F9` | **2.33** | ✗ | ✗ |
| `ink.muted #94A3B8` | `surface.app #F7F8FC` | **2.42** | ✗ | ✗ |
| `ink.muted #94A3B8` | `surface.card #FFFFFF` | **2.56** | ✗ | ✗ |
| `ink.secondary #475569` | `surface.card #FFFFFF` | 7.58 | ✓ | ✓ |
| `ink.primary #0F172A` | `surface.app #F7F8FC` | 16.82 | ✓ | ✓ |

`ink.muted` fails at **every** size, on **every** surface in the palette. `secondary`
and `primary` are comfortable.

**This is not a native-vs-web discrepancy.** The token is generated from
`apps/web/lib/design-tokens/tokens.css`, so web and native are equally affected and
remain in parity with each other. It is recorded here because the brief asks for
accessibility, and because a shared token is the one place a single fix reaches both
renderers.

*What is still UNVERIFIED:* which text actually uses `ink.muted`, and whether any of it
is load-bearing (timestamps, helper text, empty-state copy) rather than decorative.

### C.1.4 — Translucency tokens exist; native has no backdrop-filter

The token set carries `surface.translucentOuter/Inner/Selected/Border`
(e.g. `rgba(255,255,255,0.80)`). On web these sit over a blurred backdrop
(`backdrop-filter`). React Native has no equivalent without `expo-blur`.

`grep` for `BlurView` / `expo-blur` in `apps/mobile`: **not used**. So any surface that
web renders as frosted glass renders natively as **flat semi-transparent white**.
Whether any applicable native screen actually consumes a translucent token is
**UNVERIFIED** — it needs a render to see.

---

## C.2 UNVERIFIED — must be inspected on hardware

Per the brief, these element classes were inventoried for *where* they could differ.
None can be decided from source.

| # | Element class | Specific risk to look for | Devices |
|---|---|---|---|
| V-01 | Background | C.1.1 flash; safe-area insets under notch / Dynamic Island | iPhone, Android |
| V-02 | Typography | Inter loaded? fallback to system on cold start? Arabic line-height | all |
| V-03 | Text colour | `ink.muted` fails WCAG AA on every surface — see C.1.5. Find *where* it is used. | all |
| V-04 | Gradients | web CSS gradients have no RN equivalent without `expo-linear-gradient`; confirm none are silently flat | all |
| V-05 | Card colours | `surface.card #FFFFFF` on `surface.app #F7F8FC` — 1.5% luminance delta; card edges may be invisible without the border | all |
| V-06 | Shadows | C.1.3 — iOS vs Android divergence | iPhone **and** Android, side by side |
| V-07 | Borders | hairline `StyleSheet.hairlineWidth` vs web `1px` at 3x density | all |
| V-08 | Spacing | token spacing is RN numbers (dp) vs web px — visually smaller on high-DPI Android | Android |
| V-09 | Icons | icon set parity with web; missing glyph → blank box | all |
| V-10 | Charts | web chart library vs native rendering of the same series | all |
| V-11 | Badges | status badge colour mapping vs `proovraStatus` / `proovraStatusText` | all |
| V-12 | Buttons | `ProovraButton` variants vs web button hierarchy; disabled + loading states | all |
| V-13 | Tabs | `(tabs)/_layout.tsx` bar vs web tab strip; 6 tabs on a 375 pt phone | iPhone SE class |
| V-14 | Inputs | focus ring (`accent.a500`), error state, keyboard avoidance | all |
| V-15 | Loading | 66 of 73 native files have one — visual form vs web skeletons | all |
| V-16 | Empty | 47 of 73 — copy and illustration parity | all |
| V-17 | Error | 66 of 73 — `toSafeUserError` surface vs web error cards | all |
| V-18 | **Success** | **only 22 of 73** — see A §4.3; on 43 screens there is nothing to inspect because nothing is shown | all |
| V-19 | iPad | `supportsTablet: true`; **no tablet layout code found** — phone layout stretched to 1024 pt is the expected failure | **iPad portrait + landscape** |
| V-20 | Landscape | no orientation lock declared in `app.json`; every screen must survive rotation | all |
| V-21 | German expansion | longest-string overflow in buttons/badges/tabs | all |
| V-22 | Dynamic Type / font scale | RN does not auto-scale unless `allowFontScaling`; check truncation at 200% | all |

### C.2.1 The two highest-risk UNVERIFIED rows

- **V-19 (iPad)** — `supportsTablet: true` is declared and `src/theme/breakpoints.ts` +
  `responsive.ts` exist, but no applicable screen was found branching on a tablet
  breakpoint. A 6-tab bar and single-column lists at 1024 pt is the specific thing to
  look at.
- **V-03 (contrast)** — computed from the token values, `ink.muted` on `surface.muted`
  is ≈ 2.1:1. If muted text is used on muted surfaces anywhere, that is an
  accessibility failure, not a preference.

---

## C.3 What this register deliberately does **not** claim

- It does not say any screen "looks right". Nothing was looked at.
- It does not say any screen "looks wrong" except where source contradicts itself
  (C.1.1, C.1.2).
- It does not assign a rendered severity to anything in C.2.

**Visual parity status for all 64 applicable routes: UNVERIFIED.**
