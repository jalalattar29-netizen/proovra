# N — VISUAL PARITY: resolved source-defined styles, both platforms

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · SOURCE-ONLY · nothing rendered
**Instruments:** `05-style-index.mjs` (web CSS → literals, native theme → literals by **evaluating** the real modules), `11-compare-scoped.mjs`, `paired-styles.json`

---

## N.0 The finding that governs every text element on every screen

### Native loads no fonts at all.

| Evidence | Result |
|---|---|
| `expo-font` in `apps/mobile/package.json` | **absent** |
| `expo-font` installed under `apps/mobile/node_modules` | **absent** |
| `useFonts` / `Font.loadAsync` anywhere in `apps/mobile` | **none** |
| `.ttf` / `.otf` files anywhere in `apps/mobile` (excluding `node_modules`) | **none** |
| What the code asks for | `fontFamily = isRTL ? "Noto Sans Arabic" : "Inter"` — `src/locale-context.tsx:111-112` |

React Native resolves an unregistered `fontFamily` string by falling back to the
platform system face. With no font registered, **every** native text element
renders in **San Francisco (iOS) / Roboto (Android)** — not Inter, and not Noto
Sans Arabic.

### And the family it asks for is not the web's family either

`apps/web/app/fonts.google.ts`:

| Role | Web family | CSS variable |
|---|---|---|
| Body | **Plus Jakarta Sans** (400/500/600/700/800) | `--font-jakarta` |
| Headers | **Inter Tight** | `--font-header` |
| Arabic | **Noto Sans Arabic** | `--font-arabic` |

Native asks for `"Inter"` — which is neither Plus Jakarta Sans nor Inter Tight —
and gets neither, because nothing is loaded.

**Class: MISSING ASSET + INCORRECT THEME VALUE. Category A. Blast radius: every
text element on all 64 routes.** This is the single largest visual root cause in
the audit and it is invisible to a token comparison, because the typeface is not
a token — it is a runtime string in the locale context.

---

## N.1 Image assets

| | PWA | Native |
|---|---:|---:|
| Image assets in the app | **56** (`apps/web/public/assets/**`) | **5** (`apps/mobile/assets/`) |
| Background artwork | `backgrounds/app-shell-bg.png`, `backgrounds/proovra-page-hero-bg.png`, `cards/sidebar.png`, `cards/footer-card.png`, `cards/icon-card.png`, `cards/vertical-card.png` | **none** |
| Hero artwork | 9 under `hero/` | **none** |
| Branding | 5 under `branding/` | `brand-mark.png` only, used **only** by `src/ui/brand.tsx:16` |
| Industry / verification / use-case imagery | 13 | **none** |
| Vendor logos (SVG) | 20 under `logos/` | **none** |
| `ImageBackground` usage in native | — | **zero occurrences** |

Native's five assets are `icon.png`, `adaptive-icon.png`,
`adaptive-icon-monochrome.png`, `splash-icon.png`, `brand-mark.png` — four
launcher/splash icons and one mark.

**Class: MISSING ASSET.** Root cause shared by `SB-1` (sidebar),
`LG-1` (login), `RG-2` (register).

---

## N.2 Colour — per route, at element level

Measured per applicable route by resolving each element's literal `className`
through the 30 authored stylesheets (5,458 rules, 2,515 classes, 235 `:root`
custom properties, `var()` chased transitively) and each native element's
`theme.color.*` read through the evaluated token module.

| | Value |
|---|---:|
| **PWA-only colour uses** (resolved value with no native counterpart value) | **1,600** |
| Shared colour uses | 178 |
| Mean distinct colours per colour-bearing route | PWA **41.3** vs native **18.4** (43 routes) |
| Distinct hex in authored web CSS | 305 |
| Distinct hex in `tokens.css` (the legitimate home) | 53 |
| **Distinct hex written outside the token layer** | **295** (1,752 occurrences) |
| Distinct hex in the native token set | 46 |
| Hardcoded hex in native source | **6** |

The token pipeline is sound and the native adapter obeys it. The divergence is
that the **web** renders from a ~295-colour palette that exists in no token and
therefore has no native counterpart value. Worst concentrations:
`capture-v2.css` (776 hardcoded hex), `command-center.css` (344, enterprise-only),
`capture-workspace.css` (243), `globals.css` (123), `settings.css` (112).

---

## N.3 Per-element pairing — what is actually possible, stated honestly

| | Count |
|---|---:|
| Matched element pairs (exact + copy-differs) | **111** |
| …with a **literal** web `className` | **16** |
| …with a **literal** native `style` | **6** |
| Web style properties resolved on those 16 | 232 |

**Only 16 of 111 matched pairs can be compared property-by-property.** The other
95 style through component variants (`<ProovraButton variant="secondary">`) or
runtime-built class expressions, on one side or both.

This is not an instrument limitation to be worked around — it is how the two
codebases are built. The meaningful comparison is therefore at the **primitive**
level (N.4), and that is where it is done.

---

## N.4 Design-system primitives — resolved values, side by side

### Primary button

| Property | PWA `.app-primary-action` | Native `ProovraButton` primary | Verdict |
|---|---|---|---|
| Background | `linear-gradient(135deg, #7…)` | `theme.color.accent.a500` = **`#7C3AED`** (flat) | **VISUAL MISMATCH** — gradient vs flat |
| Foreground | `#ffffff` | `theme.color.ink.inverse` = `#F8FAFC` | **DIFFERENT** |
| Border radius | **`8px`** | `theme.radius.pill` = **`999`** | **VISUAL MISMATCH** — rounded rect vs pill. Different silhouette |
| Padding | `0 14px` | `paddingVertical: 12`, `paddingHorizontal: 20` | **DIFFERENT** |
| Font size | `12.5px` | `theme.type.size.label` = `12` | close |
| Font weight | `650` | per `ProovraText` weight | **DIFFERENT** |
| Min height | — | `44` (WCAG touch target) | **VALID ADAPTATION** |

### Auth / social button

| Property | PWA `.auth-social-btn` | Native `ProovraButton` secondary | Verdict |
|---|---|---|---|
| Min height | `52px` | `44` | **DIFFERENT** |
| Border radius | `16px` | `999` (pill) | **VISUAL MISMATCH** |
| Padding | `0 18px` | `0 20` | close |
| Font size | `0.96rem` (≈15.4px) | `12` | **DIFFERENT** |
| Font weight | `600` | — | — |
| Background | `linear-gradient(180deg …)` | flat | **VISUAL MISMATCH** |

### Card

| Property | PWA auth card (`login/page.tsx:758-769`) | Native `ProovraCard` (`ui/index.tsx:554-561`) | Verdict |
|---|---|---|---|
| Background | `rgba(255,255,255,0.74)` translucent | `theme.color.surface.card` = `#FFFFFF` opaque | **VISUAL MISMATCH** |
| Border radius | `28px` | `theme.radius.card` = **`14`** | **DIFFERENT (2×)** |
| Border | per CSS | `hairlineWidth` × `rgba(15,23,42,0.09)` | **DIFFERENT** |
| Shadow | `0 10px 24px rgba(33,22,45,0.10)` | `elevation.card` → opacity **0.04**, radius **2**, offset parsed from `--shadow-card` | **DIFFERENT** — far flatter |
| Backdrop blur | present | **impossible in RN** | **PLATFORM LIMITATION (declared)** |

### Input

| Property | PWA `.app-input` | Native `ProovraInput` | Verdict |
|---|---|---|---|
| Padding | `8px 12px` | `paddingTop: 12` when multiline; base per style | close |
| Border | `1px solid rgba(15,23,42,…)` | `borderColor`: focus `#7C3AED`, idle `theme.color.border.strong` = `rgba(15,23,42,0.14)` | **DIFFERENT** |
| Border radius | **`6px`** | `theme.radius.md` = **`8`** | **DIFFERENT** |
| Background | `#FFFFFF` | `theme.color.surface.card` = `#FFFFFF` | **MATCH** |
| Colour | `#0F172A` | `theme.color.ink.primary` = `#0F172A` | **MATCH** |
| Focus ring | per CSS | border colour change only | **DIFFERENT** |

### Geometry tokens

| Token | PWA | Native | Verdict |
|---|---|---|---|
| Page max width | `--page-max-w` | `theme.layout.pageMaxW` = `1360` | shared token |
| Header height | `--app-topbar-h` = `72px` | `theme.layout.headerH` = `72` | **MATCH** (but native renders no header) |
| Sidebar collapsed / expanded | `68px` / `240px` | rail `220` | **DIFFERENT** |
| Form max width | — | `FORM_MAX_WIDTH` = `480` | native-only |

---

## N.5 What remains UNRESOLVED on this dimension

| Item | Count | Why |
|---|---:|---|
| Which CSS declaration wins | all | Cascade + specificity + conditional class application are **runtime facts**. The registers record the competing rules per route rather than asserting a winner |
| Web classes with no matching CSS rule | **5,430** | See N.6 |
| `className` built from a runtime expression | **750** | The class string does not exist until render |
| Native `style={[…]}` arrays with computed members | included above | the member is a variable, not a literal |
| Hover / focus / active / pressed / disabled variants, paired per element | not done | blocked on N.3 — only 16 pairs carry literal per-element styles |
| Light/dark variants | not compared | `tokens.css` declares no dark ramp; native has no `useColorScheme` |

## N.6 The 5,430 unmatched classes — diagnosed, not assumed

The mandate warns against classifying every unmatched class as a defect. A
sample audit of the class strings shows they fall into four groups, and **none of
them is a visual defect**:

1. **Stock Tailwind utilities** the resolver's small table does not cover
   (`lg:grid-cols-[0.92fr_0.88fr]`, `bg-[radial-gradient(...)]`, `pt-24`,
   `md:px-8`). These are real, generated by Tailwind at build time from
   `apps/web/tailwind.config.ts` (`theme: { extend: {} }` — stock values only).
   **Resolvable in principle; the resolver reports them rather than guessing.**
2. **Arbitrary-value utilities** (`text-[0.74rem]`, `rounded-[28px]`,
   `shadow-[0_10px_24px_rgba(33,22,45,0.10)]`) — the value is *in the class name*
   and is recoverable by parsing, which this pass does not do.
3. **State/variant prefixes** (`hover:`, `focus-visible:`, `data-[state=open]:`)
   whose base rule exists but whose prefixed form does not appear as a literal
   selector.
4. **Genuinely absent rules** — a class referenced with no rule anywhere.

**They are reported as UNRESOLVED, not as defects.** Quantifying group 4
specifically is open item **Q4** in `CONTINUATION-MANIFEST.md`.

---

## N.7 Root causes

| ID | Class | Statement | Blast radius |
|---|---|---|---|
| **VIS-1** | **MISSING ASSET + INCORRECT VALUE** | No font is loaded in native (`expo-font` absent, no `useFonts`, zero font files); the requested `"Inter"` is not the web's Plus Jakarta Sans either | **every text element, all 64 routes** |
| **VIS-2** | **MISSING ASSET** | 56 web image assets vs 5 native, all icons; no background artwork exists in the native bundle; no `ImageBackground` anywhere | sidebar, login, register, app shell |
| **VIS-3** | **DIFFERENT THEME VALUE** | Button radius `8px`/`16px` vs pill `999`; card radius `28`/`14`; card opaque vs translucent; shadow 0.04 vs 0.10; gradients vs flat fills | every screen |
| **VIS-4** | **WEB BYPASSES ITS OWN TOKENS** | 295 distinct hex outside the token layer (1,752 occurrences) with no native counterpart value; 1,600 PWA-only colour uses across applicable routes | every screen |
| **VIS-5** | **INCORRECT TOKEN MAPPING** | `theme.color.nav.*` exists with byte-identical values and `shell.tsx` uses none of them (see `SIDEBAR-PARITY.md` §C) | navigation |
