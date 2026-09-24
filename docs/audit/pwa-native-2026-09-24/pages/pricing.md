# /pricing

**PWA entry:** `apps/web/app/pricing/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/billing.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 6 | 3 |
| Elements | 230 | 98 |
| Interactive elements | 32 | 13 |
| Conditionally-rendered elements | 98 | 62 |
| Style rules resolved | 2 (8 props) | 74 (80 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/pricing/page.tsx` | 134 | `(entry)` |
| 1 | `apps/web/components/marketing/MarketingHeader.tsx` | 47 | `MarketingHeader` |
| 2 | `apps/web/components/analytics/PublicPageView.tsx` | 0 | `PublicPageView` |
| 2 | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx` | 8 | `MarketingLanguageSwitcher` |
| 1 | `apps/web/components/motion/index.tsx` | 15 | `RevealSection` |
| 1 | `apps/web/components/marketing/EnterpriseFooter.tsx` | 26 | `EnterpriseFooter` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/billing.tsx` | 29 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraButton,ProovraSection,ProovraLoadingState,ProovraErrorState,ProovraCard,ProovraText,ProovraBadge` |
| 1 | `apps/mobile/src/ui/billing-sections.tsx` | 27 | `BillingSections` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 6 | 6 |
| BUTTON | 5 | 8 | 3 |
| CARD | 0 | 8 | 8 |
| CONTAINER | 93 | 29 | -64 |
| DIALOG | 0 | 1 | 1 |
| HEADING | 6 | 0 | -6 |
| ICON | 8 | 0 | -8 |
| IMAGE | 3 | 0 | -3 |
| INPUT | 0 | 1 | 1 |
| LINK | 26 | 0 | -26 |
| LIST | 19 | 1 | -18 |
| OTHER | 42 | 8 | -34 |
| STATE_EMPTY | 0 | 1 | 1 |
| STATE_ERROR | 0 | 1 | 1 |
| STATE_LOADING | 0 | 4 | 4 |
| TEXT | 28 | 30 | 2 |

### C.1 Paired (1)

| Role | Label | PWA | Native |
|---|---|---|---|
| LINK → BUTTON ⚠ | label | `apps/web/components/marketing/EnterpriseFooter.tsx:140` | `apps/mobile/src/ui/index.tsx:259` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (21)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Choose the right operational model for your evidence program. | `apps/web/app/pricing/page.tsx:902` |
| LINK | Talk to an expert | `apps/web/app/pricing/page.tsx:981` |
| LINK | Request demo | `apps/web/app/pricing/page.tsx:987` |
| HEADING | Built for procurement, governance, and large-scale evidence                   operations. | `apps/web/app/pricing/page.tsx:1172` |
| LINK | Schedule a demo | `apps/web/app/pricing/page.tsx:1213` |
| LINK | Talk to Sales | `apps/web/app/pricing/page.tsx:1223` |
| HEADING | Ready to modernize your evidence operations? | `apps/web/app/pricing/page.tsx:1385` |
| LINK | Request demo → | `apps/web/app/pricing/page.tsx:1396` |
| LINK | Talk to Sales → | `apps/web/app/pricing/page.tsx:1403` |
| LINK | Start free | `apps/web/app/pricing/page.tsx:1410` |
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

### C.3 EXTRA in Native (17)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/billing.tsx:88` |
| STATE_LOADING | Loading plan | `apps/mobile/app/(stack)/billing.tsx:92` |
| BADGE | Active | `apps/mobile/app/(stack)/billing.tsx:101` |
| BADGE | Your plan | `apps/mobile/app/(stack)/billing.tsx:122` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |
| BADGE | overview.plan | `apps/mobile/src/ui/billing-sections.tsx:144` |
| BADGE | `${overview.credits} credits` | `apps/mobile/src/ui/billing-sections.tsx:146` |
| BUTTON | Cancel subscription | `apps/mobile/src/ui/billing-sections.tsx:162` |
| BUTTON | Ask the provider again | `apps/mobile/src/ui/billing-sections.tsx:183` |
| BUTTON | Cancel | `apps/mobile/src/ui/billing-sections.tsx:203` |
| BADGE | a.status | `apps/mobile/src/ui/billing-sections.tsx:213` |
| STATE_LOADING | Loading payments | `apps/mobile/src/ui/billing-sections.tsx:224` |
| STATE_EMPTY | No payments have been recorded. | `apps/mobile/src/ui/billing-sections.tsx:226` |
| BADGE | p.status | `apps/mobile/src/ui/billing-sections.tsx:241` |
| DIALOG | pending?.kind === "subscription" ? "Cancel your subscription?" : pending ? `Cancel ${pending.addon.label}?` : "" | `apps/mobile/src/ui/billing-sections.tsx:276` |

### C.4 SOURCE-UNRESOLVED labels (13)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/app/pricing/page.tsx:963` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/pricing/page.tsx:1036` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/app/pricing/page.tsx:1064` | label is computed at runtime and contains no string literal — cannot be paired statically |
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


**Stock Tailwind utilities used (79).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.inline-flex` → {"kind":"layout","value":"inline-flex"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.gap-2` → {"kind":"gap","value":"8px"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.px-4` → {"kind":"padding","side":"x","value":"16px"}
- `.py-1.5` → {"kind":"padding","side":"y","value":"6px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.absolute` → {"kind":"layout","value":"absolute"}
- `.relative` → {"kind":"layout","value":"relative"}
- `.overflow-hidden` → {"kind":"layout","value":"overflow-hidden"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.pt-16` → {"kind":"padding","side":"t","value":"64px"}
- `.mt-5` → {"kind":"margin","side":"t","value":"20px"}
- `.mt-8` → {"kind":"margin","side":"t","value":"32px"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.flex-wrap` → {"kind":"layout","value":"flex-wrap"}
- `.justify-center` → {"kind":"layout","value":"justify-center"}
- `.font-medium` → {"kind":"font-weight","value":500}
- `.pt-8` → {"kind":"padding","side":"t","value":"32px"}
- `.grid` → {"kind":"layout","value":"grid"}
- `.items-stretch` → {"kind":"layout","value":"items-stretch"}
- `.gap-5` → {"kind":"gap","value":"20px"}
- `.h-full` → {"kind":"layout","value":"h-full"}
- `.flex-col` → {"kind":"layout","value":"flex-col"}
- `.rounded-[24px]` → {"kind":"border-radius"}


### D.2 PWA SOURCE-UNRESOLVED (245)

- ``inline-flex ${frameSize} shrink-0 items-center justify-center rounded-2xl p-[2.5px] shadow-[0_8px_18px_rgba(15,23,42,0.05)]`` at `apps/web/app/pricing/page.tsx:90` — className built from a runtime expression
- ``flex h-full w-full items-center justify-center ${innerRadius} bg-white`` at `apps/web/app/pricing/page.tsx:97` — className built from a runtime expression
- `border` at `apps/web/app/pricing/page.tsx:848` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[#E0E7FF]` at `apps/web/app/pricing/page.tsx:848` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-white/95` at `apps/web/app/pricing/page.tsx:848` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[11.5px]` at `apps/web/app/pricing/page.tsx:848` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `uppercase` at `apps/web/app/pricing/page.tsx:848` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[0.14em]` at `apps/web/app/pricing/page.tsx:848` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#2563EB]` at `apps/web/app/pricing/page.tsx:848` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `shadow-[0_8px_20px_rgba(37,99,235,0.06)]` at `apps/web/app/pricing/page.tsx:848` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `h-1.5` at `apps/web/app/pricing/page.tsx:849` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `w-1.5` at `apps/web/app/pricing/page.tsx:849` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[#5B21B6]` at `apps/web/app/pricing/page.tsx:849` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `landing-page` at `apps/web/app/pricing/page.tsx:855` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[var(--proovra-page-bg)]` at `apps/web/app/pricing/page.tsx:855` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `inset-0` at `apps/web/app/pricing/page.tsx:873` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-10` at `apps/web/app/pricing/page.tsx:893` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `mx-auto` at `apps/web/app/pricing/page.tsx:896` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-7xl` at `apps/web/app/pricing/page.tsx:896` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `pb-14` at `apps/web/app/pricing/page.tsx:896` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-center` at `apps/web/app/pricing/page.tsx:896` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:px-8` at `apps/web/app/pricing/page.tsx:896` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:pb-20` at `apps/web/app/pricing/page.tsx:896` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:pt-20` at `apps/web/app/pricing/page.tsx:896` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:pt-24` at `apps/web/app/pricing/page.tsx:896` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[820px]` at `apps/web/app/pricing/page.tsx:902` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[2rem]` at `apps/web/app/pricing/page.tsx:902` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `leading-[1.06]` at `apps/web/app/pricing/page.tsx:902` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[-0.035em]` at `apps/web/app/pricing/page.tsx:902` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#0F172A]` at `apps/web/app/pricing/page.tsx:902` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (74 rules, 80 properties)

**`headerRow`** — `apps/mobile/app/(stack)/billing.tsx`

- `flexDirection`: **row**
- `marginTop`: **8**  _(theme.space.s2)_

**`card`** — `apps/mobile/app/(stack)/billing.tsx`

- `marginBottom`: **16**  _(theme.space.s4)_
- `gap`: **12**  _(theme.space.s3)_

**`planRow`** — `apps/mobile/app/(stack)/billing.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **12**  _(theme.space.s3)_
- `marginTop`: **8**  _(theme.space.s2)_

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
| PWA elements identified | 230 |
| Native elements identified | 98 |
| Pairable PWA elements | 40 |
| Paired | 0 |
| Missing in Native | 21 |
| Extra in Native | 17 |
| Unlabelled (not pairable by label) | 5 |
| SOURCE-UNRESOLVED labels | 13 |
| PWA style properties resolved | 8 |
| PWA style items SOURCE-UNRESOLVED | 245 |
| Native style properties resolved | 80 |
| PWA interactive elements | 32 |
| Native interactive elements | 13 |
| PWA conditional branches | 98 |
| Native conditional branches | 62 |
