# /auth/verify-email

**PWA entry:** `apps/web/app/auth/verify-email/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/verify-email.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 4 | 2 |
| Elements | 119 | 50 |
| Interactive elements | 26 | 7 |
| Conditionally-rendered elements | 44 | 18 |
| Style rules resolved | 7 (30 props) | 63 (74 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/auth/verify-email/page.tsx` | 64 | `(entry)` |
| 1 | `apps/web/components/marketing/MarketingHeader.tsx` | 47 | `MarketingHeader` |
| 2 | `apps/web/components/analytics/PublicPageView.tsx` | 0 | `PublicPageView` |
| 2 | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx` | 8 | `MarketingLanguageSwitcher` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/verify-email.tsx` | 8 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraSection,ProovraCard,ProovraLoadingState,ProovraErrorState,ProovraButton,ProovraText` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BUTTON | 8 | 5 | -3 |
| CARD | 6 | 1 | -5 |
| CONTAINER | 40 | 22 | -18 |
| HEADING | 1 | 0 | -1 |
| ICON | 1 | 0 | -1 |
| IMAGE | 3 | 0 | -3 |
| INPUT | 1 | 1 | 0 |
| LINK | 11 | 0 | -11 |
| LIST | 0 | 1 | 1 |
| OTHER | 32 | 2 | -30 |
| STATE_ERROR | 0 | 1 | 1 |
| STATE_LOADING | 0 | 3 | 3 |
| TEXT | 16 | 14 | -2 |

### C.1 Paired (1)

| Role | Label | PWA | Native |
|---|---|---|---|
| LINK → BUTTON ⚠ | Back to sign in | `apps/web/app/auth/verify-email/page.tsx:295` | `apps/mobile/app/(stack)/verify-email.tsx:46` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (8)

| Role | Label | PWA source |
|---|---|---|
| BUTTON | Continue to PROOVRA | `apps/web/app/auth/verify-email/page.tsx:324` |
| INPUT | you@example.com | `apps/web/app/auth/verify-email/page.tsx:366` |
| LINK | MARKETING_COPY.brandName | `apps/web/components/marketing/MarketingHeader.tsx:249` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:367` |
| BUTTON | Open menu | `apps/web/components/marketing/MarketingHeader.tsx:376` |
| BUTTON | Close menu | `apps/web/components/marketing/MarketingHeader.tsx:401` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:466` |
| BUTTON | Language | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx:81` |

### C.3 EXTRA in Native (5)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Confirming your account | `apps/mobile/app/(stack)/verify-email.tsx:41` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (10)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/app/auth/verify-email/page.tsx:256` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/auth/verify-email/page.tsx:274` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/auth/verify-email/page.tsx:383` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/marketing/MarketingHeader.tsx:275` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:309` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:344` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:359` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:419` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:436` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:459` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (7 rules, 30 properties)

**`.page`** — `apps/web/app/globals.css` · `.page`

- `min-height`: **100vh**
- `display`: **flex**
- `flex-direction`: **column**

**`.auth-social-btn`** — `apps/web/app/globals.css` · `.auth-social-btn`

- `width`: **100%**
- `min-height`: **52px**
- `border-radius`: **16px**
- `padding`: **0 18px**
- `display`: **inline-flex**
- `align-items`: **center**
- `justify-content`: **center**
- `gap`: **10px**
- `font-size`: **0.96rem**
- `font-weight`: **600**
- `cursor`: **pointer**
- `appearance`: **none**
- `-webkit-appearance`: **none**

**`.auth-social-btn`** — `apps/web/app/globals.css` · `.auth-social-btn:disabled`

- `opacity`: **0.7**
- `cursor`: **not-allowed**

**`.auth-social-btn`** — `apps/web/app/globals.css` · `.auth-premium .auth-social-btn:not([type="submit"])`

- `background`: **linear-gradient(     180deg,     rgba(62, 96, 99, 0.96) 0%,     rgba(24, 43, 48, 0.98) 100%   )**
- `color`: **#eef3f1**
- `border`: **1px solid rgba(79, 112, 107, 0.28)**
- `box-shadow`: **0 14px 28px rgba(20, 48, 52, 0.16)**

**`.auth-link`** — `apps/web/app/globals.css` · `.auth-premium .auth-link`

- `color`: **#45656a**
- `transition`: **color 0.2s ease**

**`.auth-link`** — `apps/web/app/globals.css` · `.auth-premium .auth-link:hover`

- `color`: **#2e4c50**

**`.rounded-2xl`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-right-panel > .card .rounded-2xl`

- `background`: **var(--capture-glass-card) !important**  ⚠ undeclared --capture-glass-card
- `border`: **1px solid var(--capture-glass-border) !important**  ⚠ undeclared --capture-glass-border
- `box-shadow`: **0 8px 24px rgba(15, 23, 42, 0.035),     inset 0 1px 0 rgba(255, 255, 255, 0.28) !important**
- `backdrop-filter`: **blur(10px) !important**
- `-webkit-backdrop-filter`: **blur(10px) !important**


**Stock Tailwind utilities used (51).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.relative` → {"kind":"layout","value":"relative"}
- `.overflow-hidden` → {"kind":"layout","value":"overflow-hidden"}
- `.absolute` → {"kind":"layout","value":"absolute"}
- `.h-full` → {"kind":"layout","value":"h-full"}
- `.w-full` → {"kind":"layout","value":"w-full"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.flex-col` → {"kind":"layout","value":"flex-col"}
- `.flex-1` → {"kind":"layout","value":"flex-1"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.pt-24` → {"kind":"padding","side":"t","value":"96px"}
- `.rounded-[28px]` → {"kind":"border-radius"}
- `.p-8` → {"kind":"padding","side":"all","value":"32px"}
- `.inline-flex` → {"kind":"layout","value":"inline-flex"}
- `.gap-2.5` → {"kind":"gap","value":"10px"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.px-4` → {"kind":"padding","side":"x","value":"16px"}
- `.py-2.5` → {"kind":"padding","side":"y","value":"10px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.mt-4` → {"kind":"margin","side":"t","value":"16px"}
- `.mt-3` → {"kind":"margin","side":"t","value":"12px"}
- `.mt-6` → {"kind":"margin","side":"t","value":"24px"}
- `.flex-wrap` → {"kind":"layout","value":"flex-wrap"}
- `.gap-3` → {"kind":"gap","value":"12px"}
- `.block` → {"kind":"layout","value":"block"}


### D.2 PWA SOURCE-UNRESOLVED (92)

- `landing-page` at `apps/web/app/auth/verify-email/page.tsx:177` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `min-h-screen` at `apps/web/app/auth/verify-email/page.tsx:178` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `inset-0` at `apps/web/app/auth/verify-email/page.tsx:179` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-cover` at `apps/web/app/auth/verify-email/page.tsx:180` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-center` at `apps/web/app/auth/verify-email/page.tsx:180` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[linear-gradient(90deg,rgba(255,229,207,0.10)_0%,rgba(255,255,255,0.02)_45%,rgba(33,22,45,0.10)_100%)]` at `apps/web/app/auth/verify-email/page.tsx:186` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-10` at `apps/web/app/auth/verify-email/page.tsx:188` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `pb-14` at `apps/web/app/auth/verify-email/page.tsx:191` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:px-8` at `apps/web/app/auth/verify-email/page.tsx:191` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:pb-20` at `apps/web/app/auth/verify-email/page.tsx:191` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:pt-28` at `apps/web/app/auth/verify-email/page.tsx:191` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `mx-auto` at `apps/web/app/auth/verify-email/page.tsx:192` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[520px]` at `apps/web/app/auth/verify-email/page.tsx:192` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `pointer-events-none` at `apps/web/app/auth/verify-email/page.tsx:203` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[radial-gradient(circle_at_85%_15%,rgba(255,179,107,0.16),transparent_40%)]` at `apps/web/app/auth/verify-email/page.tsx:203` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[radial-gradient(circle_at_12%_8%,rgba(255,255,255,0.55),transparent_30%)]` at `apps/web/app/auth/verify-email/page.tsx:204` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:p-9` at `apps/web/app/auth/verify-email/page.tsx:206` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[0.74rem]` at `apps/web/app/auth/verify-email/page.tsx:243` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `uppercase` at `apps/web/app/auth/verify-email/page.tsx:243` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[0.18em]` at `apps/web/app/auth/verify-email/page.tsx:243` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[1.9rem]` at `apps/web/app/auth/verify-email/page.tsx:256` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[-0.04em]` at `apps/web/app/auth/verify-email/page.tsx:256` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#1B1230]` at `apps/web/app/auth/verify-email/page.tsx:256` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:text-[2.15rem]` at `apps/web/app/auth/verify-email/page.tsx:256` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[0.96rem]` at `apps/web/app/auth/verify-email/page.tsx:262` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `leading-[1.78]` at `apps/web/app/auth/verify-email/page.tsx:262` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#4B3B4F]` at `apps/web/app/auth/verify-email/page.tsx:262` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[12px]` at `apps/web/app/auth/verify-email/page.tsx:359` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[15px]` at `apps/web/app/auth/verify-email/page.tsx:366` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `top-0` at `apps/web/components/marketing/MarketingHeader.tsx:242` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (63 rules, 74 properties)

**`actions`** — `apps/mobile/app/(stack)/verify-email.tsx`

- `marginTop`: **12**  _(theme.space.s3)_

**`hint`** — `apps/mobile/app/(stack)/verify-email.tsx`

- `marginTop`: **16**  _(theme.space.s4)_

**`flex`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**

**`screen`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `backgroundColor`: **#F7F8FC**  _(theme.color.surface.app)_

**`screenBody`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**

**`centerColumn`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `width`: **100%**
- `alignItems`: **center**

**`screenPadded`** — `apps/mobile/src/ui/index.tsx`

- `paddingHorizontal`: **16**  _(theme.space.s4)_

**`scrollContent`** — `apps/mobile/src/ui/index.tsx`

- `paddingBottom`: **40**  _(theme.space.s10)_
- `flexGrow`: **1**

**`footer`** — `apps/mobile/src/ui/index.tsx`

- `paddingHorizontal`: **16**  _(theme.space.s4)_
- `paddingVertical`: **12**  _(theme.space.s3)_
- `borderTopWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderTopColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_

**`card`** — `apps/mobile/src/ui/index.tsx`

- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_
- `borderRadius`: **14**  _(theme.radius.card)_
- `padding`: **20**  _(theme.space.s5)_
- `borderWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_

**`pressed`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.94**

**`section`** — `apps/mobile/src/ui/index.tsx`

- `marginBottom`: **24**  _(theme.space.s6)_

**`sectionHead`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `justifyContent`: **space-between**
- `marginBottom`: **12**  _(theme.space.s3)_

**`button`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `paddingVertical`: **12**  _(theme.space.s3)_
- `paddingHorizontal`: **20**  _(theme.space.s5)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `alignItems`: **center**
- `justifyContent`: **center**

**`buttonFull`** — `apps/mobile/src/ui/index.tsx`

- `alignSelf`: **stretch**

**`buttonDisabled`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.5**

**`buttonInner`** — `apps/mobile/src/ui/index.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **8**  _(theme.space.s2)_

**`buttonLabel`** — `apps/mobile/src/ui/index.tsx`

- `fontSize`: **theme.type.size.body**  _(theme.type.size.body)_  ⚠ token path not found in proovra.generated.ts
- `fontWeight`: **600**

**`badge`** — `apps/mobile/src/ui/index.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **8**  _(theme.space.s2)_
- `paddingVertical`: **6**
- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `alignSelf`: **flex-start**

**`badgeDot`** — `apps/mobile/src/ui/index.tsx`

- `width`: **8**
- `height`: **8**
- `borderRadius`: **4**

**`badgeText`** — `apps/mobile/src/ui/index.tsx`

- `fontSize`: **theme.type.size.label**  _(theme.type.size.label)_  ⚠ token path not found in proovra.generated.ts

**`row`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `paddingVertical`: **12**  _(theme.space.s3)_

**`rowInner`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `gap`: **12**  _(theme.space.s3)_

**`rowText`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `gap`: **2**

**`stateCenter`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `justifyContent`: **center**
- `paddingVertical`: **40**  _(theme.space.s10)_

**`stateGap`** — `apps/mobile/src/ui/index.tsx`

- `marginTop`: **12**  _(theme.space.s3)_

**`field`** — `apps/mobile/src/ui/index.tsx`

- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **16**  _(theme.space.s4)_

**`input`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `borderWidth`: **1**
- `borderRadius`: **8**  _(theme.radius.md)_
- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `paddingVertical`: **12**  _(theme.space.s3)_
- `fontSize`: **theme.type.size.body**  _(theme.type.size.body)_  ⚠ token path not found in proovra.generated.ts
- `color`: **#0F172A**  _(theme.color.ink.primary)_
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_

**`inputDisabled`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.5**

## K. Coverage counts for this route

| Measure | Count |
|---|---:|
| PWA files inspected (rendered tree) | 4 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 119 |
| Native elements identified | 50 |
| Pairable PWA elements | 30 |
| Paired | 0 |
| Missing in Native | 8 |
| Extra in Native | 5 |
| Unlabelled (not pairable by label) | 11 |
| SOURCE-UNRESOLVED labels | 10 |
| PWA style properties resolved | 30 |
| PWA style items SOURCE-UNRESOLVED | 92 |
| Native style properties resolved | 74 |
| PWA interactive elements | 26 |
| Native interactive elements | 7 |
| PWA conditional branches | 44 |
| Native conditional branches | 18 |
