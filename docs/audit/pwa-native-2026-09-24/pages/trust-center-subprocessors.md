# /trust-center/subprocessors

**PWA entry:** `apps/web/app/(app)/trust-center/subprocessors/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/trust-center.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 9 | 2 |
| Elements | 207 | 77 |
| Interactive elements | 16 | 11 |
| Conditionally-rendered elements | 91 | 39 |
| Style rules resolved | 12 (26 props) | 59 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/trust-center/subprocessors/page.tsx` | 48 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/legal/LegalDocumentShell.tsx` | 65 | `LegalDocumentShell` |
| 1 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |
| 1 | `apps/web/app/(app)/trust-center/_version-history.tsx` | 27 | `SubprocessorVersionHistory` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/trust-center.tsx` | 35 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraButton,ProovraCard,ProovraText,ProovraBadge,ProovraPageSection,ProovraEmpty,ProovraSheet` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 2 | 2 |
| BUTTON | 10 | 8 | -2 |
| CARD | 0 | 6 | 6 |
| CONTAINER | 41 | 21 | -20 |
| DIALOG | 0 | 1 | 1 |
| FRAGMENT | 1 | 0 | -1 |
| HEADING | 2 | 0 | -2 |
| ICON | 51 | 0 | -51 |
| INPUT | 0 | 1 | 1 |
| LINK | 6 | 0 | -6 |
| LIST | 36 | 1 | -35 |
| OTHER | 16 | 4 | -12 |
| STATE_EMPTY | 0 | 3 | 3 |
| STATE_ERROR | 3 | 0 | -3 |
| STATE_LOADING | 1 | 2 | 1 |
| TEXT | 40 | 28 | -12 |

### C.1 Paired (1)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON → STATE_EMPTY ⚠ | {busy ? "Loading…" : "Refresh"} | `apps/web/app/(app)/trust-center/subprocessors/page.tsx:119` | `apps/mobile/app/(stack)/trust-center.tsx:183` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (10)

| Role | Label | PWA source |
|---|---|---|
| BUTTON | Re-seed defaults | `apps/web/app/(app)/trust-center/subprocessors/page.tsx:128` |
| BUTTON | {historyFor === r.id ? "Hide history" : "History"} | `apps/web/app/(app)/trust-center/subprocessors/page.tsx:213` |
| LINK | Vendor documentation | `apps/web/app/(app)/trust-center/subprocessors/page.tsx:227` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| BUTTON | On this page | `apps/web/components/legal/LegalDocumentShell.tsx:372` |
| LINK | Open public Trust Center | `apps/web/components/legal/LegalDocumentShell.tsx:460` |
| BUTTON | {open ? "Hide version history" : "Version history"} | `apps/web/app/(app)/trust-center/_version-history.tsx:112` |

### C.3 EXTRA in Native (12)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/trust-center.tsx:109` |
| BADGE | What PROOVRA does not claim | `apps/mobile/app/(stack)/trust-center.tsx:137` |
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

### C.4 SOURCE-UNRESOLVED labels (8)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/legal/LegalDocumentShell.tsx:280` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/legal/LegalDocumentShell.tsx:395` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/trust-center/_version-history.tsx:84` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/trust-center/_version-history.tsx:139` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (12 rules, 26 properties)

**`.legal-table-wrapper`** — `apps/web/app/globals.css` · `.legal-table-wrapper`

- `overflow-x`: **auto**
- `-webkit-overflow-scrolling`: **touch**
- `margin`: **1.75rem 0**
- `border-radius`: **12px**
- `border`: **1px solid #e2e8f0**
- `box-shadow`: **0 1px 2px rgba(15, 23, 42, 0.04)**
- `background`: **#ffffff**

**`.legal-table-wrapper`** — `apps/web/app/globals.css` · `.legal-table-wrapper::-webkit-scrollbar`

- `height`: **8px**

**`.legal-table-wrapper`** — `apps/web/app/globals.css` · `.legal-table-wrapper::-webkit-scrollbar-track`

- `background`: **transparent**
- `margin`: **0 12px**

**`.legal-table-wrapper`** — `apps/web/app/globals.css` · `.legal-table-wrapper::-webkit-scrollbar-thumb`

- `background`: **#cbd5e1**
- `border-radius`: **999px**

**`.legal-table-wrapper`** — `apps/web/app/globals.css` · `.legal-table-wrapper::-webkit-scrollbar-thumb:hover`

- `background`: **#94a3b8**

**`.legal-table-wrapper`** — `apps/web/app/globals.css` · `[data-legal-doc] .legal-table-wrapper` _[@media (min-width: 1200px)]_

- `width`: **max-content**
- `min-width`: **100%**
- `max-width`: **calc(100% + 280px)**
- `margin-left`: **50%**
- `transform`: **translateX(-50%)**

**`.legal-table`** — `apps/web/app/globals.css` · `.legal-table th`

- `min-width`: **8.5rem**
- `vertical-align`: **top**

**`.legal-table`** — `apps/web/app/globals.css` · `.legal-table td`

- `min-width`: **8.5rem**
- `vertical-align`: **top**

**`.legal-table`** — `apps/web/app/globals.css` · `.legal-table th:first-child`

- `padding-left`: **20px !important**

**`.legal-table`** — `apps/web/app/globals.css` · `.legal-table td:first-child`

- `padding-left`: **20px !important**

**`.legal-table`** — `apps/web/app/globals.css` · `.legal-table th:last-child`

- `padding-right`: **20px !important**

**`.legal-table`** — `apps/web/app/globals.css` · `.legal-table td:last-child`

- `padding-right`: **20px !important**


**Stock Tailwind utilities used (42).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.mb-6` → {"kind":"margin","side":"b","value":"24px"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.flex-wrap` → {"kind":"layout","value":"flex-wrap"}
- `.gap-2` → {"kind":"gap","value":"8px"}
- `.mb-4` → {"kind":"margin","side":"b","value":"16px"}
- `.grid` → {"kind":"layout","value":"grid"}
- `.gap-1.5` → {"kind":"gap","value":"6px"}
- `.rounded-lg` → {"kind":"border-radius","value":"8px"}
- `.px-4` → {"kind":"padding","side":"x","value":"16px"}
- `.py-3` → {"kind":"padding","side":"y","value":"12px"}
- `.mb-1` → {"kind":"margin","side":"b","value":"4px"}
- `.mr-1` → {"kind":"margin","side":"r","value":"4px"}
- `.w-full` → {"kind":"layout","value":"w-full"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.py-10` → {"kind":"padding","side":"y","value":"40px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.inline-flex` → {"kind":"layout","value":"inline-flex"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.px-3` → {"kind":"padding","side":"x","value":"12px"}
- `.py-1` → {"kind":"padding","side":"y","value":"4px"}
- `.mt-4` → {"kind":"margin","side":"t","value":"16px"}
- `.mt-3` → {"kind":"margin","side":"t","value":"12px"}
- `.mt-6` → {"kind":"margin","side":"t","value":"24px"}
- `.mt-7` → {"kind":"margin","side":"t","value":"28px"}


### D.2 PWA SOURCE-UNRESOLVED (84)

- ``${buttonClasses} border-[#0F172A] bg-[#0F172A] text-white hover:opacity-90`` at `apps/web/app/(app)/trust-center/subprocessors/page.tsx:119` — className built from a runtime expression
- ``${buttonClasses} border-[#DDE6F2] bg-white text-[#0F172A] hover:border-[#94A3B8]`` at `apps/web/app/(app)/trust-center/subprocessors/page.tsx:128` — className built from a runtime expression
- `border` at `apps/web/app/(app)/trust-center/subprocessors/page.tsx:140` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[rgba(148,163,184,0.28)]` at `apps/web/app/(app)/trust-center/subprocessors/page.tsx:140` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[rgba(148,163,184,0.10)]` at `apps/web/app/(app)/trust-center/subprocessors/page.tsx:140` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[0.9rem]` at `apps/web/app/(app)/trust-center/subprocessors/page.tsx:140` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#334155]` at `apps/web/app/(app)/trust-center/subprocessors/page.tsx:140` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[rgba(185,28,28,0.20)]` at `apps/web/app/(app)/trust-center/subprocessors/page.tsx:152` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[rgba(185,28,28,0.06)]` at `apps/web/app/(app)/trust-center/subprocessors/page.tsx:152` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#7f1d1d]` at `apps/web/app/(app)/trust-center/subprocessors/page.tsx:152` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `inline-block` at `apps/web/app/(app)/trust-center/subprocessors/page.tsx:205` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `legal-link` at `apps/web/app/(app)/trust-center/subprocessors/page.tsx:227` — no CSS rule in apps/web and not a recognised stock Tailwind utility
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
- `border-[#DDE6F2]` at `apps/web/components/legal/LegalDocumentShell.tsx:291` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-white/80` at `apps/web/components/legal/LegalDocumentShell.tsx:291` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[11.5px]` at `apps/web/components/legal/LegalDocumentShell.tsx:291` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `uppercase` at `apps/web/components/legal/LegalDocumentShell.tsx:291` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[0.12em]` at `apps/web/components/legal/LegalDocumentShell.tsx:291` — no CSS rule in apps/web and not a recognised stock Tailwind utility

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
| PWA files inspected (rendered tree) | 9 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 207 |
| Native elements identified | 77 |
| Pairable PWA elements | 22 |
| Paired | 0 |
| Missing in Native | 10 |
| Extra in Native | 12 |
| Unlabelled (not pairable by label) | 3 |
| SOURCE-UNRESOLVED labels | 8 |
| PWA style properties resolved | 26 |
| PWA style items SOURCE-UNRESOLVED | 84 |
| Native style properties resolved | 72 |
| PWA interactive elements | 16 |
| Native interactive elements | 11 |
| PWA conditional branches | 91 |
| Native conditional branches | 39 |
