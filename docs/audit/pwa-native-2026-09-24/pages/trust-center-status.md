# /trust-center/status

**PWA entry:** `apps/web/app/(app)/trust-center/status/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/trust-center.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 7 | 2 |
| Elements | 204 | 77 |
| Interactive elements | 11 | 11 |
| Conditionally-rendered elements | 112 | 39 |
| Style rules resolved | 0 (0 props) | 59 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/trust-center/status/page.tsx` | 77 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/legal/LegalDocumentShell.tsx` | 65 | `LegalDocumentShell` |

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
| BUTTON | 5 | 8 | 3 |
| CARD | 0 | 6 | 6 |
| CONTAINER | 39 | 21 | -18 |
| DIALOG | 0 | 1 | 1 |
| HEADING | 6 | 0 | -6 |
| ICON | 51 | 0 | -51 |
| INPUT | 0 | 1 | 1 |
| LINK | 6 | 0 | -6 |
| LIST | 39 | 1 | -38 |
| OTHER | 12 | 4 | -8 |
| STATE_EMPTY | 0 | 3 | 3 |
| STATE_ERROR | 3 | 0 | -3 |
| STATE_LOADING | 0 | 2 | 2 |
| TEXT | 43 | 28 | -15 |

### C.1 Paired (0)

_none_


### C.2 MISSING in Native (12)

| Role | Label | PWA source |
|---|---|---|
| BUTTON | Retry | `apps/web/app/(app)/trust-center/status/page.tsx:168` |
| HEADING | Components | `apps/web/app/(app)/trust-center/status/page.tsx:215` |
| HEADING | Active incidents · {status.activeIncidents.length} | `apps/web/app/(app)/trust-center/status/page.tsx:241` |
| HEADING | Resolved incidents · {status.recentIncidents.length} | `apps/web/app/(app)/trust-center/status/page.tsx:246` |
| HEADING | Maintenance windows · {status.maintenanceWindows.length} | `apps/web/app/(app)/trust-center/status/page.tsx:251` |
| LINK | Postmortem | `apps/web/app/(app)/trust-center/status/page.tsx:353` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| BUTTON | On this page | `apps/web/components/legal/LegalDocumentShell.tsx:372` |
| LINK | Open public Trust Center | `apps/web/components/legal/LegalDocumentShell.tsx:460` |

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

### C.4 SOURCE-UNRESOLVED labels (6)

| Role | PWA source | Why unpairable |
|---|---|---|
| BUTTON | `apps/web/app/(app)/trust-center/status/page.tsx:112` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/legal/LegalDocumentShell.tsx:280` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/legal/LegalDocumentShell.tsx:395` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (0 rules, 0 properties)

_no static classes on this route_


**Stock Tailwind utilities used (40).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.rounded-lg` → {"kind":"border-radius","value":"8px"}
- `.px-3` → {"kind":"padding","side":"x","value":"12px"}
- `.py-1.5` → {"kind":"padding","side":"y","value":"6px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.w-full` → {"kind":"layout","value":"w-full"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.py-10` → {"kind":"padding","side":"y","value":"40px"}
- `.mb-6` → {"kind":"margin","side":"b","value":"24px"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.flex-wrap` → {"kind":"layout","value":"flex-wrap"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.gap-2` → {"kind":"gap","value":"8px"}
- `.inline-flex` → {"kind":"layout","value":"inline-flex"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.py-1` → {"kind":"padding","side":"y","value":"4px"}
- `.mt-4` → {"kind":"margin","side":"t","value":"16px"}
- `.mt-3` → {"kind":"margin","side":"t","value":"12px"}
- `.gap-1.5` → {"kind":"gap","value":"6px"}
- `.mt-6` → {"kind":"margin","side":"t","value":"24px"}
- `.mt-7` → {"kind":"margin","side":"t","value":"28px"}
- `.rounded-[10px]` → {"kind":"border-radius"}
- `.px-3.5` → {"kind":"padding","side":"x","value":"14px"}
- `.py-2` → {"kind":"padding","side":"y","value":"8px"}
- `.mt-2` → {"kind":"margin","side":"t","value":"8px"}
- `.rounded-[12px]` → {"kind":"border-radius"}


### D.2 PWA SOURCE-UNRESOLVED (77)

- `border` at `apps/web/app/(app)/trust-center/status/page.tsx:112` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[#0F172A]` at `apps/web/app/(app)/trust-center/status/page.tsx:112` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[#0F172A]` at `apps/web/app/(app)/trust-center/status/page.tsx:112` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[12px]` at `apps/web/app/(app)/trust-center/status/page.tsx:112` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-white` at `apps/web/app/(app)/trust-center/status/page.tsx:112` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `hover:opacity-90` at `apps/web/app/(app)/trust-center/status/page.tsx:112` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `disabled:opacity-60` at `apps/web/app/(app)/trust-center/status/page.tsx:112` — no CSS rule in apps/web and not a recognised stock Tailwind utility
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
- `h-1.5` at `apps/web/components/legal/LegalDocumentShell.tsx:295` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `w-1.5` at `apps/web/components/legal/LegalDocumentShell.tsx:295` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[#F1F5F9]` at `apps/web/components/legal/LegalDocumentShell.tsx:303` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[0.08em]` at `apps/web/components/legal/LegalDocumentShell.tsx:303` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#0B1F4D]` at `apps/web/components/legal/LegalDocumentShell.tsx:303` — no CSS rule in apps/web and not a recognised stock Tailwind utility

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
| PWA files inspected (rendered tree) | 7 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 204 |
| Native elements identified | 77 |
| Pairable PWA elements | 20 |
| Paired | 0 |
| Missing in Native | 12 |
| Extra in Native | 13 |
| Unlabelled (not pairable by label) | 2 |
| SOURCE-UNRESOLVED labels | 6 |
| PWA style properties resolved | 0 |
| PWA style items SOURCE-UNRESOLVED | 77 |
| Native style properties resolved | 72 |
| PWA interactive elements | 11 |
| Native interactive elements | 11 |
| PWA conditional branches | 112 |
| Native conditional branches | 39 |
