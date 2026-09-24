# /verify

**PWA entry:** `apps/web/app/verify/page.tsx`
**Native entry:** `apps/mobile/app/verify.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 13 | 3 |
| Elements | 216 | 80 |
| Interactive elements | 29 | 11 |
| Conditionally-rendered elements | 69 | 30 |
| Style rules resolved | 1 (5 props) | 78 (87 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/verify/page.tsx` | 13 | `(entry)` |
| 1 | `apps/web/app/verify/_components/VerifyHero.tsx` | 43 | `VerifyHero` |
| 2 | `apps/web/components/marketing/MarketingHeader.tsx` | 47 | `MarketingHeader` |
| 3 | `apps/web/components/analytics/PublicPageView.tsx` | 0 | `PublicPageView` |
| 3 | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx` | 8 | `MarketingLanguageSwitcher` |
| 1 | `apps/web/components/motion/index.tsx` | 15 | `RevealSection` |
| 1 | `apps/web/app/verify/_components/VerifyMaterialsSection.tsx` | 10 | `VerifyMaterialsSection` |
| 1 | `apps/web/app/verify/_components/VerifyOpensSection.tsx` | 12 | `VerifyOpensSection` |
| 2 | `apps/web/app/verify/_components/shared.tsx` | 2 | `SectionEyebrow` |
| 1 | `apps/web/app/verify/_components/VerifyBoundariesSection.tsx` | 18 | `VerifyBoundariesSection` |
| 1 | `apps/web/app/verify/_components/VerifyUseCasesSection.tsx` | 11 | `VerifyUseCasesSection` |
| 1 | `apps/web/app/verify/_components/VerifyFinalCta.tsx` | 11 | `VerifyFinalCta` |
| 1 | `apps/web/components/marketing/EnterpriseFooter.tsx` | 26 | `EnterpriseFooter` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/verify.tsx` | 34 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraLoadingState,ProovraCard,ProovraFormField,ProovraInput,ProovraButton,ProovraErrorState,ProovraSection,ProovraBadge,ProovraText,ProovraListRow` |
| 1 | `apps/mobile/src/ui/brand.tsx` | 4 | `AuthBrandHeader` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 2 | 2 |
| BUTTON | 6 | 6 | 0 |
| CARD | 1 | 6 | 5 |
| CONTAINER | 77 | 24 | -53 |
| FORM | 1 | 0 | -1 |
| HEADING | 9 | 0 | -9 |
| ICON | 5 | 0 | -5 |
| IMAGE | 3 | 1 | -2 |
| INPUT | 1 | 3 | 2 |
| LINK | 20 | 0 | -20 |
| LIST | 8 | 2 | -6 |
| OTHER | 44 | 6 | -38 |
| STATE_ERROR | 0 | 1 | 1 |
| STATE_LOADING | 0 | 3 | 3 |
| TEXT | 41 | 26 | -15 |

### C.1 Paired (2)

| Role | Label | PWA | Native |
|---|---|---|---|
| LINK → BUTTON ⚠ | label | `apps/web/components/marketing/EnterpriseFooter.tsx:140` | `apps/mobile/src/ui/index.tsx:259` |
| BUTTON | Open verification | `apps/web/app/verify/_components/VerifyHero.tsx:251` | `apps/mobile/app/verify.tsx:181` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (19)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Review digital evidence through a verification-first record. | `apps/web/app/verify/_components/VerifyHero.tsx:58` |
| LINK | Open verification | `apps/web/app/verify/_components/VerifyHero.tsx:78` |
| HEADING | Enter verification token | `apps/web/app/verify/_components/VerifyHero.tsx:187` |
| LINK | MARKETING_COPY.brandName | `apps/web/components/marketing/MarketingHeader.tsx:249` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:367` |
| BUTTON | Open menu | `apps/web/components/marketing/MarketingHeader.tsx:376` |
| BUTTON | Close menu | `apps/web/components/marketing/MarketingHeader.tsx:401` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:466` |
| BUTTON | Language | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx:81` |
| HEADING | What Public Verify opens. | `apps/web/app/verify/_components/VerifyOpensSection.tsx:58` |
| HEADING | Public verification exposes context. It does not decide outcomes. | `apps/web/app/verify/_components/VerifyBoundariesSection.tsx:43` |
| HEADING | Built for review across functions. | `apps/web/app/verify/_components/VerifyUseCasesSection.tsx:58` |
| HEADING | Start reviewing a verification record. | `apps/web/app/verify/_components/VerifyFinalCta.tsx:39` |
| LINK | Open Verification | `apps/web/app/verify/_components/VerifyFinalCta.tsx:48` |
| LINK | MARKETING_COPY.brandName | `apps/web/components/marketing/EnterpriseFooter.tsx:111` |
| LINK | Privacy Policy | `apps/web/components/marketing/EnterpriseFooter.tsx:180` |
| LINK | Terms of Service | `apps/web/components/marketing/EnterpriseFooter.tsx:183` |
| LINK | Security | `apps/web/components/marketing/EnterpriseFooter.tsx:186` |
| LINK | Trust Center | `apps/web/components/marketing/EnterpriseFooter.tsx:189` |

### C.3 EXTRA in Native (7)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Verifying | `apps/mobile/app/verify.tsx:81` |
| INPUT | Verification link or id | `apps/mobile/app/verify.tsx:88` |
| INPUT | https://proovra.com/verify/… | `apps/mobile/app/verify.tsx:89` |
| BUTTON | Verify | `apps/mobile/app/verify.tsx:91` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (13)

| Role | PWA source | Why unpairable |
|---|---|---|
| INPUT | `apps/web/app/verify/_components/VerifyHero.tsx:208` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/marketing/MarketingHeader.tsx:275` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:309` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:344` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:359` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:419` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:436` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:459` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/verify/_components/VerifyOpensSection.tsx:89` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/verify/_components/VerifyUseCasesSection.tsx:82` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/EnterpriseFooter.tsx:128` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/marketing/EnterpriseFooter.tsx:157` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/EnterpriseFooter.tsx:163` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (1 rules, 5 properties)

**`.rounded-2xl`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-right-panel > .card .rounded-2xl`

- `background`: **var(--capture-glass-card) !important**  ⚠ undeclared --capture-glass-card
- `border`: **1px solid var(--capture-glass-border) !important**  ⚠ undeclared --capture-glass-border
- `box-shadow`: **0 8px 24px rgba(15, 23, 42, 0.035),     inset 0 1px 0 rgba(255, 255, 255, 0.28) !important**
- `backdrop-filter`: **blur(10px) !important**
- `-webkit-backdrop-filter`: **blur(10px) !important**


**Stock Tailwind utilities used (77).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.relative` → {"kind":"layout","value":"relative"}
- `.overflow-hidden` → {"kind":"layout","value":"overflow-hidden"}
- `.absolute` → {"kind":"layout","value":"absolute"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.pb-12` → {"kind":"padding","side":"b","value":"48px"}
- `.pt-16` → {"kind":"padding","side":"t","value":"64px"}
- `.grid` → {"kind":"layout","value":"grid"}
- `.gap-10` → {"kind":"gap","value":"40px"}
- `.inline-flex` → {"kind":"layout","value":"inline-flex"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.gap-2` → {"kind":"gap","value":"8px"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.px-3` → {"kind":"padding","side":"x","value":"12px"}
- `.py-1` → {"kind":"padding","side":"y","value":"4px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.mt-5` → {"kind":"margin","side":"t","value":"20px"}
- `.mt-6` → {"kind":"margin","side":"t","value":"24px"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.flex-wrap` → {"kind":"layout","value":"flex-wrap"}
- `.gap-3` → {"kind":"gap","value":"12px"}
- `.justify-center` → {"kind":"layout","value":"justify-center"}
- `.px-5` → {"kind":"padding","side":"x","value":"20px"}
- `.py-2.5` → {"kind":"padding","side":"y","value":"10px"}
- `.py-1.5` → {"kind":"padding","side":"y","value":"6px"}
- `.font-medium` → {"kind":"font-weight","value":500}


### D.2 PWA SOURCE-UNRESOLVED (206)

- `bg-white` at `apps/web/app/verify/page.tsx:31` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `pointer-events-none` at `apps/web/app/verify/_components/VerifyHero.tsx:36` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `inset-0` at `apps/web/app/verify/_components/VerifyHero.tsx:36` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-0` at `apps/web/app/verify/_components/VerifyHero.tsx:36` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[url('/assets/hero/verify-hero.png')]` at `apps/web/app/verify/_components/VerifyHero.tsx:36` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-cover` at `apps/web/app/verify/_components/VerifyHero.tsx:36` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-center` at `apps/web/app/verify/_components/VerifyHero.tsx:36` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-no-repeat` at `apps/web/app/verify/_components/VerifyHero.tsx:36` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-white/20` at `apps/web/app/verify/_components/VerifyHero.tsx:40` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-10` at `apps/web/app/verify/_components/VerifyHero.tsx:45` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `mx-auto` at `apps/web/app/verify/_components/VerifyHero.tsx:48` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[1320px]` at `apps/web/app/verify/_components/VerifyHero.tsx:48` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:px-8` at `apps/web/app/verify/_components/VerifyHero.tsx:48` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:pb-16` at `apps/web/app/verify/_components/VerifyHero.tsx:48` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:pt-20` at `apps/web/app/verify/_components/VerifyHero.tsx:48` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:pb-20` at `apps/web/app/verify/_components/VerifyHero.tsx:48` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:pt-24` at `apps/web/app/verify/_components/VerifyHero.tsx:48` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:grid-cols-[minmax(0,580px)_1fr]` at `apps/web/app/verify/_components/VerifyHero.tsx:52` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:items-start` at `apps/web/app/verify/_components/VerifyHero.tsx:52` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:gap-12` at `apps/web/app/verify/_components/VerifyHero.tsx:52` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border` at `apps/web/app/verify/_components/VerifyHero.tsx:54` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[#DDE7F3]` at `apps/web/app/verify/_components/VerifyHero.tsx:54` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[11px]` at `apps/web/app/verify/_components/VerifyHero.tsx:54` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `uppercase` at `apps/web/app/verify/_components/VerifyHero.tsx:54` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[0.22em]` at `apps/web/app/verify/_components/VerifyHero.tsx:54` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#2563EB]` at `apps/web/app/verify/_components/VerifyHero.tsx:54` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `shadow-[0_2px_8px_rgba(37,99,235,0.06)]` at `apps/web/app/verify/_components/VerifyHero.tsx:54` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `h-1.5` at `apps/web/app/verify/_components/VerifyHero.tsx:55` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `w-1.5` at `apps/web/app/verify/_components/VerifyHero.tsx:55` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[#2563EB]` at `apps/web/app/verify/_components/VerifyHero.tsx:55` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (78 rules, 87 properties)

**`card`** — `apps/mobile/app/verify.tsx`

- `marginBottom`: **16**  _(theme.space.s4)_
- `gap`: **8**  _(theme.space.s2)_

**`gap`** — `apps/mobile/app/verify.tsx`

- `marginTop`: **8**  _(theme.space.s2)_

**`hashRow`** — `apps/mobile/app/verify.tsx`

- `paddingVertical`: **8**  _(theme.space.s2)_
- `borderTopWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderTopColor`: **rgba(15, 23, 42, 0.06)**  _(theme.color.border.subtle)_
- `gap`: **2**

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
| PWA files inspected (rendered tree) | 13 |
| Native files inspected (rendered tree) | 3 |
| PWA elements identified | 216 |
| Native elements identified | 80 |
| Pairable PWA elements | 40 |
| Paired | 0 |
| Missing in Native | 19 |
| Extra in Native | 7 |
| Unlabelled (not pairable by label) | 6 |
| SOURCE-UNRESOLVED labels | 13 |
| PWA style properties resolved | 5 |
| PWA style items SOURCE-UNRESOLVED | 206 |
| Native style properties resolved | 87 |
| PWA interactive elements | 29 |
| Native interactive elements | 11 |
| PWA conditional branches | 69 |
| Native conditional branches | 30 |
