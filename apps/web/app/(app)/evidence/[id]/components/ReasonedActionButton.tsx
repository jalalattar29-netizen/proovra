"use client";

/**
 * A native action button that states WHY it is unavailable.
 *
 * The Evidence Detail route renders native buttons with the canonical app-*
 * action classes (the shared `Button` component is not used on this route),
 * so this carries the same disabled-reason contract `Button` does: when the
 * control is disabled and a reason is given, the reason is shown beside it,
 * linked as the accessible description, offered as the hover title and
 * exposed as `data-disabled-reason`.
 */

import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";

export function ReasonedActionButton({
  disabledReason,
  busy = false,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  disabledReason?: string | null;
  busy?: boolean;
  children: ReactNode;
}) {
  const reasonId = useId();
  const isDisabled = Boolean(disabled) || busy;
  const reason =
    Boolean(disabled) && !busy && disabledReason && disabledReason.trim()
      ? disabledReason.trim()
      : null;
  return (
    <>
      <button
        type="button"
        {...rest}
        disabled={isDisabled}
        aria-busy={busy || undefined}
        aria-describedby={reason ? reasonId : rest["aria-describedby"]}
        title={reason ?? rest.title}
        data-disabled-reason={reason ?? undefined}
      >
        {children}
      </button>
      {reason ? (
        <span id={reasonId} className="app-hint" data-reasoned-action-reason>
          {reason}
        </span>
      ) : null}
    </>
  );
}
