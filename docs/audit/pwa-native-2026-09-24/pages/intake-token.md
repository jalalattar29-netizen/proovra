# /intake/[token]

**PWA entry:** `apps/web/app/intake/[token]/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/intake/[token].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 4 | 2 |
| Elements | 171 | 72 |
| Interactive elements | 12 | 16 |
| Conditionally-rendered elements | 99 | 42 |
| Style rules resolved | 126 (479 props) | 61 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/intake/[token]/page.tsx` | 133 | `(entry)` |
| 1 | `apps/web/components/intake/IntakeReReviewBanner.tsx` | 6 | `IntakeReReviewBanner` |
| 1 | `apps/web/components/intake/IntakeCompletionProgress.tsx` | 14 | `IntakeCompletionProgress` |
| 1 | `apps/web/components/intake/IntakeChecklist.tsx` | 18 | `IntakeChecklist` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/intake/[token].tsx` | 30 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraLoadingState,ProovraEmpty,ProovraCard,ProovraText,ProovraBadge,ProovraPageSection,ProovraFormField,ProovraInput,ProovraButton` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 1 | 1 | 0 |
| BUTTON | 6 | 8 | 2 |
| CARD | 1 | 4 | 3 |
| CONTAINER | 50 | 23 | -27 |
| HEADING | 10 | 0 | -10 |
| ICON | 10 | 0 | -10 |
| INPUT | 5 | 7 | 2 |
| LIST | 8 | 1 | -7 |
| OTHER | 12 | 5 | -7 |
| STATE_EMPTY | 0 | 1 | 1 |
| STATE_LOADING | 0 | 3 | 3 |
| TEXT | 68 | 19 | -49 |

### C.1 Paired (2)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | Not now | `apps/web/app/intake/[token]/page.tsx:1600` | `apps/mobile/app/(stack)/intake/[token].tsx:236` |
| INPUT | The name shown with your submission | `apps/web/app/intake/[token]/page.tsx:1174` | `apps/mobile/app/(stack)/intake/[token].tsx:191` |


### C.2 MISSING in Native (12)

| Role | Label | PWA source |
|---|---|---|
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/app/intake/[token]/page.tsx:81` |
| HEADING | This link can&apos;t be opened | `apps/web/app/intake/[token]/page.tsx:991` |
| HEADING | Submission completed | `apps/web/app/intake/[token]/page.tsx:1034` |
| HEADING | Already submitted | `apps/web/app/intake/[token]/page.tsx:1065` |
| HEADING | What happens with your files | `apps/web/app/intake/[token]/page.tsx:1149` |
| HEADING | The terms you are accepting | `apps/web/app/intake/[token]/page.tsx:1163` |
| HEADING | Your acknowledgement | `apps/web/app/intake/[token]/page.tsx:1200` |
| BUTTON | {identityBusy ? "Continuing…" : "Accept and continue"} | `apps/web/app/intake/[token]/page.tsx:1243` |
| HEADING | What this request needs | `apps/web/app/intake/[token]/page.tsx:1292` |
| HEADING | Files | `apps/web/app/intake/[token]/page.tsx:1296` |
| BUTTON | {phase === "submitting" ? "Submitting…" : "Submit evidence"} | `apps/web/app/intake/[token]/page.tsx:1519` |
| BUTTON | Share location | `apps/web/app/intake/[token]/page.tsx:1591` |

### C.3 EXTRA in Native (13)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Opening your link | `apps/mobile/app/(stack)/intake/[token].tsx:146` |
| STATE_EMPTY | This link is not open | `apps/mobile/app/(stack)/intake/[token].tsx:149` |
| BADGE | `Due ${formatUserDateTime(intake.request.dueAtIso)}` | `apps/mobile/app/(stack)/intake/[token].tsx:167` |
| INPUT | A name to be known by (optional) | `apps/mobile/app/(stack)/intake/[token].tsx:181` |
| INPUT | You can stay anonymous | `apps/mobile/app/(stack)/intake/[token].tsx:182` |
| INPUT | Your name | `apps/mobile/app/(stack)/intake/[token].tsx:192` |
| INPUT | Your email | `apps/mobile/app/(stack)/intake/[token].tsx:202` |
| INPUT | you@example.com | `apps/mobile/app/(stack)/intake/[token].tsx:203` |
| BUTTON | I understand — continue | `apps/mobile/app/(stack)/intake/[token].tsx:231` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (5)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/app/intake/[token]/page.tsx:1093` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/intake/[token]/page.tsx:1270` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/intake/[token]/page.tsx:1307` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/intake/[token]/page.tsx:1481` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/components/intake/IntakeChecklist.tsx:217` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (126 rules, 479 properties)

**`.ipk-brand`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-brand`

- `display`: **flex**
- `align-items`: **center**
- `gap`: **8px**
- `margin-bottom`: **18px**
- `font-size`: **12px**
- `font-weight`: **700**
- `letter-spacing`: **0.08em**
- `text-transform`: **uppercase**
- `color`: **var(--ipk-ink-secondary)**  ⚠ undeclared --ipk-ink-secondary

**`.ipk-brand__mark`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-brand__mark`

- `width`: **22px**
- `height`: **22px**
- `border-radius`: **7px**
- `display`: **grid**
- `place-items`: **center**
- `color`: **#fff**
- `background`: **linear-gradient(145deg, #7c3aed, #6d28d9)**
- `font-size`: **11px**
- `font-weight`: **800**
- `letter-spacing`: **0**

**`.ipk-support`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-support`

- `display`: **flex**
- `align-items`: **center**
- `gap`: **8px**
- `margin`: **9px 0 0**
- `font-size`: **11.5px**
- `color`: **var(--ipk-ink-muted)**  ⚠ undeclared --ipk-ink-muted

**`.ipk-support`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-support code`

- `font-family`: **ui-monospace, SFMono-Regular, Menlo, Consolas, monospace**
- `font-size`: **11px**
- `word-break`: **break-all**

**`.ipk-support`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-support button`

- `border`: **1px solid var(--ipk-line)**  ⚠ undeclared --ipk-line
- `background`: **rgba(255, 255, 255, 0.8)**
- `border-radius`: **6px**
- `padding`: **2px 7px**
- `font`: **inherit**
- `font-size`: **11px**
- `color`: **var(--ipk-ink-secondary)**  ⚠ undeclared --ipk-ink-secondary
- `cursor`: **pointer**
- `flex-shrink`: **0**

**`.ipk-support`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-support button:focus-visible`

- `outline`: **none**
- `box-shadow`: **0 0 0 3px rgba(124, 58, 237, 0.28)**

**`.ipk`** — `apps/web/app/intake/[token]/intake.css` · `.ipk`

- `--ipk-ink`: **#0F172A**  _(--ink-primary=#0F172A)_
- `--ipk-ink-secondary`: **#475569**  _(--ink-secondary=#475569)_
- `--ipk-ink-muted`: **#77808f**
- `--ipk-line`: **rgba(15, 23, 42, 0.1)**
- `--ipk-surface`: **rgba(255, 255, 255, 0.72)**
- `--ipk-accent`: **#6D28D9**  _(--accent-600=#6D28D9)_
- `max-width`: **660px**
- `margin`: **0 auto**
- `padding`: **clamp(20px, 5vw, 44px) clamp(16px, 4vw, 24px) 96px**
- `color`: **var(--ipk-ink)**  ⚠ undeclared --ipk-ink
- `font-family`: **inherit**

**`.ipk-skeleton`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-skeleton`

- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **12px**

**`.ipk-skeleton__bar`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-skeleton__bar`

- `height`: **14px**
- `border-radius`: **7px**
- `background`: **rgba(15, 23, 42, 0.06)**

**`.ipk-skeleton__bar--title`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-skeleton__bar--title`

- `height`: **26px**
- `width`: **62%**

**`.ipk-skeleton__bar--wide`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-skeleton__bar--wide`

- `width`: **100%**

**`.ipk-skeleton__bar--half`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-skeleton__bar--half`

- `width`: **48%**

**`.ipk-skeleton__block`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-skeleton__block`

- `height`: **108px**
- `border-radius`: **14px**
- `background`: **rgba(15, 23, 42, 0.05)**

**`.app-visually-hidden`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-visually-hidden`

- `position`: **absolute**
- `inline-size`: **1px**
- `block-size`: **1px**
- `margin`: **-1px**
- `padding`: **0**
- `overflow`: **hidden**
- `clip-path`: **inset(50%)**
- `white-space`: **nowrap**
- `border`: **0**

**`.ipk-outcome`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-outcome`

- `text-align`: **center**
- `padding`: **clamp(24px, 7vw, 44px) 0 8px**

**`.ipk-outcome__mark`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-outcome__mark`

- `width`: **54px**
- `height`: **54px**
- `margin`: **0 auto 16px**
- `border-radius`: **16px**
- `display`: **grid**
- `place-items`: **center**

**`.ipk-outcome__mark--stop`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-outcome__mark--stop`

- `background`: **#fff6e5**
- `color`: **#a86612**

**`.ipk-outcome__title`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-outcome__title`

- `margin`: **0 0 8px**
- `font-size`: **clamp(20px, 5vw, 24px)**
- `font-weight`: **720**
- `letter-spacing`: **-0.02em**

**`.ipk-outcome__body`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-outcome__body`

- `margin`: **0 auto 8px**
- `max-width`: **46ch**
- `font-size`: **14.5px**
- `line-height`: **1.6**
- `color`: **#334155**

**`.ipk-outcome__note`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-outcome__note`

- `margin`: **0 auto**
- `max-width`: **46ch**
- `font-size`: **13px**
- `line-height`: **1.55**
- `color`: **var(--ipk-ink-secondary)**  ⚠ undeclared --ipk-ink-secondary

**`.ipk-outcome__mark--ok`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-outcome__mark--ok`

- `background`: **#eaf7f1**
- `color`: **#167a5b**

**`.ipk-head`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-head`

- `margin-bottom`: **22px**

**`.ipk-eyebrow`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-eyebrow`

- `margin`: **0 0 6px**
- `font-size`: **12.5px**
- `font-weight`: **650**
- `color`: **var(--ipk-accent)**  ⚠ undeclared --ipk-accent

**`.ipk-title`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-title`

- `font-size`: **clamp(21px, 5.5vw, 27px)**
- `line-height`: **1.22**
- `font-weight`: **720**
- `letter-spacing`: **-0.02em**
- `margin`: **0 0 8px**
- `color`: **var(--ipk-ink)**  ⚠ undeclared --ipk-ink

**`.ipk-lede`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-lede`

- `margin`: **0 0 8px**
- `font-size`: **15px**
- `line-height`: **1.55**
- `color`: **#334155**

**`.ipk-meta`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-meta`

- `margin`: **0**
- `font-size`: **13px**
- `line-height`: **1.5**
- `color`: **var(--ipk-ink-secondary)**  ⚠ undeclared --ipk-ink-secondary

**`.ipk-notice__title`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-notice__title`

- `margin`: **0 0 3px**
- `font-size`: **14px**
- `font-weight`: **680**
- `color`: **var(--ipk-ink)**  ⚠ undeclared --ipk-ink

**`.ipk-notice__title`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-notice--denial .ipk-notice__title`

- `color`: **#7c4a0c**

**`.ipk-notice__title`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-notice--fault .ipk-notice__title`

- `color`: **#b23442**

**`.ipk-notice__body`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-notice__body`

- `margin`: **0**

**`.ipk-panel`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-panel`

- `border`: **1px solid var(--ipk-line)**  ⚠ undeclared --ipk-line
- `border-radius`: **14px**
- `background`: **var(--ipk-surface)**  ⚠ undeclared --ipk-surface
- `padding`: **clamp(14px, 3.5vw, 18px)**
- `margin-bottom`: **14px**

**`.ipk-panel--quiet`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-panel--quiet`

- `background`: **rgba(248, 250, 253, 0.7)**

**`.ipk-panel__title`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-panel__title`

- `margin`: **0 0 6px**
- `font-size`: **15px**
- `font-weight`: **680**
- `letter-spacing`: **-0.01em**
- `color`: **var(--ipk-ink)**  ⚠ undeclared --ipk-ink

**`.ipk-panel__body`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-panel__body`

- `margin`: **0**
- `font-size`: **14px**
- `line-height`: **1.6**
- `color`: **#334155**

**`.ipk-panel__body`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-panel__body + .ipk-panel__body`

- `margin-top`: **8px**

**`.ipk-muted`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-muted`

- `font-size`: **13px**
- `line-height`: **1.5**
- `color`: **var(--ipk-ink-secondary)**  ⚠ undeclared --ipk-ink-secondary

**`.ipk-section-title`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-section-title`

- `margin`: **22px 0 8px**
- `font-size`: **15px**
- `font-weight`: **680**
- `letter-spacing`: **-0.01em**
- `color`: **var(--ipk-ink)**  ⚠ undeclared --ipk-ink

**`.ipk-field`** — `apps/web/app/intake/[token]/intake.css` · `.ipk-field`

- `margin-top`: **14px**

**`.app-field-label`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-field-label`

- `display`: **block**
- `font-size`: **12.5px**
- `font-weight`: **600**
- `line-height`: **1.4**
- `color`: **#344054**  _(--app-ink-label=#344054)_
- `margin-bottom`: **6px**

**`.app-form-input`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-dialog-field .app-form-input`

- `box-sizing`: **border-box**
- `inline-size`: **100%**
- `min-inline-size`: **0**



### D.2 PWA SOURCE-UNRESOLVED (6)

- ``ipk-notice ${ errorIsDenial ? "ipk-notice--denial" : "ipk-notice--fault" }`` at `apps/web/app/intake/[token]/page.tsx:1116` — className built from a runtime expression
- `pseudonymError` at `apps/web/app/intake/[token]/page.tsx:1190` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `?` at `apps/web/app/intake/[token]/page.tsx:1190` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"app-field-error"` at `apps/web/app/intake/[token]/page.tsx:1190` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `:` at `apps/web/app/intake/[token]/page.tsx:1190` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"app-field-help"` at `apps/web/app/intake/[token]/page.tsx:1190` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (61 rules, 72 properties)

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
| PWA files inspected (rendered tree) | 4 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 171 |
| Native elements identified | 72 |
| Pairable PWA elements | 23 |
| Paired | 1 |
| Missing in Native | 12 |
| Extra in Native | 13 |
| Unlabelled (not pairable by label) | 4 |
| SOURCE-UNRESOLVED labels | 5 |
| PWA style properties resolved | 479 |
| PWA style items SOURCE-UNRESOLVED | 6 |
| Native style properties resolved | 72 |
| PWA interactive elements | 12 |
| Native interactive elements | 16 |
| PWA conditional branches | 99 |
| Native conditional branches | 42 |
