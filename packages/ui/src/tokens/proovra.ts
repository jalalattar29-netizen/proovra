/**
 * CANONICAL PROOVRA DESIGN TOKENS — cross-platform, DERIVED not mirrored.
 *
 * This file used to hold hand-copied literals from
 * `apps/web/lib/design-tokens/tokens.css`: two authored sources for one set of
 * values, guarded by a drift test that checked 27 of them. 63 of the CSS
 * file's custom properties were mirrored and ~95 were not, so most of the web
 * design language had no native counterpart at all — which is the mechanical
 * reason Native read as a different product rather than a differently-shaped
 * one.
 *
 * Now there is ONE authored source (the CSS) and one derived artefact
 * (`proovra.generated.ts`, emitted by `packages/ui/tools/generate-tokens.mjs`,
 * with every `var()` alias flattened because React Native has no cascade).
 * This module only composes that artefact into the bundle both platforms read.
 *
 * Re-run the generator after editing tokens.css;
 * `packages/ui/tests/tokens-generated.test.mjs` fails when the checked-in file
 * and a fresh generation disagree.
 */
import {
  proovraSurface,
  proovraBorder,
  proovraInk,
  proovraAccent,
  proovraSemantic,
  proovraStatus,
  proovraStatusText,
  proovraRadius,
  proovraSpace,
  proovraNav,
  proovraLayout,
  proovraRaw,
} from "./proovra.generated";

export {
  proovraSurface,
  proovraBorder,
  proovraInk,
  proovraAccent,
  proovraSemantic,
  proovraStatus,
  proovraStatusText,
  proovraRadius,
  proovraSpace,
  proovraNav,
  proovraLayout,
  proovraRaw,
};

/**
 * Elevation semantics, read from the generated shadows rather than re-typed.
 * The strings are CSS box-shadows (the web's form); the native adapter in
 * `apps/mobile/src/theme` translates them into RN shadow objects + elevation.
 */
export const proovraElevationWeb = {
  card: proovraRaw.shadowCard,
  elevated: proovraRaw.shadowElevated,
  dropdown: proovraRaw.shadowDropdown,
  drawer: proovraRaw.shadowDrawer,
} as const;

/**
 * Type scale. AUTHORED HERE, deliberately: the web expresses its type as
 * composite CSS shorthands (`--font-card-title: 600 14px/1.4 …`) and Tailwind
 * classes rather than a numeric scale, so there is nothing to derive. These
 * numbers are the cross-platform scale both renderers target, and the three web
 * shorthands they correspond to are carried in `proovraRaw.font*` so the two
 * can be compared. Fonts are self-hosted Plus Jakarta Sans (latin) + Noto
 * Arabic.
 */
export const proovraType = {
  family: { latin: "Plus Jakarta Sans", arabic: "Noto Sans Arabic" },
  size: { display: 28, h1: 22, h2: 18, h3: 16, body: 14, bodySm: 13, label: 12, mono: 12 },
  weight: { regular: "400", medium: "500", semibold: "600", bold: "700" },
  lineHeight: { display: 34, h1: 28, h2: 24, h3: 22, body: 20, bodySm: 18, label: 16 },
} as const;

/** The single canonical token bundle. */
export const proovraTokens = {
  surface: proovraSurface,
  border: proovraBorder,
  ink: proovraInk,
  accent: proovraAccent,
  semantic: proovraSemantic,
  status: proovraStatus,
  statusText: proovraStatusText,
  radius: proovraRadius,
  space: proovraSpace,
  nav: proovraNav,
  layout: proovraLayout,
  raw: proovraRaw,
  elevationWeb: proovraElevationWeb,
  type: proovraType,
} as const;

export type ProovraTokens = typeof proovraTokens;
export type ProovraStatusTone = keyof typeof proovraStatus;
