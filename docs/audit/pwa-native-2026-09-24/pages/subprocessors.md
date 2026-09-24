# /subprocessors

**PWA entry:** `apps/web/app/legal/[slug]/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/legal/[slug].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 6 | 3 |
| Elements | 104 | 78 |
| Interactive elements | 25 | 16 |
| Conditionally-rendered elements | 46 | 43 |
| Style rules resolved | 2 (8 props) | 70 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/legal/[slug]/page.tsx` | 10 | `(entry)` |
| 1 | `apps/web/components/analytics/PublicPageView.tsx` | 0 | `PublicPageView` |
| 1 | `apps/web/components/legal/LegalHero.tsx` | 13 | `LegalHero` |
| 2 | `apps/web/components/marketing/MarketingHeader.tsx` | 47 | `MarketingHeader` |
| 3 | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx` | 8 | `MarketingLanguageSwitcher` |
| 1 | `apps/web/components/marketing/EnterpriseFooter.tsx` | 26 | `EnterpriseFooter` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/legal/[slug].tsx` | 12 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraButton,ProovraLoadingState,ProovraErrorState,ProovraCard,ProovraText` |
| 1 | `apps/mobile/src/ui/legal-document.tsx` | 24 | `LegalDocumentBody` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BUTTON | 5 | 6 | 1 |
| CARD | 0 | 2 | 2 |
| CONTAINER | 39 | 30 | -9 |
| HEADING | 2 | 0 | -2 |
| ICON | 2 | 0 | -2 |
| IMAGE | 3 | 0 | -3 |
| INPUT | 0 | 1 | 1 |
| LINK | 19 | 0 | -19 |
| LIST | 2 | 1 | -1 |
| OTHER | 17 | 12 | -5 |
| STATE_ERROR | 0 | 1 | 1 |
| STATE_LOADING | 0 | 3 | 3 |
| TEXT | 15 | 22 | 7 |

### C.1 Paired (1)

| Role | Label | PWA | Native |
|---|---|---|---|
| LINK → BUTTON ⚠ | label | `apps/web/components/marketing/EnterpriseFooter.tsx:140` | `apps/mobile/src/ui/index.tsx:259` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (11)

| Role | Label | PWA source |
|---|---|---|
| LINK | MARKETING_COPY.brandName | `apps/web/components/marketing/MarketingHeader.tsx:249` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:367` |
| BUTTON | Open menu | `apps/web/components/marketing/MarketingHeader.tsx:376` |
| BUTTON | Close menu | `apps/web/components/marketing/MarketingHeader.tsx:401` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:466` |
| BUTTON | Language | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx:81` |
| LINK | MARKETING_COPY.brandName | `apps/web/components/marketing/EnterpriseFooter.tsx:111` |
| LINK | Privacy Policy | `apps/web/components/marketing/EnterpriseFooter.tsx:180` |
| LINK | Terms of Service | `apps/web/components/marketing/EnterpriseFooter.tsx:183` |
| LINK | Security | `apps/web/components/marketing/EnterpriseFooter.tsx:186` |
| LINK | Trust Center | `apps/web/components/marketing/EnterpriseFooter.tsx:189` |

### C.3 EXTRA in Native (6)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/legal/[slug].tsx:108` |
| STATE_LOADING | Loading document | `apps/mobile/app/(stack)/legal/[slug].tsx:117` |
| BUTTON | Browse legal documents | `apps/mobile/app/(stack)/legal/[slug].tsx:134` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (10)

| Role | PWA source | Why unpairable |
|---|---|---|
| BUTTON | `apps/web/components/marketing/MarketingHeader.tsx:275` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:309` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:344` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:359` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:419` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:436` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:459` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/EnterpriseFooter.tsx:128` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/marketing/EnterpriseFooter.tsx:157` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/EnterpriseFooter.tsx:163` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (2 rules, 8 properties)

**`.page`** — `apps/web/app/globals.css` · `.page`

- `min-height`: **100vh**
- `display`: **flex**
- `flex-direction`: **column**

**`.rounded-2xl`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-right-panel > .card .rounded-2xl`

- `background`: **var(--capture-glass-card) !important**  ⚠ undeclared --capture-glass-card
- `border`: **1px solid var(--capture-glass-border) !important**  ⚠ undeclared --capture-glass-border
- `box-shadow`: **0 8px 24px rgba(15, 23, 42, 0.035),     inset 0 1px 0 rgba(255, 255, 255, 0.28) !important**
- `backdrop-filter`: **blur(10px) !important**
- `-webkit-backdrop-filter`: **blur(10px) !important**


**Stock Tailwind utilities used (60).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.py-12` → {"kind":"padding","side":"y","value":"48px"}
- `.mt-8` → {"kind":"margin","side":"t","value":"32px"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.justify-center` → {"kind":"layout","value":"justify-center"}
- `.relative` → {"kind":"layout","value":"relative"}
- `.overflow-hidden` → {"kind":"layout","value":"overflow-hidden"}
- `.absolute` → {"kind":"layout","value":"absolute"}
- `.pb-24` → {"kind":"padding","side":"b","value":"96px"}
- `.pt-20` → {"kind":"padding","side":"t","value":"80px"}
- `.mt-4` → {"kind":"margin","side":"t","value":"16px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.mt-5` → {"kind":"margin","side":"t","value":"20px"}
- `.font-medium` → {"kind":"font-weight","value":500}
- `.mt-6` → {"kind":"margin","side":"t","value":"24px"}
- `.w-full` → {"kind":"layout","value":"w-full"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.justify-between` → {"kind":"layout","value":"justify-between"}
- `.gap-4` → {"kind":"gap","value":"16px"}
- `.px-5` → {"kind":"padding","side":"x","value":"20px"}
- `.py-1.5` → {"kind":"padding","side":"y","value":"6px"}
- `.hidden` → {"kind":"layout","value":"hidden"}
- `.gap-0.5` → {"kind":"gap","value":"2px"}
- `.pt-3` → {"kind":"padding","side":"t","value":"12px"}
- `.items-start` → {"kind":"layout","value":"items-start"}


### D.2 PWA SOURCE-UNRESOLVED (120)

- `legal-center-page` at `apps/web/app/legal/[slug]/page.tsx:46` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `mx-auto` at `apps/web/app/legal/[slug]/page.tsx:65` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-5xl` at `apps/web/app/legal/[slug]/page.tsx:65` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:px-8` at `apps/web/app/legal/[slug]/page.tsx:65` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:py-16` at `apps/web/app/legal/[slug]/page.tsx:65` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `LEGAL_ARTICLE_CLASSES` at `apps/web/app/legal/[slug]/page.tsx:66` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `MARKETING_BTN.heroSecondary` at `apps/web/app/legal/[slug]/page.tsx:72` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-clip-text` at `apps/web/components/legal/LegalHero.tsx:53` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-transparent` at `apps/web/components/legal/LegalHero.tsx:53` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `min-h-[720px]` at `apps/web/components/legal/LegalHero.tsx:93` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-white` at `apps/web/components/legal/LegalHero.tsx:93` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `inset-0` at `apps/web/components/legal/LegalHero.tsx:94` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-10` at `apps/web/components/legal/LegalHero.tsx:104` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[1320px]` at `apps/web/components/legal/LegalHero.tsx:107` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:pb-28` at `apps/web/components/legal/LegalHero.tsx:107` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:pt-28` at `apps/web/components/legal/LegalHero.tsx:107` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[640px]` at `apps/web/components/legal/LegalHero.tsx:108` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[600px]` at `apps/web/components/legal/LegalHero.tsx:109` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[2rem]` at `apps/web/components/legal/LegalHero.tsx:109` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `leading-[1.06]` at `apps/web/components/legal/LegalHero.tsx:109` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[-0.025em]` at `apps/web/components/legal/LegalHero.tsx:109` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#0F172A]` at `apps/web/components/legal/LegalHero.tsx:109` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:text-[2.6rem]` at `apps/web/components/legal/LegalHero.tsx:109` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:text-[3rem]` at `apps/web/components/legal/LegalHero.tsx:109` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[560px]` at `apps/web/components/legal/LegalHero.tsx:116` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[15px]` at `apps/web/components/legal/LegalHero.tsx:116` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `leading-[1.65]` at `apps/web/components/legal/LegalHero.tsx:116` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#475569]` at `apps/web/components/legal/LegalHero.tsx:116` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[12.5px]` at `apps/web/components/legal/LegalHero.tsx:123` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[0.01em]` at `apps/web/components/legal/LegalHero.tsx:123` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (70 rules, 72 properties)

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
| PWA files inspected (rendered tree) | 6 |
| Native files inspected (rendered tree) | 3 |
| PWA elements identified | 104 |
| Native elements identified | 78 |
| Pairable PWA elements | 29 |
| Paired | 0 |
| Missing in Native | 11 |
| Extra in Native | 6 |
| Unlabelled (not pairable by label) | 7 |
| SOURCE-UNRESOLVED labels | 10 |
| PWA style properties resolved | 8 |
| PWA style items SOURCE-UNRESOLVED | 120 |
| Native style properties resolved | 72 |
| PWA interactive elements | 25 |
| Native interactive elements | 16 |
| PWA conditional branches | 46 |
| Native conditional branches | 43 |
