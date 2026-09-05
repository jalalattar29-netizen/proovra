"use client";

/**
 * Button — canonical PROOVRA action primitive (Phase 7 foundation).
 *
 * One button, every intent. Consumes the design tokens in
 * `app/globals.css` + `lib/design-tokens/tokens.css` — no hard-coded
 * palette. Use this instead of ad-hoc `<button style={{…}}>` on internal
 * pages so intent, sizing, focus, loading and disabled states stay
 * consistent app-wide.
 *
 * VARIANTS
 *   - primary     coral → pink gradient CTA + premium shadow (the login
 *                 CTA language). One primary action per view.
 *   - secondary   translucent pearl surface + hairline border + clear
 *                 hover. The default for most actions.
 *   - enterprise  violet/indigo gradient — governance / trust surfaces.
 *   - destructive solid red — irreversible / removal actions.
 *   - ghost       text-only, no chrome until hover — toolbars, inline.
 *
 * SIZES: sm | md (default) | lg.
 *
 * STATES: `loading` shows a spinner + disables; `disabled` greys out.
 *         Both keep an accessible name and `aria-busy` while loading.
 *
 * A11Y: real <button>, visible focus ring via :focus-visible, honours
 * prefers-reduced-motion (transitions collapse), 44px min touch target
 * at md/lg, sufficient contrast on every variant.
 *
 * USAGE
 *   <Button variant="primary" onClick={save}>Save evidence</Button>
 *   <Button variant="secondary" size="sm" leadingIcon={<Icon/>}>Filter</Button>
 *   <Button variant="destructive" loading={busy}>Delete</Button>
 */

import React, { forwardRef } from "react";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "enterprise"
  | "destructive"
  | "ghost";

export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables interaction. */
  loading?: boolean;
  /** Stretch to fill the container width. */
  fullWidth?: boolean;
  /** Icon rendered before the label. */
  leadingIcon?: React.ReactNode;
  /** Icon rendered after the label. */
  trailingIcon?: React.ReactNode;
}

/**
 * The button look, without the button element.
 *
 * Some controls must be real links — a row that opens a detail page has to
 * support middle-click and "open in new tab", and a <button> that calls
 * router.push silently takes both away. Wrapping a <Button> in a <Link>
 * produces `<a><button>`, which is invalid and was one half of a hydration
 * error on /admin/demo-requests.
 *
 * So the styling is exported and the link wears it. One source of truth for
 * the look; the element stays whatever the interaction actually is.
 */
export function buttonSurfaceStyle(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 650,
    letterSpacing: "0.01em",
    cursor: "pointer",
    whiteSpace: "nowrap",
    userSelect: "none",
    textDecoration: "none",
    ...SIZE_STYLE[size],
    ...variantStyle(variant),
  };
}

const SIZE_STYLE: Record<ButtonSize, React.CSSProperties> = {
  // 44, not 34.
  //
  // An earlier pass left this at 34 on the argument that `sm` is the dense
  // in-table size and raising it would loosen every data table. That argument
  // was made without measuring either half of it: the matrix then found `sm`
  // buttons as page-level filter actions (Refresh, Clear on /admin/customers),
  // where 34px is simply under the floor with no density to defend.
  //
  // Raised, and then MEASURED across all 47 routes at every viewport — the
  // overflow and clipping checks are what decide whether 361 call sites can
  // carry it, rather than a guess in either direction.
  sm: { minHeight: 44, padding: "0 12px", fontSize: 13, borderRadius: 10, gap: 6 },
  // 44 and not 42: the default button size is the one used for page actions
  // like Refresh and Provision, and the matrix measured every one of them at
  // 42px tall.
  //
  // (The sentence that used to sit here said "`sm` stays 34 on purpose".
  // It contradicted the `sm` entry directly above, which had already been
  // raised to 44 with its own reasons. Removed rather than reconciled: two
  // comments disagreeing about the same value is worse than either one.)
  md: { minHeight: 44, padding: "0 18px", fontSize: 14, borderRadius: 12, gap: 8 },
  lg: { minHeight: 50, padding: "0 24px", fontSize: 15, borderRadius: 14, gap: 10 },
};

/**
 * A DISABLED BUTTON LOSES ITS FILL. IT DOES NOT JUST FADE.
 *
 * `opacity: 0.6` was the only disabled signal, and on a filled variant that is
 * not enough: a 60%-opacity solid purple still reads as an available primary
 * call to action. /admin/identity/scim showed it exactly — two "New token"
 * buttons, both correctly `disabled` because directory provisioning is not in
 * the plan, both rendering as inviting purple CTAs directly above a notice
 * saying new tokens cannot be issued. The logic was right and the picture
 * contradicted it.
 *
 * Fading a filled variant is also a contrast problem in its own right: white
 * text at 60% opacity over a lightened fill measures well under AA, so the one
 * state that most needs to be legible was the least.
 *
 * A neutral surface with muted ink is unambiguous, and it keeps the reason
 * discoverable rather than hiding it — `title`/`aria-describedby` and the
 * visible caveat beside the control still say WHY.
 *
 * `loading` is deliberately NOT routed here: a loading button is mid-action,
 * not unavailable, and greying it out mid-flight reads as a failure.
 */
const DISABLED_SURFACE: React.CSSProperties = {
  background: "var(--surface-muted)",
  /* `--ink-secondary`, NOT `--ink-muted`, AND THE REASON IS A MEASUREMENT.
     `--surface-muted` is translucent (rgba(36,55,59,0.06)) and stacks on the
     card, which is itself translucent, so a disabled button's ground
     composites to roughly rgb(222,226,230) rather than to the #F1F4F9 the
     token nominally names. Muted ink measured 4.20-4.42:1 there — under AA on
     every admin surface it was tested against. `--ink-secondary` measures
     ~6.4:1 on the same ground.
     The control still reads as disabled: the fill is gone, the cursor is
     `not-allowed`, and the `disabled` attribute is what assistive technology
     announces. None of that required the label to be hard to read. */
  color: "var(--ink-secondary)",
  border: "1px solid var(--border-default)",
  boxShadow: "none",
};

function variantStyle(variant: ButtonVariant): React.CSSProperties {
  switch (variant) {
    case "primary":
      return {
        background: "var(--btn-primary-bg)",
        color: "var(--btn-primary-color)",
        border: "1px solid var(--btn-primary-border)",
        boxShadow: "var(--btn-primary-shadow)",
      };
    case "enterprise":
      return {
        background: "var(--enterprise-gradient)",
        color: "var(--enterprise-accent-ink)",
        border: "1px solid rgba(107, 91, 255, 0.45)",
        boxShadow: "0 14px 28px rgba(107, 91, 255, 0.22)",
      };
    case "destructive":
      return {
        background: "var(--status-risk-solid)",
        color: "#ffffff",
        border: "1px solid rgba(220, 38, 38, 0.55)",
        boxShadow: "0 12px 24px rgba(220, 38, 38, 0.18)",
      };
    case "ghost":
      return {
        background: "transparent",
        color: "var(--ink-secondary, #475569)",
        border: "1px solid transparent",
        boxShadow: "none",
      };
    case "secondary":
    default:
      return {
        background: "var(--surface-card, #ffffff)",
        color: "var(--ink-primary, #0f172a)",
        border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
        boxShadow: "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))",
      };
  }
}

function Spinner({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      data-ui-button-spinner
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid currentColor",
        borderTopColor: "transparent",
        display: "inline-block",
        animation: "pf-spin 0.7s linear infinite",
        flexShrink: 0,
        opacity: 0.9,
      }}
    />
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    fullWidth = false,
    leadingIcon,
    trailingIcon,
    disabled,
    children,
    className,
    style,
    type = "button",
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;
  const spinnerSize = size === "sm" ? 13 : size === "lg" ? 17 : 15;

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      data-ui-button
      data-variant={variant}
      data-size={size}
      className={["ui-button", className].filter(Boolean).join(" ")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: fullWidth ? "100%" : undefined,
        fontWeight: 650,
        letterSpacing: "0.01em",
        cursor: isDisabled ? "not-allowed" : "pointer",
        /* NO FADE ON A DISABLED BUTTON, AND NO EXEMPTION CLAIMED.
           The neutral surface below already says "unavailable" unambiguously,
           so the opacity was doing no work except making the label harder to
           read: measured at 0.85 it put the label at 4.42:1, under AA. WCAG
           1.4.3 does exempt inactive components, but spending an exemption to
           keep a fade that carries no information is the wrong trade — the
           label of a disabled control is usually where the reason is. Without
           it the same label measures 4.93:1 and needs no exemption.
           A LOADING button keeps its fill and its colour: it is mid-action,
           not unavailable. */
        opacity: 1,
        whiteSpace: "nowrap",
        userSelect: "none",
        transition:
          "background-color 180ms ease, box-shadow 200ms ease, border-color 200ms ease, transform 160ms ease, filter 180ms ease, opacity 160ms ease",
        ...SIZE_STYLE[size],
        ...variantStyle(variant),
        /* AFTER the variant, so a filled variant's fill is genuinely replaced
           rather than sitting under a fade. BEFORE `style`, so a call site
           that has a reason to draw its own disabled treatment still can. */
        ...(disabled && !loading ? DISABLED_SURFACE : null),
        ...style,
      }}
    >
      {loading ? <Spinner size={spinnerSize} /> : leadingIcon}
      {children != null && children !== false ? (
        <span style={{ display: "inline-flex", minWidth: 0 }}>{children}</span>
      ) : null}
      {!loading ? trailingIcon : null}
    </button>
  );
});

Button.displayName = "Button";

export default Button;
