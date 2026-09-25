# SIDEBAR-PARITY — PWA sidebar vs Native navigation rail

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · SOURCE-ONLY · nothing rendered
**PWA reference:** `apps/web/components/app-shell-v2/AppSidebarV2.tsx` (772 lines) + `app-shell-v2.css` (2,402 lines)
**Native counterpart:** `apps/mobile/src/ui/shell.tsx` (175 lines) — `ProovraTabletRail` / `ProovraBottomNav`

**Scope check performed first:** compared against the **applicable self-serve
sidebar**, not the enterprise `CommandCenter` branch. `AppSidebarV2` is rendered
by `AppShellV2.tsx:212-213` for every authenticated surface regardless of tier;
the enterprise fork happens *inside* `/home`, not in the shell.

---

## A · BACKGROUND AND ASSETS

### A.1 The decisive fact: Native ships no background artwork at all

| | PWA | Native |
|---|---|---|
| Total image assets in the app | **56** (`apps/web/public/assets/**`) | **5** (`apps/mobile/assets/`) |
| Native's five | — | `icon.png`, `adaptive-icon.png`, `adaptive-icon-monochrome.png`, `splash-icon.png`, `brand-mark.png` |

Every one of Native's five is an **app/launcher icon or the brand mark**. There
is no background, hero, card or artwork asset in the native bundle.

### A.2 Sidebar background image

| Property | PWA (`app-shell-v2.css:171-178`) | Native |
|---|---|---|
| `background-image` | `url("/assets/cards/sidebar.png")` — **1,123,787 bytes, present on disk** | **none** — `styles.rail` sets only `backgroundColor` (`shell.tsx:162`) |
| `background-repeat` | `no-repeat` | n/a |
| `background-position` | `center` | n/a |
| `background-size` | `cover` | n/a |
| Overlay / gradient | **none** — the CSS comment at `:171` states *"One image, shown naturally: no CSS gradient, no overlay"* | n/a |
| Dedicated bg layer element | `<div className="app-sidebar-v2-bg" />` (`AppSidebarV2.tsx:664`) | **no equivalent element** |

**Root cause: MISSING ASSET.** `sidebar.png` does not exist under
`apps/mobile/assets/`, is not imported by any native file, and there is no
`ImageBackground` anywhere in `apps/mobile` (verified: no `ImageBackground`
import in the native tree). This is not a mapping error or a styling error — the
artwork is absent from the bundle.

### A.3 App-shell background image

| Property | PWA (`app-shell-v2.css:70-75`) | Native |
|---|---|---|
| `background-color` | `#F7F8FC` (`--shell-bg` → `--surface-app`) | `#F7F8FC` (`theme.color.surface.app`, `shell.tsx:145`) — **MATCH** |
| `background-image` | `url("/assets/backgrounds/app-shell-bg.png")` — 1,137,837 bytes, present | **none** |
| `background-size` / `position` / `repeat` / `attachment` | `cover` / `center top` / `no-repeat` / `fixed` | n/a |

The **colour** matches exactly. The **artwork layered over it does not exist**.

> **Resolution caveat, stated rather than hidden:** `.app-shell-v2` carries **5
> competing rules**; a later one re-declares `background-image: none`. Which wins
> at runtime depends on cascade order and conditional class application and is
> **UNRESOLVED BY CONSTRUCTION**. The asset reference at `:71` is certain; whether
> it survives the cascade on a given breakpoint is not. The sidebar image (A.2)
> has no such ambiguity — single rule, no competitor.

### A.4 Brand / logo

| | PWA | Native |
|---|---|---|
| Element | `.app-sidebar-v2-brand` (`AppSidebarV2.tsx:667`) containing `-brand-mark` (`:671`) and `-brand-logo` (`:677`) | **no brand area in the rail or bottom bar** |
| Height | `72px` (`--app-topbar-h`) | n/a |
| Padding | `14px 12px` | n/a |
| Assets available | `/assets/branding/proovra-mark.png`, `logo-light.png`, `logo-dark.png`, `footer-logo.png` | only `brand-mark.png`, and it is used **only** by `AuthBrandHeader` (`src/ui/brand.tsx:16`) — never by the shell |

**Root cause: MISSING STRUCTURAL COMPONENT.** The asset exists in native; the
shell has no brand area to put it in.

---

## B · LAYOUT

| Property | PWA | Native | Verdict |
|---|---|---|---|
| Width — collapsed | **68px** (`--sidebar-collapsed`) | — | **MISSING** (no collapse) |
| Width — expanded | **240px** (`--sidebar-expanded`) | **220px** (`shell.tsx:161`) | **DIFFERENT** (−20px) |
| Collapse/expand transition | `220ms cubic-bezier(0.16, 1, 0.3, 1)` (`--sidebar-transition`) | **none** | **MISSING** |
| Height | `100vh` | flex within `SafeAreaView` | VALID ADAPTATION |
| Brand area | 72px header block | **absent** | **MISSING** |
| Nav row gap | `3px` (`.app-sidebar-v2-nav`) | `theme.space.s1` = **4px** | **DIFFERENT** |
| Row height | driven by link padding | `minHeight: 44` (`railItem`) | VALID ADAPTATION (44pt touch target) |
| Row radius | — | `theme.radius.md` | — |
| Group titles | `.app-sidebar-v2-group-title` (`:379`) | **absent** | **MISSING** |
| Group separators | `--nav-divider` on `.app-sidebar-v2-group` | **absent** | **MISSING** |
| Scroll container | `.app-sidebar-v2-scroll` (`:680`) | rail is **not scrollable** (plain `View`) | **MISSING** — 7 items fit; a longer list would clip |
| "All Tools" group | `:710-716` | **absent** | **MISSING** |
| Help / support link | `.app-sidebar-v2-help` (`:741-746`) | **absent** | **MISSING** |
| Footer / account area | present | **absent** | **MISSING** |
| Mobile drawer | `AppShellV2.tsx:276` renders `<AppSidebarV2 />` inside a drawer | bottom bar instead (`ProovraBottomNav`) | **VALID PLATFORM ADAPTATION** |
| Border | `border-inline-end: 1px solid rgba(255,255,255,0.08)` | `borderRightWidth: hairline`, `borderRightColor: rgba(15,23,42,0.09)` | **DIFFERENT** (light-on-dark vs dark-on-light) |
| Shadow | `box-shadow: 1px 0 0 rgba(20,26,34,0.04)` | **none** | **MISSING** |

---

## C · TYPOGRAPHY AND COLOURS — the second root cause

### C.1 The nav palette exists in Native and is byte-identical. The shell does not use it.

`packages/ui/src/tokens/proovra.generated.ts` emits a complete `nav` ramp, and it
is reachable as `theme.color.nav.*`:

| Token | PWA custom property | PWA value | Native `theme.color.nav.*` | Identical? |
|---|---|---|---|---|
| ink strong | `--nav-ink-strong` | `#F8FAFC` | `nav.inkStrong` = `#F8FAFC` | **YES** |
| ink | `--nav-ink` | `rgba(226, 232, 240, 0.82)` | `nav.ink` = `rgba(226, 232, 240, 0.82)` | **YES** |
| ink muted | `--nav-ink-muted` | `rgba(226, 232, 240, 0.42)` | `nav.inkMuted` = `rgba(226, 232, 240, 0.42)` | **YES** |
| icon idle | `--nav-icon-idle` | `rgba(226, 232, 240, 0.58)` | `nav.iconIdle` = `rgba(226, 232, 240, 0.58)` | **YES** |
| hover bg | `--nav-hover-bg` | `rgba(255, 255, 255, 0.05)` | `nav.hoverBg` = `rgba(255, 255, 255, 0.05)` | **YES** |
| active bg | `--nav-active-bg` | `rgba(255, 255, 255, 0.06)` | `nav.activeBg` = `rgba(255, 255, 255, 0.06)` | **YES** |
| divider | `--nav-divider` | `rgba(255, 255, 255, 0.08)` | `nav.divider` = `rgba(255, 255, 255, 0.08)` | **YES** |

**`apps/mobile/src/ui/shell.tsx` references ZERO of these.** Its complete token
usage, extracted from source, is:

```
theme.color.accent.a500   theme.color.border.default  theme.color.border.strong
theme.color.ink.muted     theme.color.ink.primary     theme.color.surface.app
theme.color.surface.card  theme.color.status.pending.{bg,fg}
theme.radius.md  theme.space.s*  theme.type.size.label
```

### C.2 The consequence — a colour inversion

The PWA sidebar is a **dark artwork with light text**. Native renders a **white
surface with dark text**.

| Element | PWA resolved | Native resolved | Verdict |
|---|---|---|---|
| Rail background | `url(sidebar.png)` over dark artwork | `#FFFFFF` (`surface.card`) | **VISUAL MISMATCH** |
| Label — active | `#F8FAFC` (`--nav-ink-strong`) | `#0F172A` (`ink.primary`) | **INVERTED** |
| Label — idle | `rgba(226,232,240,0.82)` (`--nav-ink`) | `#94A3B8` (`ink.muted`) | **INVERTED** |
| Row hover | `rgba(255,255,255,0.05)` | **no hover state** | **MISSING** |
| Row active background | `rgba(255,255,255,0.06)` | **none** — an 8×8 dot instead | **DIFFERENT CONTROL** |
| Divider | `rgba(255,255,255,0.08)` | `rgba(15,23,42,0.09)` | **INVERTED** |
| Icon colour | `rgba(226,232,240,0.58)` (`--nav-icon-idle`) | **no icons** | **MISSING** |
| Bottom bar background | n/a | `#FFFFFF` (`surface.card`) | native-only surface |

**Root cause: INCORRECT TOKEN MAPPING.** The shell reads body-text tokens
(`ink.*`) where the generator produced navigation tokens (`nav.*`) for exactly
this surface. Against the missing dark artwork (A.2), light `nav.*` ink would be
illegible — so the two defects are coupled and must be closed together.

### C.3 Typography

| | PWA | Native |
|---|---|---|
| Label size | from `.app-sidebar-v2-link` | `theme.type.size.label` |
| Weight | per CSS | `fontFamilyBold` (`NavButton:62`) — **always bold, active and idle alike** |
| Letter spacing | per CSS | not set |
| Truncation | CSS | `numberOfLines={1}` (`:60`) |

The PWA distinguishes active from idle by **colour + background**; Native
distinguishes by **colour + a dot**, with weight constant. **DIFFERENT.**

---

## D · FUNCTIONALITY

### D.1 Destination sets

| | PWA | Native |
|---|---|---|
| Source | **derived** — `ROUTE_REGISTRY` → `resolveRouteAccess` → `resolveNavigationExposure` → `resolveNavigationDisclosure` → `resolveNavigationGroups` (`AppSidebarV2.tsx:19-44`) | **hardcoded 7-item array** (`useNavItems()`, `shell.tsx:23-33`) |
| Icons | `routeIconFor(route.id)` per route (`:269`, `:297`) | **none** |
| Capability gating | yes — per-route access resolver | **none** |
| Disclosure tiers | `getRouteDisclosureTier` (`:40`) | **none** |
| Degradation chips | `DEGRADATION_CHIP_LABELS` — *"Requires organization"*, *"Setup needed"*, *"Requires permission"*, *"Upgrade required"* | **none** |
| Badges | `aria-label={badge.ariaLabel}` (`:153`) | **none** |
| Storage widget | `SidebarStorageWidget` (148 lines) | **absent from the shell** |

**Native's 7 destinations:** Home · Capture · Cases · Evidence · Reports ·
Alerts · Settings.

### D.2 Active-route highlighting

| | PWA | Native |
|---|---|---|
| Mechanism | `usePathname()` + CSS `--nav-active-bg` | `isActive(pathname, href)` (`shell.tsx:36-38`) + dot colour + `ink.primary` |
| Semantics | prefix match | `pathname === href \|\| pathname.startsWith(href + "/")`, with `/` special-cased | **EQUIVALENT LOGIC** |
| a11y | — | `accessibilityState={{ selected: active }}` (`:48`) — **native is better here** |

### D.3 Absent navigation affordances

Confirmed absent from the native shell, each with its PWA source:

| Affordance | PWA source |
|---|---|
| Global search / command palette | `AppAccountToolbar.tsx:328`, `AppShellV2.tsx:252` |
| Workspace switcher | `AppAccountToolbar.tsx:402` |
| Account menu + avatar | `:583`, `:708` |
| Notification bell | `NotificationBell.tsx` (722 lines) |
| Language selector | `:373` |
| System status | `:365` |
| Skip link | `AppShellV2.tsx:195` |
| Support/help link | `AppSidebarV2.tsx:741` |
| "All Tools" | `AppSidebarV2.tsx:710` |
| Workspace recovery panels | `AppShellV2.tsx:241`, `:243` |

`(tabs)/teams.tsx` exists as a screen but is **not in `useNavItems()`** —
reachable only via `settings.tsx:259` and an invite deep link.

---

## E · ROOT-CAUSE CLASSIFICATION

| ID | Class | Statement | Evidence |
|---|---|---|---|
| **SB-1** | **MISSING ASSET** | `sidebar.png` and `app-shell-bg.png` are absent from `apps/mobile/assets/` (5 assets, all icons). No `ImageBackground` exists anywhere in the native tree | A.1–A.3 |
| **SB-2** | **INCORRECT THEME MAPPING** | All 7 `theme.color.nav.*` tokens exist with byte-identical values; `shell.tsx` uses `ink.*`/`border.*`/`surface.card` instead | C.1–C.2 |
| **SB-3** | **MISSING STRUCTURAL COMPONENT** | No brand area, no group titles, no separators, no scroll container, no footer/account area, no storage widget, no help link | B, D.1 |
| **SB-4** | **DIFFERENT PRODUCT SCOPE** | Nav is a hardcoded 7-item array vs a registry-derived, capability-gated, grouped, icon-bearing list | D.1 |
| **SB-5** | **MISSING UI ELEMENT** | No icons on any nav item — `--nav-icon-idle` has no consumer | C.2, D.1 |
| **SB-6** | **MISSING BEHAVIOUR** | No collapse/expand, no hover state, no badges, no degradation chips, no rail scrolling | B, D.1 |
| **SB-7** | **GEOMETRY DIFFERENCE** | Rail 220px vs expanded 240px; row gap 4px vs 3px | B |

SB-1 and SB-2 are **coupled**: applying the light `nav.*` ink without the dark
artwork would make the rail unreadable.

## F · Explicitly UNRESOLVED for this surface

1. **Which `.app-shell-v2` background declaration wins** — 5 competing rules, one
   re-declaring `background-image: none`. Cascade + conditional classes are
   runtime facts (A.3). The **sidebar** image has no competing rule.
2. **Rendered appearance** — nothing here was rendered. Every statement is a
   source-defined value, not an observed pixel.
3. **Whether `sidebar.png` is visually appropriate at a 220px rail on a tablet** —
   a design question, not a source question.
