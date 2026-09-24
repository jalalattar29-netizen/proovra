# /trust

**PWA entry:** `apps/web/app/trust/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/trust-center.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 6 | 2 |
| Elements | 303 | 77 |
| Interactive elements | 34 | 11 |
| Conditionally-rendered elements | 98 | 39 |
| Style rules resolved | 1 (5 props) | 59 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/trust/page.tsx` | 207 | `(entry)` |
| 1 | `apps/web/components/marketing/MarketingHeader.tsx` | 47 | `MarketingHeader` |
| 2 | `apps/web/components/analytics/PublicPageView.tsx` | 0 | `PublicPageView` |
| 2 | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx` | 8 | `MarketingLanguageSwitcher` |
| 1 | `apps/web/components/motion/index.tsx` | 15 | `RevealSection` |
| 1 | `apps/web/components/marketing/EnterpriseFooter.tsx` | 26 | `EnterpriseFooter` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/trust-center.tsx` | 35 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraButton,ProovraCard,ProovraText,ProovraBadge,ProovraPageSection,ProovraEmpty,ProovraSheet` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 6 | 2 | -4 |
| BUTTON | 5 | 8 | 3 |
| CARD | 0 | 6 | 6 |
| CONTAINER | 108 | 21 | -87 |
| DIALOG | 0 | 1 | 1 |
| HEADING | 14 | 0 | -14 |
| ICON | 4 | 0 | -4 |
| IMAGE | 3 | 0 | -3 |
| INPUT | 0 | 1 | 1 |
| LINK | 28 | 0 | -28 |
| LIST | 16 | 1 | -15 |
| OTHER | 59 | 4 | -55 |
| STATE_EMPTY | 0 | 3 | 3 |
| STATE_LOADING | 0 | 2 | 2 |
| TEXT | 60 | 28 | -32 |

### C.1 Paired (1)

| Role | Label | PWA | Native |
|---|---|---|---|
| LINK → BUTTON ⚠ | label | `apps/web/components/marketing/EnterpriseFooter.tsx:140` | `apps/mobile/src/ui/index.tsx:259` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (25)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Trust, security, privacy, and | `apps/web/app/trust/page.tsx:550` |
| LINK | Review documentation | `apps/web/app/trust/page.tsx:589` |
| LINK | Contact sales | `apps/web/app/trust/page.tsx:597` |
| HEADING | What PROOVRA records | `apps/web/app/trust/page.tsx:640` |
| HEADING | What PROOVRA does not decide | `apps/web/app/trust/page.tsx:668` |
| HEADING | Built for security, legal, and procurement review. | `apps/web/app/trust/page.tsx:1045` |
| LINK | Start enterprise review | `apps/web/app/trust/page.tsx:1061` |
| LINK | Open Support Center | `apps/web/app/trust/page.tsx:1069` |
| HEADING | What PROOVRA publishes | `apps/web/app/trust/page.tsx:1187` |
| HEADING | What PROOVRA avoids | `apps/web/app/trust/page.tsx:1227` |
| HEADING | Need to review PROOVRA for your organization? | `apps/web/app/trust/page.tsx:1352` |
| LINK | Contact sales | `apps/web/app/trust/page.tsx:1368` |
| LINK | Support Center | `apps/web/app/trust/page.tsx:1376` |
| LINK | View Verification Methodology | `apps/web/app/trust/page.tsx:1386` |
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

### C.3 EXTRA in Native (12)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/trust-center.tsx:109` |
| BADGE | What PROOVRA does not claim | `apps/mobile/app/(stack)/trust-center.tsx:137` |
| STATE_EMPTY | Loading… | `apps/mobile/app/(stack)/trust-center.tsx:183` |
| STATE_EMPTY | Not included in your plan | `apps/mobile/app/(stack)/trust-center.tsx:185` |
| BADGE | Unavailable | `apps/mobile/app/(stack)/trust-center.tsx:192` |
| BUTTON | Try again | `apps/mobile/app/(stack)/trust-center.tsx:196` |
| STATE_EMPTY | Nothing published yet | `apps/mobile/app/(stack)/trust-center.tsx:204` |
| BUTTON | a.title | `apps/mobile/app/(stack)/trust-center.tsx:212` |
| BUTTON | showVersions ? "Hide earlier versions" : `Earlier versions (${versions.length - 1})` | `apps/mobile/app/(stack)/trust-center.tsx:255` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (17)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/app/trust/page.tsx:471` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/trust/page.tsx:761` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/app/trust/page.tsx:776` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/trust/page.tsx:906` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/trust/page.tsx:963` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/trust/page.tsx:1098` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/trust/page.tsx:1288` | label is computed at runtime and contains no string literal — cannot be paired statically |
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

### D.1 PWA classes resolved to literals (1 rules, 5 properties)

**`.rounded-2xl`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-right-panel > .card .rounded-2xl`

- `background`: **var(--capture-glass-card) !important**  ⚠ undeclared --capture-glass-card
- `border`: **1px solid var(--capture-glass-border) !important**  ⚠ undeclared --capture-glass-border
- `box-shadow`: **0 8px 24px rgba(15, 23, 42, 0.035),     inset 0 1px 0 rgba(255, 255, 255, 0.28) !important**
- `backdrop-filter`: **blur(10px) !important**
- `-webkit-backdrop-filter`: **blur(10px) !important**


**Stock Tailwind utilities used (81).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.inline-flex` → {"kind":"layout","value":"inline-flex"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.gap-2` → {"kind":"gap","value":"8px"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.px-3.5` → {"kind":"padding","side":"x","value":"14px"}
- `.py-1.5` → {"kind":"padding","side":"y","value":"6px"}
- `.font-extrabold` → {"kind":"font-weight","value":800}
- `.justify-center` → {"kind":"layout","value":"justify-center"}
- `.rounded-[12px]` → {"kind":"border-radius"}
- `.relative` → {"kind":"layout","value":"relative"}
- `.overflow-hidden` → {"kind":"layout","value":"overflow-hidden"}
- `.absolute` → {"kind":"layout","value":"absolute"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.pb-24` → {"kind":"padding","side":"b","value":"96px"}
- `.pt-20` → {"kind":"padding","side":"t","value":"80px"}
- `.mt-4` → {"kind":"margin","side":"t","value":"16px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.mt-5` → {"kind":"margin","side":"t","value":"20px"}
- `.mt-6` → {"kind":"margin","side":"t","value":"24px"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.flex-wrap` → {"kind":"layout","value":"flex-wrap"}
- `.gap-1.5` → {"kind":"gap","value":"6px"}
- `.px-3` → {"kind":"padding","side":"x","value":"12px"}
- `.font-medium` → {"kind":"font-weight","value":500}
- `.block` → {"kind":"layout","value":"block"}


### D.2 PWA SOURCE-UNRESOLVED (204)

- `border` at `apps/web/app/trust/page.tsx:447` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-white` at `apps/web/app/trust/page.tsx:447` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[11px]` at `apps/web/app/trust/page.tsx:447` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `uppercase` at `apps/web/app/trust/page.tsx:447` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[0.18em]` at `apps/web/app/trust/page.tsx:447` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `h-1.5` at `apps/web/app/trust/page.tsx:451` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `w-1.5` at `apps/web/app/trust/page.tsx:451` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``${center ? "mx-auto text-center" : ""} mt-3 max-w-[860px] text-[1.85rem] font-semibold leading-[1.12] tracking-[-0.025em] md:text-[2.35rem]`` at `apps/web/app/trust/page.tsx:471` — className built from a runtime expression
- ``${center ? "mx-auto text-center" : ""} mt-4 max-w-[820px] text-[15.5px] leading-[1.78]`` at `apps/web/app/trust/page.tsx:490` — className built from a runtime expression
- `h-11` at `apps/web/app/trust/page.tsx:507` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `w-11` at `apps/web/app/trust/page.tsx:507` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `shrink-0` at `apps/web/app/trust/page.tsx:507` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `min-h-[720px]` at `apps/web/app/trust/page.tsx:534` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `inset-0` at `apps/web/app/trust/page.tsx:535` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-10` at `apps/web/app/trust/page.tsx:545` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `mx-auto` at `apps/web/app/trust/page.tsx:547` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[1320px]` at `apps/web/app/trust/page.tsx:547` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:px-8` at `apps/web/app/trust/page.tsx:547` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:pb-28` at `apps/web/app/trust/page.tsx:547` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:pt-28` at `apps/web/app/trust/page.tsx:547` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[760px]` at `apps/web/app/trust/page.tsx:548` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[700px]` at `apps/web/app/trust/page.tsx:550` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[2rem]` at `apps/web/app/trust/page.tsx:550` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `leading-[1.06]` at `apps/web/app/trust/page.tsx:550` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[-0.025em]` at `apps/web/app/trust/page.tsx:550` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:text-[2.6rem]` at `apps/web/app/trust/page.tsx:550` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:text-[3rem]` at `apps/web/app/trust/page.tsx:550` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-clip-text` at `apps/web/app/trust/page.tsx:555` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-transparent` at `apps/web/app/trust/page.tsx:555` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[640px]` at `apps/web/app/trust/page.tsx:562` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (59 rules, 72 properties)

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
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 303 |
| Native elements identified | 77 |
| Pairable PWA elements | 56 |
| Paired | 0 |
| Missing in Native | 25 |
| Extra in Native | 12 |
| Unlabelled (not pairable by label) | 13 |
| SOURCE-UNRESOLVED labels | 17 |
| PWA style properties resolved | 5 |
| PWA style items SOURCE-UNRESOLVED | 204 |
| Native style properties resolved | 72 |
| PWA interactive elements | 34 |
| Native interactive elements | 11 |
| PWA conditional branches | 98 |
| Native conditional branches | 39 |
