# /support

**PWA entry:** `apps/web/app/support/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/support.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 5 | 2 |
| Elements | 310 | 54 |
| Interactive elements | 37 | 9 |
| Conditionally-rendered elements | 103 | 21 |
| Style rules resolved | 2 (8 props) | 60 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/support/page.tsx` | 229 | `(entry)` |
| 1 | `apps/web/components/marketing/MarketingHeader.tsx` | 47 | `MarketingHeader` |
| 2 | `apps/web/components/analytics/PublicPageView.tsx` | 0 | `PublicPageView` |
| 2 | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx` | 8 | `MarketingLanguageSwitcher` |
| 1 | `apps/web/components/marketing/EnterpriseFooter.tsx` | 26 | `EnterpriseFooter` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/support.tsx` | 12 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraButton,ProovraCard,ProovraBadge,ProovraText,ProovraPageSection,ProovraListRow` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 1 | 1 |
| BUTTON | 5 | 6 | 1 |
| CARD | 1 | 2 | 1 |
| CONTAINER | 128 | 22 | -106 |
| HEADING | 17 | 0 | -17 |
| ICON | 8 | 0 | -8 |
| IMAGE | 3 | 0 | -3 |
| INPUT | 0 | 1 | 1 |
| LINK | 31 | 0 | -31 |
| LIST | 25 | 2 | -23 |
| OTHER | 40 | 3 | -37 |
| STATE_LOADING | 0 | 2 | 2 |
| TEXT | 52 | 15 | -37 |

### C.1 Paired (1)

| Role | Label | PWA | Native |
|---|---|---|---|
| LINK → BUTTON ⚠ | label | `apps/web/components/marketing/EnterpriseFooter.tsx:140` | `apps/mobile/src/ui/index.tsx:259` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (33)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Get the | `apps/web/app/support/page.tsx:366` |
| LINK | Email support | `apps/web/app/support/page.tsx:386` |
| LINK | Talk to sales | `apps/web/app/support/page.tsx:392` |
| HEADING | Pick the route that matches your request. | `apps/web/app/support/page.tsx:430` |
| HEADING | From question to the right team. | `apps/web/app/support/page.tsx:491` |
| HEADING | What support can help with — and where support must draw the line. | `apps/web/app/support/page.tsx:644` |
| HEADING | How requests are prioritized. | `apps/web/app/support/page.tsx:721` |
| HEADING | Support for procurement, security review, and enterprise                   adoption. | `apps/web/app/support/page.tsx:809` |
| LINK | Trust Center | `apps/web/app/support/page.tsx:851` |
| LINK | Talk to sales | `apps/web/app/support/page.tsx:857` |
| HEADING | Security questions should go through the right path. | `apps/web/app/support/page.tsx:918` |
| LINK | /contact-sales | `apps/web/app/support/page.tsx:997` |
| HEADING | Use the dedicated request path. | `apps/web/app/support/page.tsx:1018` |
| HEADING | Public Support and Support Policy are different surfaces. | `apps/web/app/support/page.tsx:1062` |
| HEADING | Public Support | `apps/web/app/support/page.tsx:1090` |
| HEADING | Support Policy | `apps/web/app/support/page.tsx:1124` |
| LINK | Open Support Policy | `apps/web/app/support/page.tsx:1132` |
| HEADING | Read the documents behind each support path. | `apps/web/app/support/page.tsx:1149` |
| HEADING | Still not sure where your request belongs? | `apps/web/app/support/page.tsx:1225` |
| LINK | Email support | `apps/web/app/support/page.tsx:1235` |
| LINK | Talk to sales | `apps/web/app/support/page.tsx:1241` |
| CARD | Talk to sales | `apps/web/app/support/page.tsx:1246` |
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
| BUTTON | Back | `apps/mobile/app/(stack)/support.tsx:43` |
| BADGE | route.label | `apps/mobile/app/(stack)/support.tsx:52` |
| BUTTON | route.cta | `apps/mobile/app/(stack)/support.tsx:60` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (14)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/app/support/page.tsx:462` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/support/page.tsx:946` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/app/support/page.tsx:975` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/support/page.tsx:1042` | label is computed at runtime and contains no string literal — cannot be paired statically |
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


**Stock Tailwind utilities used (83).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.font-bold` → {"kind":"font-weight","value":700}
- `.relative` → {"kind":"layout","value":"relative"}
- `.overflow-hidden` → {"kind":"layout","value":"overflow-hidden"}
- `.absolute` → {"kind":"layout","value":"absolute"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.pb-24` → {"kind":"padding","side":"b","value":"96px"}
- `.pt-20` → {"kind":"padding","side":"t","value":"80px"}
- `.inline-flex` → {"kind":"layout","value":"inline-flex"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.gap-2` → {"kind":"gap","value":"8px"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.px-3` → {"kind":"padding","side":"x","value":"12px"}
- `.py-1` → {"kind":"padding","side":"y","value":"4px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.mt-4` → {"kind":"margin","side":"t","value":"16px"}
- `.mt-7` → {"kind":"margin","side":"t","value":"28px"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.flex-wrap` → {"kind":"layout","value":"flex-wrap"}
- `.gap-3` → {"kind":"gap","value":"12px"}
- `.justify-center` → {"kind":"layout","value":"justify-center"}
- `.rounded-[14px]` → {"kind":"border-radius"}
- `.px-5` → {"kind":"padding","side":"x","value":"20px"}
- `.mt-6` → {"kind":"margin","side":"t","value":"24px"}
- `.gap-1.5` → {"kind":"gap","value":"6px"}
- `.font-medium` → {"kind":"font-weight","value":500}


### D.2 PWA SOURCE-UNRESOLVED (223)

- `text-[12px]` at `apps/web/app/support/page.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `uppercase` at `apps/web/app/support/page.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[0.16em]` at `apps/web/app/support/page.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `support-page` at `apps/web/app/support/page.tsx:337` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `min-h-[720px]` at `apps/web/app/support/page.tsx:339` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-white` at `apps/web/app/support/page.tsx:339` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `pointer-events-none` at `apps/web/app/support/page.tsx:348` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `inset-0` at `apps/web/app/support/page.tsx:348` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-10` at `apps/web/app/support/page.tsx:356` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `mx-auto` at `apps/web/app/support/page.tsx:359` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[1320px]` at `apps/web/app/support/page.tsx:359` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:px-8` at `apps/web/app/support/page.tsx:359` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:pb-28` at `apps/web/app/support/page.tsx:359` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:pt-28` at `apps/web/app/support/page.tsx:359` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[640px]` at `apps/web/app/support/page.tsx:360` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border` at `apps/web/app/support/page.tsx:361` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[#E0E7FF]` at `apps/web/app/support/page.tsx:361` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[#F8FAFC]` at `apps/web/app/support/page.tsx:361` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[11px]` at `apps/web/app/support/page.tsx:361` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#2563EB]` at `apps/web/app/support/page.tsx:361` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `h-1.5` at `apps/web/app/support/page.tsx:362` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `w-1.5` at `apps/web/app/support/page.tsx:362` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[#7A3CFF]` at `apps/web/app/support/page.tsx:362` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[2rem]` at `apps/web/app/support/page.tsx:366` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `leading-[1.06]` at `apps/web/app/support/page.tsx:366` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[-0.025em]` at `apps/web/app/support/page.tsx:366` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#0F172A]` at `apps/web/app/support/page.tsx:366` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:text-[2.6rem]` at `apps/web/app/support/page.tsx:366` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:text-[3rem]` at `apps/web/app/support/page.tsx:366` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-clip-text` at `apps/web/app/support/page.tsx:368` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (60 rules, 72 properties)

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
| PWA files inspected (rendered tree) | 5 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 310 |
| Native elements identified | 54 |
| Pairable PWA elements | 57 |
| Paired | 0 |
| Missing in Native | 33 |
| Extra in Native | 6 |
| Unlabelled (not pairable by label) | 9 |
| SOURCE-UNRESOLVED labels | 14 |
| PWA style properties resolved | 8 |
| PWA style items SOURCE-UNRESOLVED | 223 |
| Native style properties resolved | 72 |
| PWA interactive elements | 37 |
| Native interactive elements | 9 |
| PWA conditional branches | 103 |
| Native conditional branches | 21 |
