# /auth/callback/ui

**PWA entry:** `apps/web/app/auth/callback/ui/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/auth.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 1 | 3 |
| Elements | 38 | 67 |
| Interactive elements | 1 | 16 |
| Conditionally-rendered elements | 0 | 17 |
| Style rules resolved | 13 (34 props) | 78 (92 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/auth/callback/ui/page.tsx` | 38 | `(entry)` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/auth.tsx` | 21 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraCard,ProovraFormField,ProovraInput,ProovraButton,ProovraText` |
| 1 | `apps/mobile/src/ui/brand.tsx` | 4 | `AuthBrandHeader` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BUTTON | 0 | 10 | 10 |
| CARD | 0 | 1 | 1 |
| CONTAINER | 29 | 28 | -1 |
| HEADING | 2 | 0 | -2 |
| IMAGE | 4 | 1 | -3 |
| INPUT | 0 | 5 | 5 |
| LINK | 1 | 0 | -1 |
| LIST | 0 | 1 | 1 |
| OTHER | 0 | 2 | 2 |
| STATE_LOADING | 0 | 2 | 2 |
| TEXT | 2 | 17 | 15 |

### C.1 Paired (0)

_none_


### C.2 MISSING in Native (3)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Sign-in failed | `apps/web/app/auth/callback/ui/page.tsx:341` |
| LINK | Back to sign in | `apps/web/app/auth/callback/ui/page.tsx:349` |
| HEADING | Signing you in… | `apps/web/app/auth/callback/ui/page.tsx:397` |

### C.3 EXTRA in Native (12)

| Role | Label | Native source |
|---|---|---|
| INPUT | Email | `apps/mobile/app/(stack)/auth.tsx:72` |
| INPUT | you@example.com | `apps/mobile/app/(stack)/auth.tsx:73` |
| INPUT | Password | `apps/mobile/app/(stack)/auth.tsx:82` |
| INPUT | Your password | `apps/mobile/app/(stack)/auth.tsx:83` |
| BUTTON | Resend verification email | `apps/mobile/app/(stack)/auth.tsx:95` |
| BUTTON | Create account | `apps/mobile/app/(stack)/auth.tsx:105` |
| BUTTON | Forgot password? | `apps/mobile/app/(stack)/auth.tsx:106` |
| BUTTON | Continue with Apple | `apps/mobile/app/(stack)/auth.tsx:126` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (0)

_none_

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (13 rules, 34 properties)

**`.page`** — `apps/web/app/globals.css` · `.page`

- `min-height`: **100vh**
- `display`: **flex**
- `flex-direction`: **column**

**`.auth-card`** — `apps/web/app/globals.css` · `.auth-card`

- `width`: **100%**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium`

- `position`: **relative**
- `overflow`: **hidden**
- `border-radius`: **30px**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-input-icon`

- `color`: **#446166**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-divider`

- `color`: **#6c787c**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-social-btn:not([type="submit"])`

- `background`: **linear-gradient(     180deg,     rgba(62, 96, 99, 0.96) 0%,     rgba(24, 43, 48, 0.98) 100%   )**
- `color`: **#eef3f1**
- `border`: **1px solid rgba(79, 112, 107, 0.28)**
- `box-shadow`: **0 14px 28px rgba(20, 48, 52, 0.16)**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-link`

- `color`: **#45656a**
- `transition`: **color 0.2s ease**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-link:hover`

- `color`: **#2e4c50**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-legal a`

- `color`: **#b79d84 !important**
- `transition`: **color 0.2s ease**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-legal a:hover`

- `color`: **#d6b89d !important**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .error-text`

- `color`: **#b42318**
- `background`: **rgba(255, 255, 255, 0.52)**
- `border`: **1px solid rgba(180, 35, 24, 0.12)**
- `border-radius`: **14px**
- `padding`: **10px 12px**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-status`

- `color`: **#496268**
- `background`: **rgba(255, 255, 255, 0.42)**
- `border`: **1px solid rgba(79, 112, 107, 0.10)**
- `border-radius`: **14px**
- `padding`: **10px 12px**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-debug-panel`

- `background`: **rgba(255, 255, 255, 0.42)**
- `border`: **1px solid rgba(79, 112, 107, 0.10)**
- `border-radius`: **16px**
- `padding`: **12px**
- `color`: **#4f5f63**


**Stock Tailwind utilities used (19).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.relative` → {"kind":"layout","value":"relative"}
- `.overflow-hidden` → {"kind":"layout","value":"overflow-hidden"}
- `.absolute` → {"kind":"layout","value":"absolute"}
- `.h-full` → {"kind":"layout","value":"h-full"}
- `.w-full` → {"kind":"layout","value":"w-full"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.justify-center` → {"kind":"layout","value":"justify-center"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.py-10` → {"kind":"padding","side":"y","value":"40px"}
- `.rounded-[30px]` → {"kind":"border-radius"}
- `.p-7` → {"kind":"padding","side":"all","value":"28px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.mt-3` → {"kind":"margin","side":"t","value":"12px"}
- `.mt-6` → {"kind":"margin","side":"t","value":"24px"}
- `.inline-flex` → {"kind":"layout","value":"inline-flex"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.py-3` → {"kind":"padding","side":"y","value":"12px"}
- `.text-sm` → {"kind":"font-size/line-height","value":"14px/20px"}


### D.2 PWA SOURCE-UNRESOLVED (40)

- `landing-page` at `apps/web/app/auth/callback/ui/page.tsx:313` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `min-h-screen` at `apps/web/app/auth/callback/ui/page.tsx:314` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `inset-0` at `apps/web/app/auth/callback/ui/page.tsx:315` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-cover` at `apps/web/app/auth/callback/ui/page.tsx:316` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-center` at `apps/web/app/auth/callback/ui/page.tsx:316` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.74)_34%,rgba(8,18,22,0.68)_100%)]` at `apps/web/app/auth/callback/ui/page.tsx:323` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[radial-gradient(circle_at_16%_14%,rgba(158,216,207,0.08),transparent_24%)]` at `apps/web/app/auth/callback/ui/page.tsx:324` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[radial-gradient(circle_at_84%_22%,rgba(214,184,157,0.06),transparent_18%)]` at `apps/web/app/auth/callback/ui/page.tsx:325` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `opacity-[0.035]` at `apps/web/app/auth/callback/ui/page.tsx:326` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `[background:repeating-linear-gradient(0deg,rgba(255,255,255,0.022)_0px,rgba(255,255,255,0.022)_1px,transparent_1px,transparent_4px)]` at `apps/web/app/auth/callback/ui/page.tsx:326` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-10` at `apps/web/app/auth/callback/ui/page.tsx:328` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:px-8` at `apps/web/app/auth/callback/ui/page.tsx:328` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:py-14` at `apps/web/app/auth/callback/ui/page.tsx:328` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[560px]` at `apps/web/app/auth/callback/ui/page.tsx:329` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border` at `apps/web/app/auth/callback/ui/page.tsx:330` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[rgba(79,112,107,0.22)]` at `apps/web/app/auth/callback/ui/page.tsx:330` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `shadow-[0_30px_80px_rgba(0,0,0,0.18)]` at `apps/web/app/auth/callback/ui/page.tsx:330` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.55)_100%)]` at `apps/web/app/auth/callback/ui/page.tsx:336` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[radial-gradient(circle_at_85%_20%,rgba(214,184,157,0.18),transparent_40%)]` at `apps/web/app/auth/callback/ui/page.tsx:337` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[radial-gradient(circle_at_15%_10%,rgba(255,255,255,0.35),transparent_30%)]` at `apps/web/app/auth/callback/ui/page.tsx:338` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-center` at `apps/web/app/auth/callback/ui/page.tsx:340` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:p-8` at `apps/web/app/auth/callback/ui/page.tsx:340` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[1.8rem]` at `apps/web/app/auth/callback/ui/page.tsx:341` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[-0.04em]` at `apps/web/app/auth/callback/ui/page.tsx:341` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#16282d]` at `apps/web/app/auth/callback/ui/page.tsx:341` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:text-[2rem]` at `apps/web/app/auth/callback/ui/page.tsx:341` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[0.96rem]` at `apps/web/app/auth/callback/ui/page.tsx:345` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `leading-[1.78]` at `apps/web/app/auth/callback/ui/page.tsx:345` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#5c6a6e]` at `apps/web/app/auth/callback/ui/page.tsx:345` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[#b39b86]/42` at `apps/web/app/auth/callback/ui/page.tsx:349` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (78 rules, 92 properties)

**`linkRow`** — `apps/mobile/app/(stack)/auth.tsx`

- `flexDirection`: **row**
- `justifyContent`: **space-between**
- `marginTop`: **8**  _(theme.space.s2)_

**`divider`** — `apps/mobile/app/(stack)/auth.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **12**  _(theme.space.s3)_
- `marginVertical`: **20**  _(theme.space.s5)_

**`dividerLine`** — `apps/mobile/app/(stack)/auth.tsx`

- `flex`: **1**
- `height`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `backgroundColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_

**`oauth`** — `apps/mobile/app/(stack)/auth.tsx`

- `gap`: **12**  _(theme.space.s3)_

**`legal`** — `apps/mobile/app/(stack)/auth.tsx`

- `marginTop`: **24**  _(theme.space.s6)_

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
| PWA files inspected (rendered tree) | 1 |
| Native files inspected (rendered tree) | 3 |
| PWA elements identified | 38 |
| Native elements identified | 67 |
| Pairable PWA elements | 7 |
| Paired | 0 |
| Missing in Native | 3 |
| Extra in Native | 12 |
| Unlabelled (not pairable by label) | 4 |
| SOURCE-UNRESOLVED labels | 0 |
| PWA style properties resolved | 34 |
| PWA style items SOURCE-UNRESOLVED | 40 |
| Native style properties resolved | 92 |
| PWA interactive elements | 1 |
| Native interactive elements | 16 |
| PWA conditional branches | 0 |
| Native conditional branches | 17 |
