# PROOVRA Design System

**Status:** living document. It describes what the authenticated product ships
today. The code is the authority:

- `apps/web/lib/design-tokens/tokens.css`: every token.
- `apps/web/components/app-primitives/app-primitives.css`: the canonical
  `app-*` components, and the semantic colour contract at the top of that file.
- `apps/web/components/app-primitives/` and `apps/web/components/ui/`: the React
  primitives.

**Open founder question (audit finding RT-014).** Earlier versions of this
document specified velvet chrome and teal focus. The product no longer ships
that. Whether the shipped indigo and lavender palette is the approved palette
has not been recorded as a decision. This document states what is shipped and
does not settle that question.

**Audience:** product engineers and designers shipping new screens or
consolidating existing ones.

---

## 1. Shipped palette

### 1.1 Shell

The sidebar is a light branded artwork rail on a pink-to-orange gradient, and
the content plane sits on the light `app-shell-bg` artwork. Neither is dark.
Surfaces written for the retired dark shell were near-white ink on translucent
white, and are unreadable here, so no authenticated page should carry them.

### 1.2 Accent

| Token | Hex | Use |
| --- | --- | --- |
| `--accent-050` | `#F2ECFE` | Selected and active backgrounds |
| `--accent-200` | `#D9C7FB` | Hover and selected borders |
| `--accent-500` | `#7C3AED` | Primary action, brand accent |
| `--accent-600` | `#6D28D9` | Primary action gradient end, active text |

The focus ring is lavender: `outline: 2px solid #8b7cf6` from the global rule
in `globals.css`, which also covers an open listbox popup, or the `--focus-ring`
shadow on `app-*` controls. Never remove focus without replacing it.

### 1.3 Surfaces and ink

| Token | Value | Use |
| --- | --- | --- |
| `--surface-card` | white (92% inside the content area) | Cards and panels |
| `--surface-muted` | `#F1F4F9` | Muted fills |
| `--border-subtle` / `-default` / `-strong` | slate at 6% / 9% / 14% | Borders |
| `--app-ink-heading` | `#172033` | Titles, primary cell text |
| `--app-ink-label` | `#344054` | Labels, column headings |
| `--app-ink-control` | `#263247` | Control values |
| `--app-ink-secondary` | `#667085` | Descriptions, metadata |
| `--app-ink-placeholder` | `#98A2B3` | Placeholder and disabled text only |

The browser chrome colour (`<meta name="theme-color">` in `app/layout.tsx` and `theme_color` in `public/manifest.webmanifest`) is `#FFFFFF`, the card surface, on every page and in the installed app alike (MOBILE-014).

---

## 2. Semantic colour contract

Declared at the top of `app-primitives.css`. A tone is the only colour input to
`AppStatusBadge`.

| Meaning | Ink | Fill |
| --- | --- | --- |
| Healthy, active, completed | `#167A5B` | `#EAF7F1` |
| Pending, warning, on hold | `#A86612` | `#FFF6E5` |
| Destructive, failed | `#C9363E` | `#FFF1F2` |
| Selection, active tab, primary | `#6D28D9` | `#F2ECFE` |
| Neutral, closed, inactive | `#475569` | `#F1F5F9` |

The yellow attention treatment is `.app-alert--warn`. Red is for a failure, not
for something that merely needs attention.

`apps/web/components/operational/tokens.ts` (`OPS_TONES`) carries the same
intent for inline-style callers on operational surfaces.

---

## 3. Spacing scale

See the SPACING block in `tokens.css`, which is authoritative. The ladder as
originally named:

| Token | Value | Use |
| --- | --- | --- |
| `--space-2xs` | `4px` | Tight inline gap |
| `--space-xs` | `6px` | Tight padding |
| `--space-sm` | `8px` | Compact spacing |
| `--space-md` | `12px` | Standard spacing |
| `--space-lg` | `16px` | Section padding |
| `--space-xl` | `24px` | Card padding |
| `--space-2xl` | `32px` | Page padding |

---

## 4. Border radius

| Token | Value | Use |
| --- | --- | --- |
| `--radius-sm` | `6px` | Inline chips, small inputs |
| `--radius-md` | `8px` | Buttons, table cells |
| `--radius-lg` | `12px` | Inner surfaces |
| `--radius-card` | `14px` | Cards |
| `--radius-pill` | `999px` | Pills, avatars |

---

## 5. Typography

`--font-sans` (Plus Jakarta Sans, Noto Sans Arabic in RTL) is the application
family. Operational text is upright: italics are not used. Page titles come
from `PageHeader` (`--page-h1-size`, 22px by default).

---

## 6. Component patterns

| Need | Use |
| --- | --- |
| Page frame and header | `PageShell`, `PageHeader` from `components/ui/PageShell` |
| Panel | `.app-panel`, `Card` from `components/ui/Card` |
| Nested surface | `.app-inner-surface` |
| Primary action | `.app-primary-action`, or `Button variant="primary"` |
| Secondary action | `.app-secondary-action`, or `Button variant="secondary"` |
| Neutral solid secondary | `.app-secondary-action--filled`, for the leading control of a pair |
| Dropdown | `AppListbox` (see below) |
| Text field | `.app-form-input`, or `.app-input` |
| Checkbox | `.app-checkbox` |
| Tabs | `.app-tabs`, `.app-tab`; add `.app-tabs--wrap` for more tabs than a row holds |
| Status | `AppStatusBadge` |
| Alert | `.app-alert`, with `--warn`, `--danger` or `--ok` |
| Row metric | `.app-kpi-card` |

`Button`, `Card` and `EmptyState` from the `components/ui` barrel are the LEGACY
versions. Deep-import `components/ui/Button` and its neighbours.

### 6.1 Dropdowns

`AppListbox` is the dropdown for authenticated surfaces. It renders a button and
a portaled list, so it has no `name` and submits nothing with a form: a call site
must be controlled. It supports disabled options, an empty-string option,
`disabledReason`, and `triggerProps` for a description and `data-*` hooks. It does
not support `<optgroup>` or multiple selection. A native `<select>` that remains
should use `.app-form-input`.

### 6.2 The `.cc-*` names

Workspace Administration, the Governance Control Plane and the organization
administration header render `.cc-*` classes. They are defined in
`command-center.css` as aliases of the `app-*` values. New work uses `app-*`.

### 6.3 Customer language

Customers do not see enum names, role codes, API paths, table names or roadmap
phases. Show a raw code through `humaniseCode` (`lib/ots-presentation`), or a
proper label where one exists. Exact technical detail can stay in a tooltip that
a person opens on purpose.

---

## 7. Architecture

### 7.1 What's in use

Vanilla CSS, with `globals.css` importing the token file and the shell, primitive
and experience stylesheets, plus Tailwind utilities on the public marketing
pages. Inline style objects remain on older operational pages and should consume
tokens rather than literals.

### 7.2 Rules

- Consume tokens. A value that is wrong is changed in `tokens.css`.
- Fix a shared defect in the shared primitive, not with a page override.
- Do not add a second design module. `components/marketing/tokens.ts` is the one
  separate set, and it belongs to public pages only.

---

## 8. Reference

- Global CSS: [apps/web/app/globals.css](../../apps/web/app/globals.css)
- Primitives: [apps/web/components/app-primitives/app-primitives.css](../../apps/web/components/app-primitives/app-primitives.css)
- Tokens: [apps/web/lib/design-tokens/tokens.css](../../apps/web/lib/design-tokens/tokens.css)
- App shell CSS: [apps/web/components/app-shell-v2/app-shell-v2.css](../../apps/web/components/app-shell-v2/app-shell-v2.css)
- Operational tokens: [apps/web/components/operational/tokens.ts](../../apps/web/components/operational/tokens.ts)
- Reviewer-ops tokens: [apps/web/app/(app)/reviewer-ops/ui-tokens.ts](../../apps/web/app/%28app%29/reviewer-ops/ui-tokens.ts)
- Identity tokens: [apps/web/app/(app)/admin/identity/ui-tokens.ts](../../apps/web/app/%28app%29/admin/identity/ui-tokens.ts)
