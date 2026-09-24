# /share/[id]

**PWA entry:** `apps/web/app/share/[id]/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/evidence/[id].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 9 | 5 |
| Elements | 171 | 291 |
| Interactive elements | 37 | 72 |
| Conditionally-rendered elements | 58 | 205 |
| Style rules resolved | 19 (87 props) | 101 (99 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/share/[id]/page.tsx` | 33 | `(entry)` |
| 1 | `apps/web/components/marketing/MarketingHeader.tsx` | 47 | `MarketingHeader` |
| 2 | `apps/web/components/analytics/PublicPageView.tsx` | 0 | `PublicPageView` |
| 2 | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx` | 8 | `MarketingLanguageSwitcher` |
| 1 | `apps/web/components/ui-legacy.tsx` | 27 | `Card` |
| 2 | `apps/web/components/feedback/ProovraToast.tsx` | 13 | `ProovraToast` |
| 3 | `apps/web/components/feedback/severity.tsx` | 13 | `FeedbackIcon` |
| 3 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/marketing/EnterpriseFooter.tsx` | 26 | `EnterpriseFooter` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/evidence/[id].tsx` | 148 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraLoadingState,ProovraEmptyState,ProovraButton,ProovraErrorState,ProovraCard,ProovraBadge,ProovraText,ProovraSheet,ProovraFormField,ProovraInput,ProovraListRow,ProovraSection,ProovraConfirmSheet,ProovraFilterChips` |
| 1 | `apps/mobile/src/ui/reviewer-workflow-panel.tsx` | 35 | `ReviewerWorkflowPanel` |
| 1 | `apps/mobile/src/ui/evidence-internal-materials.tsx` | 38 | `EvidenceInternalMaterials` |
| 1 | `apps/mobile/src/ui/derived-review-tab.tsx` | 28 | `DerivedReviewTab` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 12 | 12 |
| BUTTON | 11 | 34 | 23 |
| CARD | 1 | 26 | 25 |
| CONTAINER | 64 | 41 | -23 |
| DIALOG | 0 | 8 | 8 |
| HEADING | 4 | 0 | -4 |
| ICON | 18 | 0 | -18 |
| IMAGE | 5 | 0 | -5 |
| INPUT | 2 | 13 | 11 |
| LINK | 19 | 0 | -19 |
| LIST | 6 | 14 | 8 |
| OTHER | 20 | 46 | 26 |
| STATE_EMPTY | 0 | 15 | 15 |
| STATE_ERROR | 0 | 3 | 3 |
| STATE_LOADING | 0 | 10 | 10 |
| TAB | 0 | 1 | 1 |
| TEXT | 21 | 68 | 47 |

### C.1 Paired (1)

| Role | Label | PWA | Native |
|---|---|---|---|
| LINK → BUTTON ⚠ | label | `apps/web/components/marketing/EnterpriseFooter.tsx:140` | `apps/mobile/src/ui/index.tsx:259` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (15)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Share Link Page Not Active | `apps/web/app/share/[id]/page.tsx:45` |
| LINK | MARKETING_COPY.brandName | `apps/web/components/marketing/MarketingHeader.tsx:249` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:367` |
| BUTTON | Open menu | `apps/web/components/marketing/MarketingHeader.tsx:376` |
| BUTTON | Close menu | `apps/web/components/marketing/MarketingHeader.tsx:401` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:466` |
| BUTTON | Language | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx:81` |
| INPUT | {error && <div className="input-error">{error}</div>} | `apps/web/components/ui-legacy.tsx:293` |
| BUTTON | Dismiss notification | `apps/web/components/feedback/ProovraToast.tsx:119` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| LINK | MARKETING_COPY.brandName | `apps/web/components/marketing/EnterpriseFooter.tsx:111` |
| LINK | Privacy Policy | `apps/web/components/marketing/EnterpriseFooter.tsx:180` |
| LINK | Terms of Service | `apps/web/components/marketing/EnterpriseFooter.tsx:183` |
| LINK | Security | `apps/web/components/marketing/EnterpriseFooter.tsx:186` |
| LINK | Trust Center | `apps/web/components/marketing/EnterpriseFooter.tsx:189` |

### C.3 EXTRA in Native (74)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Loading record | `apps/mobile/app/(stack)/evidence/[id].tsx:607` |
| STATE_EMPTY | Record not found | `apps/mobile/app/(stack)/evidence/[id].tsx:614` |
| BUTTON | Back | `apps/mobile/app/(stack)/evidence/[id].tsx:614` |
| BUTTON | Back | `apps/mobile/app/(stack)/evidence/[id].tsx:662` |
| BADGE | c.verificationStatusLabel?.trim() \|\| verificationStatusDisplay(c.verificationStatus).label | `apps/mobile/app/(stack)/evidence/[id].tsx:669` |
| BUTTON | Rename record | `apps/mobile/app/(stack)/evidence/[id].tsx:678` |
| INPUT | Record name | `apps/mobile/app/(stack)/evidence/[id].tsx:711` |
| INPUT | `Up to ${EVIDENCE_LABEL_MAX} characters` | `apps/mobile/app/(stack)/evidence/[id].tsx:712` |
| BUTTON | Save name | `apps/mobile/app/(stack)/evidence/[id].tsx:723` |
| INPUT | Note (optional) | `apps/mobile/app/(stack)/evidence/[id].tsx:744` |
| INPUT | Why these two records go together | `apps/mobile/app/(stack)/evidence/[id].tsx:745` |
| STATE_LOADING | Loading records | `apps/mobile/app/(stack)/evidence/[id].tsx:755` |
| STATE_EMPTY | Nothing to link | `apps/mobile/app/(stack)/evidence/[id].tsx:757` |
| BADGE | Selected | `apps/mobile/app/(stack)/evidence/[id].tsx:770` |
| BUTTON | Unlock | `apps/mobile/app/(stack)/evidence/[id].tsx:849` |
| BUTTON | Lock | `apps/mobile/app/(stack)/evidence/[id].tsx:851` |
| BUTTON | Archive | `apps/mobile/app/(stack)/evidence/[id].tsx:854` |
| BUTTON | Restore from archive | `apps/mobile/app/(stack)/evidence/[id].tsx:857` |
| BUTTON | Open original file | `apps/mobile/app/(stack)/evidence/[id].tsx:869` |
| BADGE | cert.revoked ? "Revoked" : humanizeEnum(cert.status) | `apps/mobile/app/(stack)/evidence/[id].tsx:931` |
| BUTTON | Share verification link | `apps/mobile/app/(stack)/evidence/[id].tsx:940` |
| STATE_EMPTY | No custody events yet | `apps/mobile/app/(stack)/evidence/[id].tsx:948` |
| BADGE | ev.category === "forensic" ? "Forensic" : "Access" | `apps/mobile/app/(stack)/evidence/[id].tsx:956` |
| STATE_EMPTY | No technical metadata | `apps/mobile/app/(stack)/evidence/[id].tsx:967` |
| STATE_EMPTY | No linked evidence | `apps/mobile/app/(stack)/evidence/[id].tsx:999` |
| BADGE | evidenceStatusDisplay(rel.linkedStatus).label | `apps/mobile/app/(stack)/evidence/[id].tsx:1015` |
| BUTTON | Link another record | `apps/mobile/app/(stack)/evidence/[id].tsx:1041` |
| BUTTON | Download report | `apps/mobile/app/(stack)/evidence/[id].tsx:1062` |
| STATE_LOADING | Checking accessible records | `apps/mobile/app/(stack)/evidence/[id].tsx:1120` |
| BUTTON | Open file | `apps/mobile/app/(stack)/evidence/[id].tsx:1211` |
| STATE_LOADING | Loading comments | `apps/mobile/app/(stack)/evidence/[id].tsx:1237` |
| INPUT | Add a comment | `apps/mobile/app/(stack)/evidence/[id].tsx:1265` |
| INPUT | What should a reviewer know? | `apps/mobile/app/(stack)/evidence/[id].tsx:1266` |
| BUTTON | Post comment | `apps/mobile/app/(stack)/evidence/[id].tsx:1284` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |
| STATE_LOADING | Loading review state | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:146` |
| STATE_EMPTY | The review state could not be loaded. | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:152` |
| BUTTON | Try again | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:157` |
| STATE_EMPTY | This record has no review yet. | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:178` |
| BUTTON | Start a review | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:183` |
| BADGE | workflowStatusLabel(current.status) | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:201` |
| BADGE | workflowPriorityLabel(current.priority) | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:205` |
| STATE_EMPTY | The review history could not be loaded. | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:238` |
| BUTTON | Try again | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:243` |
| STATE_EMPTY | Nothing has happened to this review yet. | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:252` |
| DIALOG | Update review state | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:271` |
| INPUT | Note (optional) | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:286` |
| INPUT | `Up to ${WORKFLOW_NOTE_MAX} characters` | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:287` |
| BUTTON | Save | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:296` |
| STATE_EMPTY | Legal notes could not be loaded. | `apps/mobile/src/ui/evidence-internal-materials.tsx:210` |
| BUTTON | Try again | `apps/mobile/src/ui/evidence-internal-materials.tsx:215` |
| INPUT | Note | `apps/mobile/src/ui/evidence-internal-materials.tsx:231` |
| INPUT | `Up to ${LEGAL_NOTE_MAX} characters` | `apps/mobile/src/ui/evidence-internal-materials.tsx:232` |
| BUTTON | Add legal note | `apps/mobile/src/ui/evidence-internal-materials.tsx:241` |
| STATE_EMPTY | No legal notes on this record. | `apps/mobile/src/ui/evidence-internal-materials.tsx:250` |
| BADGE | legalNoteTypeLabel(n.noteType) | `apps/mobile/src/ui/evidence-internal-materials.tsx:267` |
| BUTTON | Delete | `apps/mobile/src/ui/evidence-internal-materials.tsx:271` |
| STATE_EMPTY | Annotations could not be loaded. | `apps/mobile/src/ui/evidence-internal-materials.tsx:302` |
| BUTTON | Try again | `apps/mobile/src/ui/evidence-internal-materials.tsx:307` |
| INPUT | Annotation | `apps/mobile/src/ui/evidence-internal-materials.tsx:318` |
| INPUT | `Up to ${ANNOTATION_BODY_MAX} characters` | `apps/mobile/src/ui/evidence-internal-materials.tsx:319` |
| BUTTON | Add annotation | `apps/mobile/src/ui/evidence-internal-materials.tsx:337` |
| STATE_EMPTY | No annotations on this record. | `apps/mobile/src/ui/evidence-internal-materials.tsx:346` |
| BADGE | annotationTypeLabel(a.annotationType) | `apps/mobile/src/ui/evidence-internal-materials.tsx:359` |
| BUTTON | Delete | `apps/mobile/src/ui/evidence-internal-materials.tsx:360` |
| STATE_LOADING | Loading internal materials | `apps/mobile/src/ui/evidence-internal-materials.tsx:386` |
| STATE_LOADING | Resolving workspace | `apps/mobile/src/ui/derived-review-tab.tsx:108` |
| STATE_LOADING | Derived review | `apps/mobile/src/ui/derived-review-tab.tsx:109` |
| BADGE | runStatusLabel(run) | `apps/mobile/src/ui/derived-review-tab.tsx:143` |
| STATE_EMPTY | Nothing has been reconstructed yet. | `apps/mobile/src/ui/derived-review-tab.tsx:162` |
| STATE_EMPTY | No text was reconstructed from this recording. | `apps/mobile/src/ui/derived-review-tab.tsx:197` |
| BADGE | confidenceLabel(block.confidence) | `apps/mobile/src/ui/derived-review-tab.tsx:217` |

### C.4 SOURCE-UNRESOLVED labels (17)

| Role | PWA source | Why unpairable |
|---|---|---|
| BUTTON | `apps/web/components/marketing/MarketingHeader.tsx:275` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:309` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:344` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:359` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:419` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:436` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:459` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:163` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:209` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:263` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:266` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/ui-legacy.tsx:360` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraToast.tsx:100` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraToast.tsx:104` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/EnterpriseFooter.tsx:128` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/marketing/EnterpriseFooter.tsx:157` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/EnterpriseFooter.tsx:163` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (19 rules, 87 properties)

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

**`.toast-container`** — `apps/web/app/globals.css` · `.toast-container`

- `position`: **fixed**
- `top`: **20px**
- `right`: **20px**
- `z-index`: **9999**
- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **10px**
- `width`: **380px**
- `max-width`: **calc(100vw - 40px)**
- `pointer-events`: **none**

**`.toast-container`** — `apps/web/app/globals.css` · `.toast-container > *`

- `animation`: **pf-toast-in 0.28s cubic-bezier(0.16, 1, 0.3, 1)**

**`.modal-overlay`** — `apps/web/app/globals.css` · `.modal-overlay`

- `position`: **fixed**
- `inset`: **0**
- `background`: **rgba(0, 0, 0, 0.7)**
- `z-index`: **9998**
- `animation`: **fadeIn 0.2s ease-out**
- `backdrop-filter`: **blur(2px)**

**`.modal-content`** — `apps/web/app/globals.css` · `.modal-content`

- `position`: **fixed**
- `top`: **50%**
- `left`: **50%**
- `transform`: **translate(-50%, -50%)**
- `background`: **linear-gradient(135deg, #102126 0%, #1b3136 100%)**
- `border`: **1px solid rgba(158, 216, 207, 0.2)**
- `border-radius`: **12px**
- `box-shadow`: **0 0 30px rgba(158, 216, 207, 0.1), 0 20px 60px rgba(0, 0, 0, 0.4)**
- `z-index`: **9999**
- `max-width`: **500px**
- `width`: **90%**
- `max-height`: **90vh**
- `overflow-y`: **auto**
- `animation`: **slideUp 0.3s ease-out**

**`.modal-header`** — `apps/web/app/globals.css` · `.modal-header`

- `padding`: **24px**

**`.modal-header`** — `apps/web/app/globals.css` · `.modal-header h2`

- `margin`: **0**
- `font-size`: **20px**
- `font-weight`: **600**
- `color`: **#e2e8f0**

**`.modal-close`** — `apps/web/app/globals.css` · `.modal-close`

- `border`: **0**
- `background`: **transparent**
- `color`: **#e2e8f0**
- `font-size`: **24px**
- `line-height`: **1**
- `cursor`: **pointer**

**`.modal-body`** — `apps/web/app/globals.css` · `.modal-body`

- `padding`: **24px**

**`.modal-footer`** — `apps/web/app/globals.css` · `.modal-footer`

- `padding`: **24px**

**`.skeleton`** — `apps/web/app/globals.css` · `.skeleton`

- `background-color`: **#e2e8f0**
- `border-radius`: **8px**
- `animation`: **pulse 1.6s ease-in-out infinite**

**`.empty-state-container`** — `apps/web/app/globals.css` · `.empty-state-container`

- `display`: **flex**
- `flex-direction`: **column**
- `align-items`: **center**
- `justify-content`: **center**
- `padding`: **60px 24px**
- `text-align`: **center**
- `gap`: **16px**

**`.empty-state-icon`** — `apps/web/app/globals.css` · `.empty-state-icon`

- `width`: **64px**
- `height`: **64px**
- `background`: **#f0f4f8**
- `border-radius`: **12px**
- `display`: **flex**
- `align-items`: **center**
- `justify-content`: **center**
- `color`: **#64748b**
- `font-size`: **32px**

**`.empty-state-title`** — `apps/web/app/globals.css` · `.empty-state-title`

- `margin`: **0**
- `font-size`: **18px**
- `font-weight`: **600**
- `color`: **#0f1d36**

**`.empty-state-subtitle`** — `apps/web/app/globals.css` · `.empty-state-subtitle`

- `margin`: **0**
- `color`: **#64748b**
- `font-size`: **14px**

**`.empty-state-button`** — `apps/web/app/globals.css` · `.empty-state-button`

- `margin-top`: **8px**

**`.input-error`** — `apps/web/app/globals.css` · `.input-error`

- `color`: **#d64545**
- `font-size`: **12px**
- `margin-top`: **4px**

**`.select-label`** — `apps/web/app/globals.css` · `.select-label`

- `display`: **block**
- `margin-bottom`: **6px**
- `font-size`: **14px**
- `font-weight`: **500**
- `color`: **#0f1d36**


**Stock Tailwind utilities used (69).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.relative` → {"kind":"layout","value":"relative"}
- `.overflow-hidden` → {"kind":"layout","value":"overflow-hidden"}
- `.absolute` → {"kind":"layout","value":"absolute"}
- `.h-full` → {"kind":"layout","value":"h-full"}
- `.w-full` → {"kind":"layout","value":"w-full"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.flex-col` → {"kind":"layout","value":"flex-col"}
- `.flex-1` → {"kind":"layout","value":"flex-1"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.justify-center` → {"kind":"layout","value":"justify-center"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.py-10` → {"kind":"padding","side":"y","value":"40px"}
- `.rounded-[30px]` → {"kind":"border-radius"}
- `.p-0` → {"kind":"padding","side":"all","value":"0px"}
- `.px-7` → {"kind":"padding","side":"x","value":"28px"}
- `.py-8` → {"kind":"padding","side":"y","value":"32px"}
- `.mb-5` → {"kind":"margin","side":"b","value":"20px"}
- `.gap-4` → {"kind":"gap","value":"16px"}
- `.m-0` → {"kind":"margin","side":"all","value":"0px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.mt-2` → {"kind":"margin","side":"t","value":"8px"}
- `.mb-0` → {"kind":"margin","side":"b","value":"0px"}
- `.rounded-[18px]` → {"kind":"border-radius"}
- `.p-4` → {"kind":"padding","side":"all","value":"16px"}
- `.pl-5` → {"kind":"padding","side":"l","value":"20px"}


### D.2 PWA SOURCE-UNRESOLVED (139)

- `landing-page` at `apps/web/app/share/[id]/page.tsx:12` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `min-h-screen` at `apps/web/app/share/[id]/page.tsx:13` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `inset-0` at `apps/web/app/share/[id]/page.tsx:14` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-cover` at `apps/web/app/share/[id]/page.tsx:15` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-center` at `apps/web/app/share/[id]/page.tsx:15` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.74)_34%,rgba(8,18,22,0.68)_100%)]` at `apps/web/app/share/[id]/page.tsx:22` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[radial-gradient(circle_at_16%_14%,rgba(158,216,207,0.08),transparent_24%)]` at `apps/web/app/share/[id]/page.tsx:23` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[radial-gradient(circle_at_84%_22%,rgba(214,184,157,0.06),transparent_18%)]` at `apps/web/app/share/[id]/page.tsx:24` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `opacity-[0.035]` at `apps/web/app/share/[id]/page.tsx:25` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `[background:repeating-linear-gradient(0deg,rgba(255,255,255,0.022)_0px,rgba(255,255,255,0.022)_1px,transparent_1px,transparent_4px)]` at `apps/web/app/share/[id]/page.tsx:25` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-10` at `apps/web/app/share/[id]/page.tsx:27` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:px-8` at `apps/web/app/share/[id]/page.tsx:30` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:py-14` at `apps/web/app/share/[id]/page.tsx:30` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[760px]` at `apps/web/app/share/[id]/page.tsx:31` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border` at `apps/web/app/share/[id]/page.tsx:32` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[rgba(79,112,107,0.22)]` at `apps/web/app/share/[id]/page.tsx:32` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-transparent` at `apps/web/app/share/[id]/page.tsx:32` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `shadow-[0_30px_80px_rgba(0,0,0,0.18)]` at `apps/web/app/share/[id]/page.tsx:32` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]` at `apps/web/app/share/[id]/page.tsx:38` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]` at `apps/web/app/share/[id]/page.tsx:39` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:py-9` at `apps/web/app/share/[id]/page.tsx:41` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[2rem]` at `apps/web/app/share/[id]/page.tsx:43` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `leading-none` at `apps/web/app/share/[id]/page.tsx:43` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#9b826b]` at `apps/web/app/share/[id]/page.tsx:43` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[1.55rem]` at `apps/web/app/share/[id]/page.tsx:45` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[-0.03em]` at `apps/web/app/share/[id]/page.tsx:45` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#1d3136]` at `apps/web/app/share/[id]/page.tsx:45` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[0.96rem]` at `apps/web/app/share/[id]/page.tsx:48` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `leading-[1.8]` at `apps/web/app/share/[id]/page.tsx:48` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#55666a]` at `apps/web/app/share/[id]/page.tsx:48` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (101 rules, 99 properties)

**`headerRow`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `flexDirection`: **row**
- `marginTop`: **8**  _(theme.space.s2)_

**`hero`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `marginBottom`: **16**  _(theme.space.s4)_

**`badgeRow`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_

**`heroTitle`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `marginTop`: **8**  _(theme.space.s2)_

**`tabs`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **16**  _(theme.space.s4)_

**`tab`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `paddingVertical`: **8**  _(theme.space.s2)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `minHeight`: **36**
- `justifyContent`: **center**

**`detailRow`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `paddingVertical`: **8**  _(theme.space.s2)_
- `borderTopWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderTopColor`: **rgba(15, 23, 42, 0.06)**  _(theme.color.border.subtle)_
- `gap`: **2**

**`detailValue`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `marginTop`: **2**

**`actions`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `marginTop`: **16**  _(theme.space.s4)_
- `gap`: **8**  _(theme.space.s2)_

**`note`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `marginTop`: **12**  _(theme.space.s3)_

**`stackCard`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `marginTop`: **12**  _(theme.space.s3)_
- `gap`: **4**  _(theme.space.s1)_

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
| Native files inspected (rendered tree) | 5 |
| PWA elements identified | 171 |
| Native elements identified | 291 |
| Pairable PWA elements | 42 |
| Paired | 0 |
| Missing in Native | 15 |
| Extra in Native | 74 |
| Unlabelled (not pairable by label) | 9 |
| SOURCE-UNRESOLVED labels | 17 |
| PWA style properties resolved | 87 |
| PWA style items SOURCE-UNRESOLVED | 139 |
| Native style properties resolved | 99 |
| PWA interactive elements | 37 |
| Native interactive elements | 72 |
| PWA conditional branches | 58 |
| Native conditional branches | 205 |
