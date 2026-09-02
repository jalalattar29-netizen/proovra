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

const SIZE_STYLE: Record<ButtonSize, React.CSSProperties> = {
  sm: { minHeight: 34, padding: "0 12px", fontSize: 13, borderRadius: 10, gap: 6 },
  // 44 and not 42: the default button size is the one used for page actions
  // like Refresh and Provision, and the matrix measured every one of them at
  // 42px tall. `sm` stays 34 on purpose — it is the dense in-table action
  // size, nothing flagged it, and raising it would loosen every data table
  // to fix a control that is not the one being missed.
  md: { minHeight: 44, padding: "0 18px", fontSize: 14, borderRadius: 12, gap: 8 },
  lg: { minHeight: 50, padding: "0 24px", fontSize: 15, borderRadius: 14, gap: 10 },
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
        opacity: isDisabled ? 0.6 : 1,
        whiteSpace: "nowrap",
        userSelect: "none",
        transition:
          "background-color 180ms ease, box-shadow 200ms ease, border-color 200ms ease, transform 160ms ease, filter 180ms ease, opacity 160ms ease",
        ...SIZE_STYLE[size],
        ...variantStyle(variant),
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
