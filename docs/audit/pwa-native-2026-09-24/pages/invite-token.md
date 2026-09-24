# /invite/[token]

**PWA entry:** `apps/web/app/invite/[token]/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/invite/[token].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 7 | 2 |
| Elements | 147 | 56 |
| Interactive elements | 22 | 10 |
| Conditionally-rendered elements | 56 | 14 |
| Style rules resolved | 21 (81 props) | 61 (74 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/invite/[token]/page.tsx` | 36 | `(entry)` |
| 1 | `apps/web/components/marketing/MarketingHeader.tsx` | 47 | `MarketingHeader` |
| 2 | `apps/web/components/analytics/PublicPageView.tsx` | 0 | `PublicPageView` |
| 2 | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx` | 8 | `MarketingLanguageSwitcher` |
| 1 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 2 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 2 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/invite/[token].tsx` | 14 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraLoadingState,ProovraEmptyState,ProovraButton,ProovraErrorState,ProovraSection,ProovraCard,ProovraText` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BUTTON | 7 | 7 | 0 |
| CARD | 0 | 1 | 1 |
| CONTAINER | 33 | 22 | -11 |
| HEADING | 1 | 0 | -1 |
| ICON | 39 | 0 | -39 |
| IMAGE | 2 | 0 | -2 |
| INPUT | 0 | 1 | 1 |
| LINK | 14 | 0 | -14 |
| LIST | 0 | 1 | 1 |
| OTHER | 20 | 5 | -15 |
| STATE_EMPTY | 0 | 1 | 1 |
| STATE_ERROR | 0 | 1 | 1 |
| STATE_LOADING | 1 | 3 | 2 |
| TEXT | 30 | 14 | -16 |

### C.1 Paired (0)

_none_


### C.2 MISSING in Native (10)

| Role | Label | PWA source |
|---|---|---|
| LINK | Privacy | `apps/web/app/invite/[token]/page.tsx:498` |
| LINK | Terms | `apps/web/app/invite/[token]/page.tsx:500` |
| LINK | Support | `apps/web/app/invite/[token]/page.tsx:502` |
| LINK | MARKETING_COPY.brandName | `apps/web/components/marketing/MarketingHeader.tsx:249` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:367` |
| BUTTON | Open menu | `apps/web/components/marketing/MarketingHeader.tsx:376` |
| BUTTON | Close menu | `apps/web/components/marketing/MarketingHeader.tsx:401` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:466` |
| BUTTON | Language | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx:81` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |

### C.3 EXTRA in Native (9)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | phase === "accepting" ? "Joining…" : "Checking invitation" | `apps/mobile/app/(stack)/invite/[token].tsx:87` |
| STATE_EMPTY | Invitation unavailable | `apps/mobile/app/(stack)/invite/[token].tsx:92` |
| BUTTON | Go to app | `apps/mobile/app/(stack)/invite/[token].tsx:95` |
| BUTTON | Accept invitation | `apps/mobile/app/(stack)/invite/[token].tsx:110` |
| BUTTON | Not now | `apps/mobile/app/(stack)/invite/[token].tsx:111` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
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
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (21 rules, 81 properties)

**`.page`** — `apps/web/app/globals.css` · `.page`

- `min-height`: **100vh**
- `display`: **flex**
- `flex-direction`: **column**

**`.invite-shell`** — `apps/web/app/invite/invite.css` · `.invite-shell`

- `display`: **flex**
- `flex-direction`: **column**
- `min-block-size`: **100dvh**
- `background`: **#f7f8fc**
- `color`: **#0f172a**

**`.invite-main`** — `apps/web/app/invite/invite.css` · `.invite-main`

- `flex`: **1**
- `display`: **flex**
- `align-items`: **flex-start**
- `justify-content`: **center**
- `padding-inline`: **20px**
- `padding-block`: **clamp(28px, 7vh, 72px) 56px**

**`.invite-card`** — `apps/web/app/invite/invite.css` · `.invite-card`

- `inline-size`: **100%**
- `max-inline-size`: **660px**
- `background`: **#ffffff**
- `border`: **1px solid #e7ecf4**
- `border-radius`: **16px**
- `box-shadow`: **0 1px 2px rgba(15, 23, 42, 0.04),     0 12px 32px rgba(15, 23, 42, 0.07)**
- `padding`: **clamp(22px, 4vw, 36px)**

**`.invite-card`** — `apps/web/app/invite/invite.css` · `.invite-card [data-system-state-actions]` _[@media (max-width: 420px)]_

- `display`: **flex**
- `flex-direction`: **column**
- `align-items`: **stretch**
- `inline-size`: **100%**

**`.invite-card`** — `apps/web/app/invite/invite.css` · `.invite-card [data-system-state-actions] > a` _[@media (max-width: 420px)]_

- `inline-size`: **100%**
- `justify-content`: **center**

**`.invite-card`** — `apps/web/app/invite/invite.css` · `.invite-card [data-system-state-actions] > button` _[@media (max-width: 420px)]_

- `inline-size`: **100%**
- `justify-content`: **center**

**`.invite-facts`** — `apps/web/app/invite/invite.css` · `.invite-facts`

- `display`: **grid**
- `gap`: **10px 20px**
- `margin-block`: **20px 4px**
- `padding-block`: **18px**
- `border-block`: **1px solid #eef1f7**
- `inline-size`: **100%**

**`.invite-facts`** — `apps/web/app/invite/invite.css` · `.invite-facts > div`

- `display`: **grid**
- `grid-template-columns`: **minmax(96px, auto) minmax(0, 1fr)**
- `gap`: **4px 20px**
- `align-items`: **baseline**

**`.invite-facts`** — `apps/web/app/invite/invite.css` · `.invite-facts dt`

- `margin`: **0**
- `font-size`: **0.75rem**
- `font-weight`: **600**
- `letter-spacing`: **0.04em**
- `text-transform`: **uppercase**
- `color`: **#64748b**

**`.invite-facts`** — `apps/web/app/invite/invite.css` · `.invite-facts dd`

- `margin`: **0**
- `font-size`: **0.9375rem**
- `font-weight`: **600**
- `color`: **#0f172a**
- `overflow-wrap`: **anywhere**

**`.invite-facts`** — `apps/web/app/invite/invite.css` · `.invite-facts time`

- `font-weight`: **600**
- `font-variant-numeric`: **tabular-nums**

**`.invite-facts--loading`** — `apps/web/app/invite/invite.css` · `.invite-facts--loading > div`

- `grid-template-columns`: **minmax(96px, auto) minmax(0, 1fr)**

**`.invite-skel`** — `apps/web/app/invite/invite.css` · `.invite-skel`

- `display`: **block**
- `block-size`: **12px**
- `border-radius`: **6px**
- `background`: **linear-gradient(90deg, #eef1f7 0%, #f7f8fc 50%, #eef1f7 100%)**
- `background-size`: **200% 100%**
- `animation`: **invite-skel-sweep 1.4s ease-in-out infinite**

**`.invite-skel--label`** — `apps/web/app/invite/invite.css` · `.invite-skel--label`

- `inline-size`: **68px**

**`.invite-skel--value`** — `apps/web/app/invite/invite.css` · `.invite-skel--value`

- `inline-size`: **min(240px, 70%)**
- `block-size`: **14px**

**`.invite-trust`** — `apps/web/app/invite/invite.css` · `.invite-trust`

- `margin-block`: **22px 0**
- `padding-block-start`: **16px**
- `border-block-start`: **1px solid #eef1f7**
- `font-size`: **0.8125rem**
- `line-height`: **1.6**
- `color`: **#64748b**
- `inline-size`: **100%**

**`.invite-trust`** — `apps/web/app/invite/invite.css` · `.invite-trust a`

- `color`: **#475569**
- `text-decoration`: **underline**
- `text-underline-offset`: **2px**

**`.invite-trust`** — `apps/web/app/invite/invite.css` · `.invite-trust a:hover`

- `color`: **#0f172a**

**`.invite-trust`** — `apps/web/app/invite/invite.css` · `.invite-trust a:focus-visible`

- `outline`: **2px solid #7c3aed**
- `outline-offset`: **2px**
- `border-radius`: **3px**

**`.rounded-2xl`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-right-panel > .card .rounded-2xl`

- `background`: **var(--capture-glass-card) !important**  ⚠ undeclared --capture-glass-card
- `border`: **1px solid var(--capture-glass-border) !important**  ⚠ undeclared --capture-glass-border
- `box-shadow`: **0 8px 24px rgba(15, 23, 42, 0.035),     inset 0 1px 0 rgba(255, 255, 255, 0.28) !important**
- `backdrop-filter`: **blur(10px) !important**
- `-webkit-backdrop-filter`: **blur(10px) !important**


**Stock Tailwind utilities used (38).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.absolute` → {"kind":"layout","value":"absolute"}
- `.w-full` → {"kind":"layout","value":"w-full"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.justify-between` → {"kind":"layout","value":"justify-between"}
- `.gap-4` → {"kind":"gap","value":"16px"}
- `.px-5` → {"kind":"padding","side":"x","value":"20px"}
- `.py-1.5` → {"kind":"padding","side":"y","value":"6px"}
- `.hidden` → {"kind":"layout","value":"hidden"}
- `.gap-0.5` → {"kind":"gap","value":"2px"}
- `.relative` → {"kind":"layout","value":"relative"}
- `.pt-3` → {"kind":"padding","side":"t","value":"12px"}
- `.items-start` → {"kind":"layout","value":"items-start"}
- `.gap-3` → {"kind":"gap","value":"12px"}
- `.rounded-[14px]` → {"kind":"border-radius"}
- `.p-3` → {"kind":"padding","side":"all","value":"12px"}
- `.justify-center` → {"kind":"layout","value":"justify-center"}
- `.rounded-xl` → {"kind":"border-radius","value":"12px"}
- `.flex-col` → {"kind":"layout","value":"flex-col"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.gap-2` → {"kind":"gap","value":"8px"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.fixed` → {"kind":"layout","value":"fixed"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.py-3` → {"kind":"padding","side":"y","value":"12px"}


### D.2 PWA SOURCE-UNRESOLVED (66)

- `top-0` at `apps/web/components/marketing/MarketingHeader.tsx:242` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `left-0` at `apps/web/components/marketing/MarketingHeader.tsx:242` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `right-0` at `apps/web/components/marketing/MarketingHeader.tsx:242` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-50` at `apps/web/components/marketing/MarketingHeader.tsx:242` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `mx-auto` at `apps/web/components/marketing/MarketingHeader.tsx:248` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[1480px]` at `apps/web/components/marketing/MarketingHeader.tsx:248` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:px-7` at `apps/web/components/marketing/MarketingHeader.tsx:248` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:gap-5` at `apps/web/components/marketing/MarketingHeader.tsx:248` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:px-10` at `apps/web/components/marketing/MarketingHeader.tsx:248` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `2xl:px-12` at `apps/web/components/marketing/MarketingHeader.tsx:248` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `shrink-0` at `apps/web/components/marketing/MarketingHeader.tsx:249` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `h-auto` at `apps/web/components/marketing/MarketingHeader.tsx:255` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `w-[210px]` at `apps/web/components/marketing/MarketingHeader.tsx:255` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-contain` at `apps/web/components/marketing/MarketingHeader.tsx:255` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `drop-shadow-[0_2px_12px_rgba(15,23,42,0.10)]` at `apps/web/components/marketing/MarketingHeader.tsx:255` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:w-[235px]` at `apps/web/components/marketing/MarketingHeader.tsx:255` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:w-[250px]` at `apps/web/components/marketing/MarketingHeader.tsx:255` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `xl:flex` at `apps/web/components/marketing/MarketingHeader.tsx:263` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``flex items-center gap-1 whitespace-nowrap rounded-full px-3.5 py-2 text-[14.5px] font-medium transition-colors ${navTextClass} ${ openDropdown === group.label ? "after:scale-x-100" : "" }`` at `apps/web/components/marketing/MarketingHeader.tsx:275` — className built from a runtime expression
- ``transition-transform ${ openDropdown === group.label ? "rotate-180" : "" }`` at `apps/web/components/marketing/MarketingHeader.tsx:287` — className built from a runtime expression
- `top-full` at `apps/web/components/marketing/MarketingHeader.tsx:295` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``rounded-[24px] border border-[#E5E7EB] bg-white p-3 shadow-[0_24px_60px_rgba(15,23,42,0.12)] ${ group.cols === 2 ? "w-[640px]" : "w-[340px]" }`` at `apps/web/components/marketing/MarketingHeader.tsx:296` — className built from a runtime expression
- ``grid gap-1 ${ group.cols === 2 ? "grid-cols-2" : "grid-cols-1" }`` at `apps/web/components/marketing/MarketingHeader.tsx:301` — className built from a runtime expression
- `group/item` at `apps/web/components/marketing/MarketingHeader.tsx:309` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `transition-colors` at `apps/web/components/marketing/MarketingHeader.tsx:309` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `hover:bg-[#F8FAFC]` at `apps/web/components/marketing/MarketingHeader.tsx:309` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `h-9` at `apps/web/components/marketing/MarketingHeader.tsx:317` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `w-9` at `apps/web/components/marketing/MarketingHeader.tsx:317` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[14px]` at `apps/web/components/marketing/MarketingHeader.tsx:328` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#0F172A]` at `apps/web/components/marketing/MarketingHeader.tsx:328` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (61 rules, 74 properties)

**`actions`** — `apps/mobile/app/(stack)/invite/[token].tsx`

- `marginTop`: **16**
- `gap`: **8**

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
| PWA files inspected (rendered tree) | 7 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 147 |
| Native elements identified | 56 |
| Pairable PWA elements | 25 |
| Paired | 0 |
| Missing in Native | 10 |
| Extra in Native | 9 |
| Unlabelled (not pairable by label) | 5 |
| SOURCE-UNRESOLVED labels | 10 |
| PWA style properties resolved | 81 |
| PWA style items SOURCE-UNRESOLVED | 66 |
| Native style properties resolved | 74 |
| PWA interactive elements | 22 |
| Native interactive elements | 10 |
| PWA conditional branches | 56 |
| Native conditional branches | 14 |
