# PROOVRA Design System (Phase G5.3)

**Status:** living document. Defines the canonical design tokens, component
patterns, and brand-identity rules for PROOVRA's operator surfaces.

**Audience:** product engineers and designers shipping new screens or
consolidating existing ones.

**Scope:** documenting what already exists + naming the bounded consolidation
opportunities. This document does NOT redesign any flow.

---

## 1. Brand identity (non-negotiable)

PROOVRA is an evidence operations platform with legal-grade seriousness. The
brand identity is **deliberately restrained** — no playful gradients, no
candy colors, no kanban/CRM look. Three palette layers are canonical:

### 1.1 Velvet — the dark operational chrome

Used in: app shell topbar, sidebar, modal overlays, premium button gradients.

| Token | Hex | Use |
| --- | --- | --- |
| `--velvet-950` | `#081318` | Deepest background (modal scrim) |
| `--velvet-900` | `#102126` | Topbar / sidebar background |
| `--velvet-850` | `#14282e` | Hover / pressed background in dark chrome |
| `--velvet-800` | `#1b3136` | Card / panel background in dark chrome |
| `--velvet-700` | `#284348` | Subtle border in dark chrome |

### 1.2 Teal — the operational accent

Used in: primary buttons, focus rings, active nav indicators, link tone.

| Token | Hex | Use |
| --- | --- | --- |
| `--teal-700` | `#3a5d61` | Primary action background |
| `--teal-300` | `#9ed8cf` | Hover highlight / focus ring |
| `--capture-teal` (page-scoped) | `#0f5c56` | Capture-flow accent — page-scoped variant |

### 1.3 Bronze — the warm accent

Used in: footer, secondary buttons, hover states, governance badge borders.

| Token | Hex | Use |
| --- | --- | --- |
| `--bronze-soft` | `#b79d84` | Subtle bronze tint |
| `--bronze-soft-2` | `#d6b89d` | Brighter bronze tint |
| `--bronze-border` | `rgba(183, 157, 132, 0.28)` | Bronze hover border |

### 1.4 Operational surfaces

White and soft-gray surfaces for the bulk of operational UI (evidence list,
matter workspace, reviewer console, reports).

| Token | Hex | Use |
| --- | --- | --- |
| `--surface` | `#ffffff` | Card / panel background |
| `--surface-soft` | `#f5f6f4` | Subtle background contrast |
| `--page-bg` | `#f3f4f1` | Page-level background |
| `--silver-100` | `#f4f5f2` | Subtle row stripe |
| `--silver-200` | `#eceeea` | Border, low-contrast separator |
| `--silver-300` | `#e1e4e1` | Border, medium contrast |

---

## 2. Operational palette (slate + status)

The non-brand operational palette uses the slate spectrum (Tailwind-style)
and four bounded status families: success, warning, danger, info.

### 2.1 Slate (text, borders, muted surfaces)

| Hex | Use | Approx. usage count today |
| --- | --- | --- |
| `#0f172a` | Default ink | ~170 |
| `#475569` | Muted ink | ~140 |
| `#64748b` | Subtle ink | ~120 |
| `#cbd5e1` | Strong border | ~140 |
| `#e2e8f0` | Border | ~130 |
| `#f1f5f9` | Muted surface | ~135 |
| `#f8fafc` | Soft surface | scattered |

### 2.2 Status palettes (canonical)

Used in: badges, banners, alerts, lifecycle indicators.

| Status | Background | Foreground | Border | Semantic |
| --- | --- | --- | --- | --- |
| Success / healthy | `#ecfdf5` | `#166534` | `#bbf7d0` | Verified, anchored, available, ready |
| Warning / processing | `#fef3c7` | `#78350f` | `#fcd34d` | Pending, generating, due-soon |
| Danger / critical | `#fef2f2` | `#7f1d1d` | `#fecaca` | Failed, blocked, breached |
| Info / neutral | `#eff6ff` | `#1e40af` | `#bfdbfe` | Informational, in-progress |

### 2.3 Severity tones (Operational Tones)

For Phase G2's operational status surfaces, the canonical severity palette is
declared in `apps/web/components/operational/tokens.ts` as `OPS_TONES`:

`neutral · info · healthy · warning · degraded · high · critical · unknown`

This is the authoritative severity-tone map for runtime-status banners,
governance signals, SLA badges, and incident chips.

---

## 3. Spacing scale (recommended)

The codebase currently uses a small set of recurring values. The canonical
ladder is:

| Token | Value | Use |
| --- | --- | --- |
| `--space-2xs` | `4px` | Tight inline gap |
| `--space-xs` | `6px` | Tight padding |
| `--space-sm` | `8px` | Compact spacing |
| `--space-md` | `12px` | Standard spacing |
| `--space-lg` | `16px` | Section padding |
| `--space-xl` | `24px` | Card padding |
| `--space-2xl` | `32px` | Page padding |

**Status today:** hardcoded literals (134 × `10px`, 110 × `12px`, 101 × `8px`,
87 × `14px`, 73 × `18px`, 70 × `16px`). Consolidation candidate: future PR
introduces these as CSS variables in `apps/web/app/globals.css` and migrates
the highest-traffic files.

---

## 4. Border-radius scale (recommended)

| Token | Value | Use |
| --- | --- | --- |
| `--radius-sm` | `4px` | Inline chips, small inputs |
| `--radius-md` | `6px` | Buttons, table cells |
| `--radius-lg` | `8px` | Cards |
| `--radius-xl` | `12px` | Modals, large cards |
| `--radius-pill` | `999px` | Pills, avatars |

**Status today:** 362 hardcoded references. Consolidation candidate.

---

## 5. Typography (canonical)

| Style | Family | Size | Weight | Use |
| --- | --- | --- | --- | --- |
| Page title | Brand serif (Velvet) | 24px | 600 | H1 |
| Section title | UI sans (Inter) | 16px | 600 | H2 |
| Body | UI sans (Inter) | 14px | 400 | paragraphs |
| Small | UI sans (Inter) | 12px | 400 | helper text |
| Mono | JetBrains Mono | 12px | 400 | code, ids, hashes |

The codebase imports the brand serif via the global CSS file. Operational
chrome (sidebar / topbar / shell) uses the velvet brand color + serif title.
Operational surfaces (evidence / matter / reviewer / reports) use Inter +
slate operational palette.

---

## 6. Component patterns

### 6.1 Buttons

Three canonical variants exist today:

| Variant | Background | Foreground | Border | Use |
| --- | --- | --- | --- | --- |
| Primary | `#0f172a` (or gradient with velvet sweep) | `#ffffff` | none | Approve / Sign / Confirm |
| Secondary | `#f1f5f9` | `#0f172a` | `#cbd5e1` | Cancel, secondary |
| Ghost | transparent | `#0f172a` | none | Tertiary, inline |
| Danger | `#fef2f2` | `#7f1d1d` | `#fecaca` | Destructive |

**Status today:** 4 independent definitions (CSS + token files). Canonical
location: `apps/web/components/operational/tokens.ts` for inline-style
callers; `apps/web/app/globals.css` `.btn` classes for CSS callers.
Consolidation candidate.

### 6.2 Cards

| Variant | Background | Border | Radius | Shadow |
| --- | --- | --- | --- | --- |
| Standard | `#ffffff` | `#e2e8f0` | `8px` | subtle |
| Dense (reviewer-ops) | `#ffffff` | `#cbd5e1` | `6px` | none |
| Glass (capture) | `rgba(255,255,255,0.85)` | none | `20px` | medium |
| Gradient (evidence row) | brand gradient | none | `12px` | subtle |

### 6.3 Inputs

Single canonical pattern:
- Padding: `8px 10px`
- Border: `1px solid #cbd5e1`
- Border radius: `6px`
- Font size: `14px`
- Focus ring: 2px teal-700 outset

### 6.4 Tables

Single canonical pattern:
- Row padding: density-driven (`6px 10px` compact, `10px 14px` comfortable,
  `16px 18px` spacious)
- Row separator: `1px solid #f1f5f9`
- Header: `font-weight: 600`, `font-size: 13px`, `color: #0f172a`,
  `border-bottom: 1px solid #e2e8f0`
- Selected row: `rgba(0, 0, 0, 0.04)` overlay

### 6.5 Badges

The canonical badge palette is the four status palettes documented in
section 2.2. Three independent palette definitions exist in the codebase
today (`globals.css` + `reviewer-ops/ui-tokens.ts` +
`operational/tokens.ts`). Consolidation candidate: promote the
`operational/tokens.ts` `OPS_TONES` map to the shared location and migrate
the other two.

---

## 7. Architecture

### 7.1 What's in use

- **Vanilla CSS** in `globals.css` (4.2 KB, hosts brand variables) + 8
  component-scoped `.css` files (13.1 KB total). Includes Tailwind
  directives but **no Tailwind utilities are used in JSX today.**
- **CSS-in-JS via imported style functions**: three token modules
  (`operational/tokens.ts`, `reviewer-ops/ui-tokens.ts`,
  `admin/identity/ui-tokens.ts`) export `CSSProperties` objects.
  Components apply them via `style={pageStyle}`, `style={cardStyle()}`,
  etc.
- **No CSS Modules.** No styled-components. No emotion.

### 7.2 The right approach

**Keep the current hybrid architecture.** It works, it's deliberate, and
the brand identity is intact. Do NOT migrate to Tailwind utilities, do
NOT introduce styled-components, do NOT fragment with CSS Modules.

**Consolidate within the existing patterns:**

1. Promote `OPS_TONES` from `operational/tokens.ts` to a shared
   `apps/web/lib/ui-tokens.ts` so the three duplicate palettes converge.
2. Introduce the spacing + radius scales in `globals.css` as `:root`
   custom properties. Migrate one or two high-traffic files (no big-bang
   rewrite).
3. Codify the style-import pattern: pages that consume
   `apps/web/components/operational/tokens.ts` continue to do so;
   new pages follow the same pattern.

### 7.3 What NOT to do (deliberate non-debt)

- Glassmorphism backdrop-blur on the dark shell is brand identity.
- Gradient buttons (silver sweep on primary) are micro-interaction
  design.
- Page-scoped variables on Capture (`--capture-ink`, `--capture-teal`)
  are intentional — Capture is a distinct operational flow.
- The velvet topbar/sidebar combination is the brand.

---

## 8. Acceptance criteria

The Phase G5.3 consolidation acceptance is **documentation-driven**, not
flow-rewriting. Acceptance is:

- [x] Brand palette enumerated above.
- [x] Operational + status palettes enumerated.
- [x] Spacing + radius + typography canonical ladders named.
- [x] Component patterns inventoried (button / card / input / table /
      badge).
- [x] Architecture decision (hybrid CSS + inline-style functions) named
      as canonical.
- [x] Consolidation candidates named (status badge palette unification,
      spacing/radius vars).
- [x] Deliberate non-debt items called out so a future "polish PR"
      doesn't accidentally erase brand identity.

Phase G5.3 does NOT ship a token migration in code — that is bounded
follow-up work that can be done one surface at a time without risk.

---

## 9. Reference

- Global CSS: [apps/web/app/globals.css](../../apps/web/app/globals.css)
- App shell CSS: [apps/web/components/app-shell-v2/app-shell-v2.css](../../apps/web/components/app-shell-v2/app-shell-v2.css)
- Capture CSS: [apps/web/components/capture-v2/capture-v2.css](../../apps/web/components/capture-v2/capture-v2.css)
- Operational tokens: [apps/web/components/operational/tokens.ts](../../apps/web/components/operational/tokens.ts)
- Reviewer-ops tokens: [apps/web/app/(app)/reviewer-ops/ui-tokens.ts](../../apps/web/app/%28app%29/reviewer-ops/ui-tokens.ts)
- Identity tokens: [apps/web/app/(app)/admin/identity/ui-tokens.ts](../../apps/web/app/%28app%29/admin/identity/ui-tokens.ts)
