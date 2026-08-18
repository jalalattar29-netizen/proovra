# PROOVRA V2 — Figma token extraction (Case Details)

**Source:** `PROOVRA (1).fig` → `canvas.fig`
**Method:** the `.fig` archive is a ZIP; `canvas.fig` is a `fig-kiwi` container
(8-byte magic + version, then length-prefixed blocks). Block 0 is the compiled
Kiwi schema (631 definitions, raw-deflate); block 1 is the message payload
(**zstd**, 18,582,071 bytes) decoded against that schema. The decode consumed
every byte and yielded **17,085 `NodeChange` records**. Every value below is
read from a decoded node property — none is sampled from a screenshot and none
is invented.

Frames used as authority:

| Purpose | Figma path |
|---|---|
| Overview | `Document / Final UI / Cases - Bilal - Overview` |
| Evidence | `Document / Final UI / Cases - Bilal - Evidence` |
| Sidebar | `Document / Design System / Components / Sidebar` (`Property 1=Big` / `Property 1=Small`) |
| Topbar | `Document / Design System / Components / Navbar` |

---

## 1. Colour — from the file's `VARIABLE` collection

These are `variableDataValues` fills, i.e. the design tokens themselves.

| Figma variable | Decoded value | Token | Label printed in the supplied colour artwork |
|---|---|---|---|
| `Color Palette/Black` | `#0F172A` | `--pv2-black` | #0F172A — agrees |
| `Color Palette/BG` | `#F8FAFC` | `--pv2-bg` | F8FAFC — agrees |
| `Color Palette/Grey` | `#6B7280` | `--pv2-grey` | #6B7280 — agrees |
| `Color Palette/Primary-Button-BG` | `#0B1F5E` | `--pv2-navy` | #0B1F5E — agrees |
| `Color Palette/Blue` | `#2563EB` | `--pv2-blue` | #2563EB — agrees |
| `Color Palette/Purple` | `#7C3AED` | `--pv2-purple` | #7C3AED — agrees |
| `Color Palette/Green` | `#047857` | `--pv2-green` | #047857 — agrees |
| `Color Palette/Cyan` | `#0891B2` | `--pv2-cyan` | #0891B2 — agrees |
| `Color Palette/Orange` | `#F97316` | `--pv2-orange` | #F97316 (labelled "Attention-secondary") — agrees |
| `Color Palette/Pink` | **`#DB2777`** | `--pv2-pink` | **#FFF2F2 — CONTRADICTS** |
| `Color Palette/Success` | **`#10B981`** | `--pv2-success` | **#047857 — CONTRADICTS** |
| `Color Palette/Warning` | **`#F59E0B`** | `--pv2-warning` | **#047857 — CONTRADICTS** |
| `Color Palette/Error` | **`#DC2626`** | `--pv2-error` | **#ED2121 — CONTRADICTS** |

Per the task's authority order the variable fill wins; the four contradictions
are annotated inline in `proovra-v2.css` as `FIGMA CONFLICT`.

Colours used by the Case frames that are *not* in the variable collection
(read from the node fills directly):

| Use | Value | Token |
|---|---|---|
| Breadcrumb + page-meta ink | `#565E74` | `--pv2-ink-meta` |
| Page title / current crumb | `#1D1A24` | `--pv2-ink-strong` |
| Inactive tab label | `#5C5C5C` | `--pv2-ink-tab-idle` |
| Active tab fill | `#2563EB` @ 10 % | `--pv2-accent-tab-soft` |
| Status-badge fill / ink | `#DCFCE7` / `#047857` | `--pv2-success-soft` / `--pv2-success-ink` |
| Field + keyboard-chip stroke | `#E2E8F0` | `--pv2-border-field` |
| Ctrl-K chip ink | `#94A3B8` | `--pv2-ink-kbd` |
| Card stroke | `#F8FAFC` | `--pv2-border-card` |

## 2. Sidebar gradient

`ROUNDED_RECTANGLE "Background"`, `GRADIENT_LINEAR`
`#7C3AED @0 → #DB2777 @0.5 → #F97316 @1`, transform `m[0,1,0,-1,0,1]` (top→bottom)
→ `linear-gradient(180deg, …)`.
Stroke `rgba(255,255,255,0.15)`; effects `DROP_SHADOW 0 12 40 rgba(0,0,0,.12)` +
`INNER_SHADOW 0 1 6 rgba(255,255,255,.12)`; radius `0/16/16/0`.

## 3. Typography — `Plus Jakarta Sans`

| Role | Figma | Token / class |
|---|---|---|
| Breadcrumb | Medium 12 / 18 | `.pv2-crumbs` |
| Page title | Bold 24 / 24 | `.pv2-pagehead-title` (rendered at 32 — see note) |
| Page meta | Regular 13 / 18 | `.pv2-pagehead-meta` |
| Status badge | Bold 10 / 15 | `.pv2-status` |
| Tab label | SemiBold 16 / 20 | `.pv2-tab` |
| KPI label | Medium 12 / 14 | `.pv2-metric-label` |
| KPI value | Bold 20 / 28 | `.pv2-metric-value` |
| KPI hint | Regular 10 / 15, opacity .6 | `.pv2-metric-hint` |
| K/V key | SemiBold 13 / 16, ls 0.6 | `.pv2-kv-key` |
| K/V value | Medium 14 / 20 | `.pv2-kv-val` |
| Rail section label | Medium 12 / 14, ls 1.1, upper | `.pv2-rail-title` |
| Button label | Regular–Medium 16 / 24 | `.pv2-btn` |
| Attention title | Bold 18 / 28 | `.pv2-attention-title` |
| Body / attention text | Regular 16 / 24 | `.pv2-attention-text` |
| Evidence row title | Bold 18 / 24 | `.pv2-row-title` |
| Evidence row meta | Regular 13 / 18 | `.pv2-row-meta` |
| Copilot heading | SemiBold 20 / 28 | `.pv2-copilot-rail h3` |
| Copilot disclosure | Italic 13 / 21.13 | `.pv2-copilot-rail .app-chip` |

## 4. Geometry

| Element | Figma | Token |
|---|---|---|
| Sidebar collapsed | 82.25 | `--pv2-sidebar-collapsed: 82px` |
| Sidebar expanded | 256 | `--pv2-sidebar-expanded: 256px` |
| Sidebar nav item | h 56, pad 16/20 (12 collapsed), gap 16, r 12, active `rgba(255,255,255,.20)` | scoped shell rules |
| Topbar | h 80, pad 16/32, bg `#F8FAFC`, shadow `0 2 4 rgba(0,0,0,.12)` | `--pv2-topbar-h` |
| Topbar search | 686.75 × 40, pad 8/16, r 8, 1px `#E2E8F0` | scoped shell rules |
| Content container | pad 24/32/32/32, gap 24, fluid | `.pv2-page-plane` |
| Content inner width @1440 | 1293.75 | measured 1294 |
| Tab bar | h 44, pad 4, gap 8, r 8, shadow `0 1 2 rgba(0,0,0,.05)` | `.pv2-tabs` |
| Tab item | h 36, pad 8/16, r 8 | `.pv2-tab` |
| KPI card | 227.44 × 95, pad 16, r 16, 1px `#F8FAFC`, shadow `0 1 2 rgba(0,0,0,.05)` | `.pv2-metric` |
| KPI row | 957.75, gap 16 | `.pv2-metrics` |
| Case-summary panel | 957.75 × 206, pad 24/16, gap 16, r 16 | `.pv2-surface--panel` |
| Action rail | 312 (Evidence: 326), pad 24, gap 16, r 16 | `--pv2-rail-w` / `--pv2-rail-w-wide` |
| Rail button | 262 wide, h 36–40, pad 6/12, r 4, 1px `#7C3AED` | `.pv2-btn--outline` |
| Attention banner | pad 16, r 12, 1px `#F59E0B` | `.pv2-attention` |
| Evidence search | 943.75 × 56, pad 16, r 8, 1px `#E2E8F0` | `.pv2-search` |
| Evidence row | 943.75 × 114, pad 24, r 16, gap 24 between rows | `.pv2-row` / `.pv2-rows` |
| Case-ID copy control | 305 × 32, pad 6/12, r 4, 1px `#6B7280` | `.pv2-copyfield` |
| Icon grid | 24 (20 inside 16-px controls), stroke ~1.8, round caps | `components/proovra-v2/icons.tsx` |

## 5. Spacing scale

`Spacing/space-xs 8`, `space-sm 16`, `space-md 32`, `space-lg 64`, `space-xl 128`,
plus the 4 / 12 / 20 / 24 steps measured in the frames' auto-layout.

## 6. Contradictions found inside the Figma file itself

1. **Colour labels vs variable fills** — four mismatches, table above.
2. **Tab component drift.** The active tab (`Component 7`) is padded `4/8`, uses a
   14 / 18 label and carries a 2 px underline rectangle; the four inactive tabs
   (`Component 8/9/11/13`) are padded `8/16` with a 16 / 20 label and no
   underline. Implemented to the majority form (`8/16`, 16 / 20, filled pill, no
   underline), which is also what the supplied Case screenshots show.
3. **Card stroke is invisible.** Cards stroke 1 px `#F8FAFC` INSIDE, on a
   `#F8FAFC` page — the border cannot be seen and the silhouette is carried by
   the shadow. Reproduced exactly as specified.
4. **"RISK SIGNALS" rail heading.** The Overview rail is titled `RISK SIGNALS`
   but contains four ordinary operational actions. See the deliverable — the
   truthful product term is kept.
5. **KPI card arithmetic.** Card height 95 with pad 16 implies 63 px of content,
   but the three children measure 14 + 32 + 15 = 61, and the value container is
   declared 32 while wrapping a 28 px line with 4 px padding (= 36). Resolved by
   using 2 px value padding, which reproduces the stated 95 px card exactly.
6. **Page-title line-height 24 at font-size 24** clips descenders. Rendered at
   32 for legibility; every other type value is exact.
