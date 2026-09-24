# /trust-center/ai-disclosure

**PWA entry:** `apps/web/app/(app)/trust-center/ai-disclosure/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/trust-center.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 12 | 2 |
| Elements | 218 | 77 |
| Interactive elements | 13 | 11 |
| Conditionally-rendered elements | 110 | 39 |
| Style rules resolved | 11 (27 props) | 59 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/trust-center/ai-disclosure/page.tsx` | 4 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/app/(app)/trust-center/_section-list.tsx` | 20 | `TrustCenterSectionList` |
| 2 | `apps/web/components/legal/LegalDocumentShell.tsx` | 65 | `LegalDocumentShell` |
| 2 | `apps/web/app/(app)/trust-center/_drift-badge.tsx` | 1 | `DriftBadge` |
| 2 | `apps/web/app/(app)/trust-center/_version-history.tsx` | 27 | `ArticleVersionHistory` |
| 3 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |
| 1 | `apps/web/components/ai-copilot/AiCapabilityStatusTable.tsx` | 34 | `AiCapabilityStatusTable` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/trust-center.tsx` | 35 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraButton,ProovraCard,ProovraText,ProovraBadge,ProovraPageSection,ProovraEmpty,ProovraSheet` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 1 | 2 | 1 |
| BUTTON | 8 | 8 | 0 |
| CARD | 0 | 6 | 6 |
| CONTAINER | 51 | 21 | -30 |
| DIALOG | 0 | 1 | 1 |
| HEADING | 4 | 0 | -4 |
| ICON | 51 | 0 | -51 |
| INPUT | 0 | 1 | 1 |
| LINK | 5 | 0 | -5 |
| LIST | 28 | 1 | -27 |
| OTHER | 17 | 4 | -13 |
| STATE_EMPTY | 0 | 3 | 3 |
| STATE_ERROR | 3 | 0 | -3 |
| STATE_LOADING | 1 | 2 | 1 |
| TEXT | 49 | 28 | -21 |

### C.1 Paired (0)

_none_


### C.2 MISSING in Native (8)

| Role | Label | PWA source |
|---|---|---|
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| BUTTON | On this page | `apps/web/components/legal/LegalDocumentShell.tsx:372` |
| LINK | Open public Trust Center | `apps/web/components/legal/LegalDocumentShell.tsx:460` |
| BUTTON | {open ? "Hide version history" : "Version history"} | `apps/web/app/(app)/trust-center/_version-history.tsx:112` |
| HEADING | Live AI capability status (this workspace) | `apps/web/components/ai-copilot/AiCapabilityStatusTable.tsx:102` |

### C.3 EXTRA in Native (13)

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
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (10)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/trust-center/_section-list.tsx:184` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/trust-center/_section-list.tsx:243` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/legal/LegalDocumentShell.tsx:280` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/legal/LegalDocumentShell.tsx:395` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/trust-center/_version-history.tsx:84` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/trust-center/_version-history.tsx:139` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (11 rules, 27 properties)

**`.app-panel`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel`

- `min-width`: **0**
- `background`: **rgba(255, 255, 255, 0.42)**
- `border`: **1px solid rgba(255, 255, 255, 0.58)**
- `box-shadow`: **0 10px 28px rgba(15, 23, 42, 0.04)**
- `backdrop-filter`: **blur(8px)**
- `-webkit-backdrop-filter`: **blur(8px)**
- `border-radius`: **18px**

**`.app-panel__body`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel__body`

- `padding`: **16px 18px**

**`.app-panel__body`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-grid-panels--stretch > * > .app-panel__body`

- `flex`: **1 1 auto**

**`.app-panel__body`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel--actions-bottom > .app-panel__body`

- `display`: **flex**
- `flex-direction`: **column**

**`.app-panel__body`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-panel--actions-bottom > .app-panel__body > :last-child`

- `margin-top`: **auto**

**`.app-alert`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-alert`

- `padding`: **12px**
- `border`: **1px solid rgba(15, 23, 42, 0.08)**
- `border-radius`: **12px**  _(--radius-lg=12px)_
- `background`: **rgba(255, 255, 255, 0.70)**
- `font-size`: **13px**
- `line-height`: **1.5**
- `color`: **#667085**  _(--app-ink-secondary=#667085)_

**`.legal-scroll`** — `apps/web/app/globals.css` · `.legal-scroll`

- `scrollbar-width`: **thin**
- `scrollbar-color`: **#cbd5e1 transparent**

**`.legal-scroll`** — `apps/web/app/globals.css` · `.legal-scroll::-webkit-scrollbar`

- `height`: **8px**

**`.legal-scroll`** — `apps/web/app/globals.css` · `.legal-scroll::-webkit-scrollbar-track`

- `background`: **transparent**
- `margin`: **0 12px**

**`.legal-scroll`** — `apps/web/app/globals.css` · `.legal-scroll::-webkit-scrollbar-thumb`

- `background`: **#cbd5e1**
- `border-radius`: **999px**

**`.legal-scroll`** — `apps/web/app/globals.css` · `.legal-scroll::-webkit-scrollbar-thumb:hover`

- `background`: **#94a3b8**


**Stock Tailwind utilities used (42).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.mb-8` → {"kind":"margin","side":"b","value":"32px"}
- `.mb-6` → {"kind":"margin","side":"b","value":"24px"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.justify-between` → {"kind":"layout","value":"justify-between"}
- `.gap-3` → {"kind":"gap","value":"12px"}
- `.rounded-lg` → {"kind":"border-radius","value":"8px"}
- `.px-3` → {"kind":"padding","side":"x","value":"12px"}
- `.py-1.5` → {"kind":"padding","side":"y","value":"6px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.px-4` → {"kind":"padding","side":"x","value":"16px"}
- `.py-3` → {"kind":"padding","side":"y","value":"12px"}
- `.grid` → {"kind":"layout","value":"grid"}
- `.gap-1.5` → {"kind":"gap","value":"6px"}
- `.w-full` → {"kind":"layout","value":"w-full"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.py-10` → {"kind":"padding","side":"y","value":"40px"}
- `.flex-wrap` → {"kind":"layout","value":"flex-wrap"}
- `.gap-2` → {"kind":"gap","value":"8px"}
- `.inline-flex` → {"kind":"layout","value":"inline-flex"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.py-1` → {"kind":"padding","side":"y","value":"4px"}
- `.mt-4` → {"kind":"margin","side":"t","value":"16px"}
- `.mt-3` → {"kind":"margin","side":"t","value":"12px"}
- `.mt-6` → {"kind":"margin","side":"t","value":"24px"}


### D.2 PWA SOURCE-UNRESOLVED (87)

- `LEGAL_META_CLASSES` at `apps/web/app/(app)/trust-center/_section-list.tsx:175` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border` at `apps/web/app/(app)/trust-center/_section-list.tsx:184` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[#DDE6F2]` at `apps/web/app/(app)/trust-center/_section-list.tsx:184` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-white` at `apps/web/app/(app)/trust-center/_section-list.tsx:184` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[12px]` at `apps/web/app/(app)/trust-center/_section-list.tsx:184` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#0F172A]` at `apps/web/app/(app)/trust-center/_section-list.tsx:184` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `hover:border-[#94A3B8]` at `apps/web/app/(app)/trust-center/_section-list.tsx:184` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `disabled:opacity-60` at `apps/web/app/(app)/trust-center/_section-list.tsx:184` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[rgba(185,28,28,0.20)]` at `apps/web/app/(app)/trust-center/_section-list.tsx:202` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[rgba(185,28,28,0.06)]` at `apps/web/app/(app)/trust-center/_section-list.tsx:202` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[0.9rem]` at `apps/web/app/(app)/trust-center/_section-list.tsx:202` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#7f1d1d]` at `apps/web/app/(app)/trust-center/_section-list.tsx:202` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[rgba(148,163,184,0.28)]` at `apps/web/app/(app)/trust-center/_section-list.tsx:212` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[rgba(148,163,184,0.10)]` at `apps/web/app/(app)/trust-center/_section-list.tsx:212` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#334155]` at `apps/web/app/(app)/trust-center/_section-list.tsx:212` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``-mt-2 mb-4 ${LEGAL_META_CLASSES}`` at `apps/web/app/(app)/trust-center/_section-list.tsx:244` — className built from a runtime expression
- `bg-clip-text` at `apps/web/components/legal/LegalDocumentShell.tsx:100` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-transparent` at `apps/web/components/legal/LegalDocumentShell.tsx:100` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `legal-document-shell` at `apps/web/components/legal/LegalDocumentShell.tsx:264` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `mx-auto` at `apps/web/components/legal/LegalDocumentShell.tsx:272` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[860px]` at `apps/web/components/legal/LegalDocumentShell.tsx:272` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:px-8` at `apps/web/components/legal/LegalDocumentShell.tsx:272` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:py-12` at `apps/web/components/legal/LegalDocumentShell.tsx:272` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[12.5px]` at `apps/web/components/legal/LegalDocumentShell.tsx:280` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#475569]` at `apps/web/components/legal/LegalDocumentShell.tsx:280` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `no-underline` at `apps/web/components/legal/LegalDocumentShell.tsx:280` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `hover:text-[#1E40AF]` at `apps/web/components/legal/LegalDocumentShell.tsx:280` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `hover:underline` at `apps/web/components/legal/LegalDocumentShell.tsx:280` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `hover:underline-offset-4` at `apps/web/components/legal/LegalDocumentShell.tsx:280` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-white/80` at `apps/web/components/legal/LegalDocumentShell.tsx:291` — no CSS rule in apps/web and not a recognised stock Tailwind utility

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
| PWA files inspected (rendered tree) | 12 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 218 |
| Native elements identified | 77 |
| Pairable PWA elements | 22 |
| Paired | 0 |
| Missing in Native | 8 |
| Extra in Native | 13 |
| Unlabelled (not pairable by label) | 4 |
| SOURCE-UNRESOLVED labels | 10 |
| PWA style properties resolved | 27 |
| PWA style items SOURCE-UNRESOLVED | 87 |
| Native style properties resolved | 72 |
| PWA interactive elements | 13 |
| Native interactive elements | 11 |
| PWA conditional branches | 110 |
| Native conditional branches | 39 |
