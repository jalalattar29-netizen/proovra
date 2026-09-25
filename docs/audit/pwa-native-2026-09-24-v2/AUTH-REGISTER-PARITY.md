# AUTH-REGISTER-PARITY — `/register` vs Native `(stack)/register.tsx`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · SOURCE-ONLY · nothing rendered
**PWA:** `apps/web/app/register/page.tsx` — **1,715 lines** (147 files in the recursive tree)
**Native:** `apps/mobile/app/(stack)/register.tsx` — **107 lines** (140 files) + `src/ui/password-rules.tsx`, `src/ui/brand.tsx`

---

## 1 · PAGE FRAME — identical divergence to `/login`

`/register` uses the **same** outer frame as `/login`:

| Layer | PWA (`register/page.tsx:845-861`) | Native | Verdict |
|---|---|---|---|
| Full-bleed background | `<img src="/assets/hero/register-logo...png" className="h-full w-full object-cover object-center">` (`:845-848`) | **none** | **MISSING ASSET** (shared root cause `LG-1` / `SB-1`) |
| Marketing header | `<MarketingHeader />` (`:857`) | **none** | **VALID PLATFORM ADAPTATION** |
| Layout | `grid gap-10 lg:grid-cols-[0.92fr_0.88fr] lg:items-start` (`:861`) | single column, `FORM_MAX_WIDTH = 480` | **VALID for phone, DIVERGENT on tablet** |
| Auth card | `rgba(255,255,255,0.74)`, `rounded-[28px]`, blur, radial overlays | `ProovraCard` — `#FFFFFF`, radius **14**, elevation opacity **0.04** | **VISUAL MISMATCH** (shared `LG-3`) |

Everything in `AUTH-LOGIN-PARITY.md` §1–§2 applies unchanged. Not repeated.

---

## 2 · THE MOST SERIOUS FINDING — no OAuth on Native registration

| | PWA | Native |
|---|---|---|
| `"Continue with Google"` | **present** | **ABSENT** |
| `"Continue with Apple"` | **present** | **ABSENT** |
| `useOAuth` import | — | **not imported** (`register.tsx:1-17` — verified, no `useOAuth`, no `oauthGoogle`, no `oauthApple`) |
| Subtitle | *"Create your account using **Google, Apple, or email** and continue directly into your PROOVRA workspace."* | — |

**A Native user cannot create an account with Google or Apple.** Email + password
is the only path. `(stack)/auth.tsx` (sign-in) *does* wire `useOAuth`, so this is
not a platform limitation — the same hook exists and is unused here.

**Class: MISSING CONTROL.** Category A, confirmed by source. Distinct from the
OAuth *configuration* defects V2-001/V2-002, which concern whether the buttons
work where they do exist.

---

## 3 · FORM FIELDS

| Field | PWA | Native | Verdict |
|---|---|---|---|
| Name | — | `"Name"` + placeholder `"Your name"` (`register.tsx`) | **NATIVE-ONLY** — extra data captured at signup |
| Email | `"Email address"`, `autocomplete="email"` | `"Email"` + `"you@example.com"` | **COPY DIFFERS** (`"Email address"` → `"Email"`) |
| Email availability check | live: `"Checking email…"` → `"Email is available."` / `"An account already exists for this email."` / `"Could not verify email — you can still try to register."` | **absent** | **MISSING BEHAVIOUR** — 4 states |
| Email validation | `"Enter a valid email address."` | **absent** | **MISSING** |
| Password | `"Password"`, `autocomplete="new-password"` | `"Password"` + placeholder `"At least 12 characters"` | **PAIRED** |
| Password strength meter | `"Password strength"` | **absent** | **MISSING CONTROL** |
| Password requirements | `"Password requirements"` | `ProovraPasswordRules` (`register.tsx:85`), `visible={password.length > 0}` | **PRESENT — VALID ADAPTATION** (verified: a real component, not a label) |
| Caps Lock warning | `"Caps Lock is enabled"` | **absent** | **MISSING** — RN cannot detect Caps Lock; **PLATFORM LIMITATION**, declare it |
| Confirm password | `"Confirm password"`, `autocomplete="new-password-confirm"`, `"Passwords do not match."` | **absent** | **MISSING CONTROL** |
| Legal consent | **checkbox**, gated at `:696`, three links | passive sentence, no links | see §5 |

---

## 4 · CONTENT — exact text comparison

### 4.1 PWA has 40 literal strings; Native has 15.

**Absent from Native (25):**

| PWA string | Class |
|---|---|
| `"Create Account"` (eyebrow) | MISSING |
| `"Create your secure"` / `"account."` (headline, wraps `PROOVRA`) | MISSING — the entire left column |
| `"Register to manage evidence records, verification pages, reports, and protected review …"` | MISSING |
| `"Account setup"` (card eyebrow) | MISSING |
| `"Create your account"` (card headline) | MISSING |
| `"Create your account using Google, Apple, or email and continue directly into your PROOVRA workspace."` | MISSING — and **inaccurate for Native** (§2) |
| `"Continue with Google"` · `"Continue with Apple"` | **MISSING CONTROL** (§2) |
| `"Email address"` | COPY DIFFERS |
| `"Enter a valid email address."` · `"Checking email…"` · `"Email is available."` · `"An account already exists for this email."` · `"Could not verify email — you can still try to register."` | MISSING (5 states) |
| `"Sign in"` · `"Forgot password?"` | MISSING — Native offers only `"Already have an account? Sign in"` |
| `"Caps Lock is enabled"` | PLATFORM LIMITATION |
| `"Password strength"` | MISSING |
| `"Confirm password"` · `"Passwords do not match."` | MISSING |
| `"I agree to the"` · `"Terms of Service"` · `"Privacy Policy"` · `"Cookie Policy"` | CONTENT MISMATCH (§5) |
| `"Creating account…"` | MISSING — Native uses `ProovraButton loading` with no text change |
| `"Security and privacy commitments"` | MISSING — a whole section |
| `"Change email"` | MISSING (verify state) |

### 4.2 Verify-email state — paired but reworded

| Requirement | PWA | Native | Verdict |
|---|---|---|---|
| Heading | `"Verify your email"` / `"Verify your email address"` | `"Check your email"` | **COPY DIFFERS** |
| Body | `"We've sent a verification email to"` + `". Please open the email and click the verification link to activate your PROOVRA account…"` | `"We sent a verification link to"` + `". Open it on this device to finish creating your account and accept the terms."` | **COPY DIFFERS** — Native's *"on this device"* is a correct platform-specific instruction |
| Spam-folder guidance | `"If you don't see the email within a minute, check your spam folder. Verification …"` | **absent** | **MISSING** |
| Resend | present | `"Resend email"` | **PAIRED** |
| Change email | `"Change email"` | **absent** | **MISSING CONTROL** |
| Back to sign in | `"Back to sign in"` | `"Back to sign in"` | **EXACT MATCH** |

### 4.3 Native-only (2)

| String | Verdict |
|---|---|
| `"Name"` / `"Your name"` | **NATIVE-ONLY field** — assess against product requirements; not a defect on its face |
| `"Already have an account? Sign in"` | **NATIVE-ONLY placement**, compensating for the absent `MarketingHeader` |

---

## 5 · LEGAL CONSENT

| | PWA | Native |
|---|---|---|
| Control | checkbox — `type="checkbox"`, `checked={acceptLegal}`, `disabled={busy}` (`:1504-1507`) | `"Creating an account means you agree to the Terms and Privacy Policy."` — plain text |
| Documents | **three** linked: Terms of Service, Privacy Policy, Cookie Policy | **two**, unlinked |
| Submit gating | **YES** — `if (!acceptLegalRef.current) { … }` (`:696`); state at `:257`, ref at `:306`, sync at `:334` | none at this screen |
| Enforcement | pre-registration | post-auth: HTTP `428 LEGAL_REACCEPT_REQUIRED` → `/legal-acceptance` (`src/auth/legal-gate.ts`, `src/api.ts:1`) |

**Verdict: VALID PLATFORM ADAPTATION on enforcement; CONTENT MISMATCH on
presentation and coverage.** Consent *is* enforced, but:
* the **Cookie Policy is not named at all** on Native,
* none of the documents is **linked** from this screen, although `/legal/[slug]`
  exists in Native, and
* the account is **created before** consent is collected, where the PWA collects
  it first. Same enforcement, different ordering — worth a product decision.

---

## 6 · STATES

| State | PWA | Native | Verdict |
|---|---|---|---|
| Idle | full form | full form | PAIRED |
| Email checking / available / taken / check-failed | 4 distinct states | **none** | **MISSING** |
| Password strength | live meter | rules list only (`visible={password.length > 0}`) | **REDUCED** |
| Submitting | `"Creating account…"` | `loading` spinner, label unchanged | **DIFFERENT** |
| Verify-email | dedicated panel, 3 actions | dedicated panel, 2 actions | **REDUCED** |
| Error | field-level + summary | `SafeError` via `toSafeUserError` | **DIFFERENT** |

---

## 7 · EXPLICITLY UNRESOLVED

1. **Font family** — `theme.type.family.*` is `undefined` in the evaluated token
   module; resolved by `useLocale()` at runtime. Cannot be paired from source.
2. **Cascade winners** for competing web classes.
3. **Whether the Native-only `Name` field is a product requirement** — a spec
   question. `registerAccount` in `src/auth/auth-api.ts` accepts it; whether the
   PWA collects it later was not traced.
4. **Nothing rendered.**

---

## 8 · ROOT CAUSES

| ID | Class | Statement |
|---|---|---|
| **RG-1** | **MISSING CONTROL — HIGH** | Google and Apple sign-up are absent from Native registration; `useOAuth` exists and is used on `auth.tsx` but not imported here |
| **RG-2** | **MISSING ASSET** | Shared with `LG-1`/`SB-1` — the hero background is not in the native bundle |
| **RG-3** | **MISSING STRUCTURAL COMPONENT** | No left column, no card eyebrow/subtitle, no "Security and privacy commitments" section |
| **RG-4** | **MISSING CONTROL** | Confirm-password, password-strength meter, email-availability check (4 states), "Change email" |
| **RG-5** | **CONTENT MISMATCH** | 25 PWA strings absent; Cookie Policy unnamed; legal documents unlinked |
| **RG-6** | **DIFFERENT THEME VALUE** | Shared with `LG-3` — card opacity, radius, shadow, button gradient |
| **RG-7** | **PLATFORM LIMITATION (declared)** | Caps Lock detection and `backdrop-filter` have no RN equivalent |
