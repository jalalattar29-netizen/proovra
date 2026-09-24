# /reset-password

**PWA entry:** `apps/web/app/reset-password/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/reset-password.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 4 | 4 |
| Elements | 152 | 62 |
| Interactive elements | 27 | 10 |
| Conditionally-rendered elements | 83 | 25 |
| Style rules resolved | 11 (50 props) | 72 (81 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/reset-password/page.tsx` | 97 | `(entry)` |
| 1 | `apps/web/components/marketing/MarketingHeader.tsx` | 47 | `MarketingHeader` |
| 2 | `apps/web/components/analytics/PublicPageView.tsx` | 0 | `PublicPageView` |
| 2 | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx` | 8 | `MarketingLanguageSwitcher` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/reset-password.tsx` | 11 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraSection,ProovraCard,ProovraText,ProovraButton,ProovraFormField,ProovraInput` |
| 1 | `apps/mobile/src/ui/brand.tsx` | 4 | `AuthBrandHeader` |
| 1 | `apps/mobile/src/ui/password-rules.tsx` | 5 | `ProovraPasswordRules` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BUTTON | 9 | 6 | -3 |
| CARD | 2 | 1 | -1 |
| CONTAINER | 45 | 26 | -19 |
| FORM | 1 | 0 | -1 |
| HEADING | 3 | 0 | -3 |
| ICON | 34 | 0 | -34 |
| IMAGE | 3 | 1 | -2 |
| INPUT | 2 | 3 | 1 |
| LINK | 13 | 0 | -13 |
| LIST | 2 | 1 | -1 |
| OTHER | 16 | 4 | -12 |
| STATE_LOADING | 0 | 2 | 2 |
| TEXT | 22 | 18 | -4 |

### C.1 Paired (2)

| Role | Label | PWA | Native |
|---|---|---|---|
| INPUT | New password | `apps/web/app/reset-password/page.tsx:323` | `apps/mobile/app/(stack)/reset-password.tsx:58` |
| BUTTON | Back to sign in | `apps/web/app/reset-password/page.tsx:663` | `apps/mobile/app/(stack)/reset-password.tsx:53` |


### C.2 MISSING in Native (13)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Create a new password | `apps/web/app/reset-password/page.tsx:298` |
| INPUT | Confirm new password | `apps/web/app/reset-password/page.tsx:510` |
| LINK | Back to sign in | `apps/web/app/reset-password/page.tsx:602` |
| HEADING | Password updated | `apps/web/app/reset-password/page.tsx:656` |
| HEADING | Reset link expired | `apps/web/app/reset-password/page.tsx:700` |
| LINK | Request new link | `apps/web/app/reset-password/page.tsx:708` |
| LINK | Back to sign in | `apps/web/app/reset-password/page.tsx:724` |
| LINK | MARKETING_COPY.brandName | `apps/web/components/marketing/MarketingHeader.tsx:249` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:367` |
| BUTTON | Open menu | `apps/web/components/marketing/MarketingHeader.tsx:376` |
| BUTTON | Close menu | `apps/web/components/marketing/MarketingHeader.tsx:401` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:466` |
| BUTTON | Language | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx:81` |

### C.3 EXTRA in Native (6)

| Role | Label | Native source |
|---|---|---|
| INPUT | At least 12 characters | `apps/mobile/app/(stack)/reset-password.tsx:59` |
| BUTTON | Update password | `apps/mobile/app/(stack)/reset-password.tsx:62` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (10)

| Role | PWA source | Why unpairable |
|---|---|---|
| BUTTON | `apps/web/app/reset-password/page.tsx:352` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/reset-password/page.tsx:535` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/reset-password/page.tsx:572` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/marketing/MarketingHeader.tsx:275` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:309` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:344` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:359` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:419` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:436` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:459` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (11 rules, 50 properties)

**`.page`** — `apps/web/app/globals.css` · `.page`

- `min-height`: **100vh**
- `display`: **flex**
- `flex-direction`: **column**

**`.app-visually-hidden`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-visually-hidden`

- `position`: **absolute**
- `inline-size`: **1px**
- `block-size`: **1px**
- `margin`: **-1px**
- `padding`: **0**
- `overflow`: **hidden**
- `clip-path`: **inset(50%)**
- `white-space`: **nowrap**
- `border`: **0**

**`.auth-input-wrap`** — `apps/web/app/globals.css` · `.auth-input-wrap`

- `position`: **relative**
- `display`: **flex**
- `align-items`: **center**

**`.auth-input-icon`** — `apps/web/app/globals.css` · `.auth-input-icon`

- `position`: **absolute**
- `left`: **14px**
- `top`: **50%**
- `transform`: **translateY(-50%)**
- `z-index`: **2**
- `display`: **inline-flex**
- `align-items`: **center**
- `justify-content`: **center**
- `pointer-events`: **none**
- `color`: **#446166**

**`.auth-input-icon`** — `apps/web/app/globals.css` · `.auth-premium .auth-input-icon`

- `color`: **#446166**

**`.auth-input`** — `apps/web/app/globals.css` · `.auth-input`

- `width`: **100% !important**
- `min-height`: **52px**
- `padding`: **0 16px 0 46px !important**
- `border-radius`: **16px !important**
- `font-size`: **15px !important**
- `line-height`: **1.2 !important**
- `background`: **rgba(255, 255, 255, 0.92) !important**
- `border`: **1px solid rgba(79, 112, 107, 0.16) !important**
- `box-shadow`: **0 12px 28px rgba(6, 16, 22, 0.08) !important**
- `color`: **#102126 !important**
- `outline`: **none**
- `appearance`: **none**
- `-webkit-appearance`: **none**

**`.auth-input`** — `apps/web/app/globals.css` · `.auth-input::placeholder`

- `color`: **#8b989c !important**

**`.auth-input`** — `apps/web/app/globals.css` · `.auth-input:focus`

- `border-color`: **rgba(79, 112, 107, 0.34) !important**
- `box-shadow`: **0 0 0 3px rgba(79, 112, 107, 0.10) !important**

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


**Stock Tailwind utilities used (50).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

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
- `.mt-2` → {"kind":"margin","side":"t","value":"8px"}
- `.gap-2` → {"kind":"gap","value":"8px"}
- `.flex-wrap` → {"kind":"layout","value":"flex-wrap"}


### D.2 PWA SOURCE-UNRESOLVED (92)

- `landing-page` at `apps/web/app/reset-password/page.tsx:241` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `min-h-screen` at `apps/web/app/reset-password/page.tsx:249` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `inset-0` at `apps/web/app/reset-password/page.tsx:250` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-cover` at `apps/web/app/reset-password/page.tsx:251` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-center` at `apps/web/app/reset-password/page.tsx:251` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[linear-gradient(90deg,rgba(255,229,207,0.10)_0%,rgba(255,255,255,0.02)_45%,rgba(33,22,45,0.10)_100%)]` at `apps/web/app/reset-password/page.tsx:257` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-10` at `apps/web/app/reset-password/page.tsx:259` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `pb-14` at `apps/web/app/reset-password/page.tsx:262` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:px-8` at `apps/web/app/reset-password/page.tsx:262` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:pb-20` at `apps/web/app/reset-password/page.tsx:262` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:pt-28` at `apps/web/app/reset-password/page.tsx:262` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `mx-auto` at `apps/web/app/reset-password/page.tsx:263` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[520px]` at `apps/web/app/reset-password/page.tsx:263` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `pointer-events-none` at `apps/web/app/reset-password/page.tsx:274` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[radial-gradient(circle_at_85%_15%,rgba(255,179,107,0.16),transparent_40%)]` at `apps/web/app/reset-password/page.tsx:274` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[radial-gradient(circle_at_12%_8%,rgba(255,255,255,0.55),transparent_30%)]` at `apps/web/app/reset-password/page.tsx:275` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:p-9` at `apps/web/app/reset-password/page.tsx:277` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[0.74rem]` at `apps/web/app/reset-password/page.tsx:284` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `uppercase` at `apps/web/app/reset-password/page.tsx:284` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[0.18em]` at `apps/web/app/reset-password/page.tsx:284` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[1.9rem]` at `apps/web/app/reset-password/page.tsx:298` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[-0.04em]` at `apps/web/app/reset-password/page.tsx:298` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#1B1230]` at `apps/web/app/reset-password/page.tsx:298` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:text-[2.15rem]` at `apps/web/app/reset-password/page.tsx:298` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[0.96rem]` at `apps/web/app/reset-password/page.tsx:301` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `leading-[1.78]` at `apps/web/app/reset-password/page.tsx:301` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#4B3B4F]` at `apps/web/app/reset-password/page.tsx:301` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[12.5px]` at `apps/web/app/reset-password/page.tsx:377` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[13.5px]` at `apps/web/app/reset-password/page.tsx:612` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `top-0` at `apps/web/components/marketing/MarketingHeader.tsx:242` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (72 rules, 81 properties)

**`actions`** — `apps/mobile/app/(stack)/reset-password.tsx`

- `marginTop`: **12**  _(theme.space.s3)_

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

**`wrap`** — `apps/mobile/src/ui/brand.tsx`

- `alignItems`: **center**
- `marginTop`: **32**  _(theme.space.s8)_
- `marginBottom`: **24**  _(theme.space.s6)_

**`mark`** — `apps/mobile/src/ui/brand.tsx`

- `width`: **72**
- `height`: **81**
- `marginBottom`: **12**  _(theme.space.s3)_

**`word`** — `apps/mobile/src/ui/brand.tsx`

- `letterSpacing`: **2**

**`tag`** — `apps/mobile/src/ui/brand.tsx`

- `marginTop`: **8**  _(theme.space.s2)_

## K. Coverage counts for this route

| Measure | Count |
|---|---:|
| PWA files inspected (rendered tree) | 4 |
| Native files inspected (rendered tree) | 4 |
| PWA elements identified | 152 |
| Native elements identified | 62 |
| Pairable PWA elements | 32 |
| Paired | 1 |
| Missing in Native | 13 |
| Extra in Native | 6 |
| Unlabelled (not pairable by label) | 7 |
| SOURCE-UNRESOLVED labels | 10 |
| PWA style properties resolved | 50 |
| PWA style items SOURCE-UNRESOLVED | 92 |
| Native style properties resolved | 81 |
| PWA interactive elements | 27 |
| Native interactive elements | 10 |
| PWA conditional branches | 83 |
| Native conditional branches | 25 |
