"use client";

/**
 * A native button with the canonical app-* action classes (TEAM-UI-SPEC §1)
 * that keeps the disabled-reason contract the legacy `Button` carried.
 *
 * The Team Review surfaces (QC, coding schemas, disagreements, metrics,
 * reviewer workspace, External Review) no longer render `components/ui/Button`
 * (`ui-button`, inline variant styles). They render this instead, matching the
 * Evidence Library / Evidence Detail markup:
 *
 *   primary       `app-primary-action`        the one forward action in a region
 *   secondary     `app-secondary-action`      ordinary actions
 *   filled        `… app-secondary-action--filled`
 *   ghost         `app-ghost-action`          tertiary / navigation
 *   danger-entry  `… app-secondary-action--danger`  opens an irreversible confirm
 *   danger        `app-danger-action`         the irreversible confirm itself
 *
 * When the control is disabled with a reason, the reason is exposed as the
 * accessible description (a visually hidden node), the hover title and
 * `data-disabled-reason` — the same three channels `Button` used, so the
 * PV-DIS-001 contract and the existing render tests keep holding. No inline
 * colour, border or shadow is ever applied.
 */

import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from "react";

export type CanonicalActionVariant =
  | "primary"
  | "secondary"
  | "filled"
  | "ghost"
  | "danger-entry"
  | "danger";

const VARIANT_CLASS: Record<CanonicalActionVariant, string> = {
  primary: "app-primary-action",
  secondary: "app-secondary-action",
  filled: "app-secondary-action app-secondary-action--filled",
  ghost: "app-ghost-action",
  "danger-entry": "app-secondary-action app-secondary-action--danger",
  danger: "app-danger-action",
};

export function canonicalActionClass(variant: CanonicalActionVariant): string {
  return VARIANT_CLASS[variant];
}

export type CanonicalActionButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "style"
> & {
  variant?: CanonicalActionVariant;
  /** Mid-action: disables the control and sets aria-busy (no reason shown). */
  busy?: boolean;
  /** Why the control is disabled; ignored while enabled or busy. */
  disabledReason?: string | null;
  children?: ReactNode;
};

export const CanonicalActionButton = forwardRef<
  HTMLButtonElement,
  CanonicalActionButtonProps
>(function CanonicalActionButton(
  {
    variant = "secondary",
    busy = false,
    disabledReason,
    disabled,
    className,
    type = "button",
    children,
    ...rest
  },
  ref,
) {
  const reasonId = useId();
  const reason =
    Boolean(disabled) && !busy && typeof disabledReason === "string" && disabledReason.trim()
      ? disabledReason.trim()
      : null;
  const describedBy =
    [rest["aria-describedby"], reason ? reasonId : null].filter(Boolean).join(" ") ||
    undefined;
  return (
    <>
      <button
        {...rest}
        ref={ref}
        type={type}
        disabled={Boolean(disabled) || busy}
        aria-busy={busy || undefined}
        aria-describedby={describedBy}
        title={rest.title ?? reason ?? undefined}
        data-disabled-reason={reason ?? undefined}
        data-action-variant={variant}
        className={[VARIANT_CLASS[variant], className].filter(Boolean).join(" ")}
      >
        {children}
      </button>
      {reason ? (
        <span id={reasonId} className="app-visually-hidden">
          {reason}
        </span>
      ) : null}
    </>
  );
});
