# AUTH-LOGIN-PARITY — `/login` vs Native `(stack)/auth.tsx`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · SOURCE-ONLY · nothing rendered
**PWA:** `apps/web/app/login/page.tsx` — **1,193 lines** (148 files in the recursive tree)
**Native:** `apps/mobile/app/(stack)/auth.tsx` — **150 lines** (144 files) + `src/ui/brand.tsx`

Visual parity and OAuth *configuration* are investigated separately, as required.
Configuration defects (V2-001, V2-002) live in `E-ROOT-CAUSE-REGISTER.md`; this
document is the **page** comparison.

---

## 1 · PAGE FRAME — the whole outer design is absent

| Layer | PWA (`login/page.tsx:675-700`) | Native | Verdict |
|---|---|---|---|
| Full-bleed background image | `<img src="/assets/hero/register-logo...png" className="h-full w-full object-cover object-center">` (`:677-682`) | **none** | **MISSING ASSET** |
| Image fit / position | `object-cover` / `object-center` | n/a | — |
| Readability overlay | `linear-gradient(90deg, rgba(255,229,207,0.10) 0%, rgba(255,255,255,0.02) 45%, rgba(33,22,45,0.10) 100%)` (`:688`) | **none** | **MISSING** |
| Page container | `.page.landing-page` → `relative min-h-screen overflow-hidden` | `ProovraScreen width="form"` → `backgroundColor: #F7F8FC` flat | **VISUAL MISMATCH** |
| Marketing header | `<MarketingHeader />` (`:691`) — logo, nav, "Request a demo", language switcher | **none** | **VALID PLATFORM ADAPTATION** (no acquisition funnel in an installed app) |
| Layout | two-column grid `lg:grid-cols-[0.92fr_0.88fr] lg:items-start`, `max-w-7xl`, `gap-10` (`:695-697`) | single column, `FORM_MAX_WIDTH = 480` (`breakpoints.ts:21`) | **VALID PLATFORM ADAPTATION** for phone; **DIVERGENT on tablet**, where the PWA's two-column layout is the reference and native still clamps to 480px |
| Main padding | `px-6 pb-14 pt-24 md:px-8 md:pb-20 md:pt-28` (`:693`) | `paddingHorizontal: theme.space.s4` (16) | **DIFFERENT** |

### Asset root cause
`/assets/hero/register-logo...png` exists in the PWA
(`apps/web/public/assets/hero/`). `apps/mobile/assets/` contains **5 files, all
icons** — `icon.png`, `adaptive-icon.png`, `adaptive-icon-monochrome.png`,
`splash-icon.png`, `brand-mark.png`. The hero artwork is **not in the native
bundle**, is imported by nothing, and no `ImageBackground` exists anywhere in
`apps/mobile`. **Class: MISSING ASSET** — not a mapping or styling error.

---

## 2 · AUTH CARD

| Property | PWA (`login/page.tsx:758-769`) | Native `ProovraCard` (`src/ui/index.tsx:554-561`) | Verdict |
|---|---|---|---|
| Background | `rgba(255,255,255,0.74)` — **translucent** | `theme.color.surface.card` = `#FFFFFF` — **opaque** | **VISUAL MISMATCH** |
| Border radius | `28px` (`rounded-[28px]`) | `theme.radius.card` = **14** | **DIFFERENT (2×)** |
| Backdrop blur | `auth-premium` + `backdrop-blur` | **none** (RN has no backdrop-filter) | **PLATFORM LIMITATION** — declare, do not silently drop |
| Decorative overlays | two radial gradients: `circle_at_85%_15%, rgba(255,179,107,0.16)` and `circle_at_12%_8%, rgba(255,255,255,0.55)` (`:768-769`) | **none** | **MISSING** |
| Border | per `.auth-card` | `hairlineWidth` × `rgba(15,23,42,0.09)` | **DIFFERENT** |
| Shadow | `shadow-[0_10px_24px_rgba(33,22,45,0.10)]` on the eyebrow chip; card shadow per CSS | `theme.elevation.card` → opacity **0.04**, radius **2** | **DIFFERENT** (much flatter) |
| Padding | per CSS | `theme.space.s5` = 20 | — |
| Overflow | `overflow-hidden` | — | — |

---

## 3 · CONTENT — exact text comparison

Literal user-visible strings extracted from each page's own files.

### 3.1 Present on PWA, absent on Native (14)

| PWA string | Source | Verdict |
|---|---|---|
| `"Sign in to PROOVRA"` | `:153` (page `<h1>`) | **MISSING** — Native shows only the `PROOVRA` wordmark |
| `"Welcome Back"` | eyebrow chip | **MISSING** |
| `"Return to your"` / `"workspace."` | `:711` headline | **MISSING** — the entire left column |
| `"Sign in to continue reviewing evidence records, verification reports, cases, workspaces, …"` | left column body | **MISSING** |
| `"Account access"` | card eyebrow | **MISSING** |
| `"Continue with your preferred sign-in method and return safely to your PROOVRA workspace."` | card subtitle | **MISSING** |
| `"Sign in with Email"` | `:1002` | **MISSING** — Native's button is `"Sign in"` |
| `"I agree to the"` + `"Terms of Service"` / `"Privacy Policy"` / `"Cookie Policy"` | consent row | **DIFFERENT** — see §5 |
| `"Verify your email address"` | unverified state | **DIFFERENT** — Native: `"Resend verification email"` |
| `"Please verify your email address before signing in. The link in your inbox will activate …"` | unverified copy | **MISSING** |
| `"Use a different email"` | `:1087` | **MISSING** |
| `"Preparing the sign-in form…"` | loading state | **MISSING** — Native has no page-level loading state |

### 3.2 Present on both

| Requirement | PWA | Native | Verdict |
|---|---|---|---|
| Email field | `"Email"` | `"Email"` + placeholder `"you@example.com"` | **PAIRED**; Native adds a placeholder the PWA lacks |
| Password field | `"Password"` | `"Password"` + placeholder `"Your password"` | **PAIRED** |
| Forgot password | `"Forgot password?"` | `"Forgot password?"` | **EXACT MATCH** |
| Google | `"Continue with Google"` | `"Continue with Google"` | **EXACT MATCH** |
| Apple | `"Continue with Apple"` | `"Continue with Apple"` | **EXACT MATCH** |
| Brand | `"PROOVRA"` | `"PROOVRA"` | **PAIRED** |

### 3.3 Native-only (3)

| Native string | Verdict |
|---|---|
| `"Create account"` (`auth.tsx:104`) | **NATIVE-ONLY placement** — the PWA reaches `/register` through `MarketingHeader`, which Native does not have. **Correct compensation.** |
| `"or continue with"` divider | **NATIVE-ONLY** — a reasonable affordance |
| `"By continuing you agree to the Terms and acknowledge the Privacy Policy."` | **DIFFERENT CONTROL** — see §5 |
| tagline `"Sign in to capture and prove digital evidence."` | **NATIVE-ONLY** — partially compensates for the missing left column |

### 3.4 Debug strings in the PWA
`"Auth Debug"`, `"Apple:"`, `"nextUrl:"`, `"acceptLegal:"` appear in
`login/page.tsx`. Not compared as product copy; flagged as PWA-side debug surface.

---

## 4 · CONTROLS AND TYPOGRAPHY

| Control | PWA | Native | Verdict |
|---|---|---|---|
| Email input | custom, `background: rgba(255,255,255,0.84)` (`:861`) | `ProovraInput`, `borderColor` focus `#7C3AED` / idle `rgba(15,23,42,0.14)` | **DIFFERENT** — Native has no translucent fill |
| Password input | `rgba(255,255,255,0.84)` (`:908`) | same as above, `secureTextEntry` | **DIFFERENT** |
| Password visibility toggle | present in PWA | **absent** in Native (`secureTextEntry` with no reveal) | **MISSING CONTROL** |
| Primary button | `linear-gradient(90deg,#C92C63 0%,#D63E76 38%,#E14A68 68%,#8B3DE6 100%)` (`:715`) | `ProovraButton` primary — flat `theme.color.accent.a500` = `#7C3AED`, `borderRadius: 999` | **VISUAL MISMATCH** — a 4-stop gradient vs a flat fill |
| OAuth buttons | styled per PWA | `variant="secondary"`, flat | **DIFFERENT** |
| Headline type | per CSS | `theme.type.size.h1` = **22px**, `letterSpacing: 2` (`brand.tsx:45`) | **DIFFERENT** |
| Body type | per CSS | `theme.type.size.body` = 14 / `label` = 12 | **DIFFERENT** |
| Font family | web font stack (`app/fonts.ts`) | `theme.type.family.*` resolves to **undefined** in the evaluated token module — see §7 | **UNRESOLVED** |

---

## 5 · LEGAL CONSENT — different control, enforcement preserved

| | PWA | Native |
|---|---|---|
| Control | **checkbox**, `type="checkbox"`, `checked={acceptLegal}` (`register/page.tsx:1504-1507`; the login page carries the same consent row) | **passive sentence**, no control |
| Links | three: Terms of Service, Privacy Policy, Cookie Policy | plain text, **no links** |
| Enforcement | submit is **gated** — `if (!acceptLegalRef.current) { … }` (`register/page.tsx:696`) | enforced **server-side**: HTTP `428 LEGAL_REACCEPT_REQUIRED` → `triggerLegalGate` → `/legal-acceptance` (`src/auth/legal-gate.ts`, wired at `src/api.ts:1`) |

**Verdict: VALID PLATFORM ADAPTATION on enforcement, CONTENT MISMATCH on
presentation.** Consent *is* enforced on Native, at a different point in the
flow. But the three legal documents are **links on the PWA and unlinked plain
text on Native**, so a Native user cannot read them from this screen.
Native does have `/legal/[slug]` — it is simply not linked from here.

---

## 6 · STATES

| State | PWA | Native | Verdict |
|---|---|---|---|
| Loading (page) | `"Preparing the sign-in form…"` | **none** | **MISSING** |
| Submitting | `busy` disables inputs | `ProovraButton loading={busy}` | **PAIRED** |
| Field errors | `fieldErrors` per field | `ProovraFormField error={…}` on Password only (`auth.tsx:81`) — **the email field shows no error** | **DIFFERENT** |
| Unverified email | dedicated panel + `"Use a different email"` | single `"Resend verification email"` ghost button | **REDUCED** |
| OAuth error | per provider | merged: `error ?? oauthError` (`:65`) | **DIFFERENT** — one slot for two sources |
| Offline | — | `OfflineBanner` in the shell | **NATIVE-ONLY** |

---

## 7 · EXPLICITLY UNRESOLVED

1. **Font family.** `theme.type.family.regular` / `.bold` evaluate to `undefined`
   in the generated token module, yet `NavButton` and `brand.tsx` consume
   `fontFamilyBold` from `useLocale()`. The actual family is resolved by the
   locale context at runtime. **Cannot be paired against the web's font stack
   from source.** Minimal evidence: the value `useLocale()` returns per locale.
2. **Which CSS declaration wins** for any web class with competing rules —
   cascade and conditional classes are runtime facts.
3. **Tablet layout.** The PWA's two-column grid is a `lg:` breakpoint behaviour;
   Native clamps to `FORM_MAX_WIDTH = 480` at every size. Whether that is
   acceptable on a 1024pt iPad is a design decision, not a source fact — but the
   **divergence** is a source fact and is recorded.
4. **Nothing was rendered.** No statement here is an observed pixel.

---

## 8 · ROOT CAUSES

| ID | Class | Statement |
|---|---|---|
| **LG-1** | **MISSING ASSET** | The `/assets/hero/register-logo...png` full-bleed background is absent from the native bundle (shared with `SB-1`: native ships 5 assets, all icons) |
| **LG-2** | **MISSING STRUCTURAL COMPONENT** | No left column, no eyebrow chip, no card eyebrow/subtitle, no gradient overlay, no radial decorations |
| **LG-3** | **DIFFERENT THEME VALUE** | Card opaque `#FFFFFF` vs translucent `rgba(255,255,255,0.74)`; radius 14 vs 28; shadow opacity 0.04 vs 0.10; primary button flat `#7C3AED` vs a 4-stop gradient |
| **LG-4** | **MISSING CONTROL** | Password visibility toggle; per-field email error; page loading state |
| **LG-5** | **CONTENT MISMATCH** | 14 PWA strings absent; `"Sign in"` vs `"Sign in with Email"`; legal documents unlinked |
| **LG-6** | **PLATFORM LIMITATION (declared)** | `backdrop-filter` has no React Native equivalent |
