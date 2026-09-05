"use client";

/**
 * THE PASSWORD VISIBILITY CONTROL — one implementation, every auth screen.
 *
 * Sign in had no toggle at all. Register and Reset password each grew their
 * own: two private copies of the eye/eye-off SVGs and two copies of the same
 * twelve inline style properties, neither with a visible focus ring. Adding a
 * third copy to Sign in would have made the drift permanent, so the control
 * lives here and the screens consume it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES AND DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It is UI ONLY. It owns no value, reads no value, and stores nothing. The
 * caller keeps the password in its own state exactly as before and swaps the
 * input's `type` between "password" and "text"; this component renders the
 * button that flips a boolean. It cannot log, transmit, or persist a password
 * because it is never given one.
 *
 * `type="button"` is not decorative. Inside a <form> a bare <button> defaults
 * to submit, so an unspecified type here would send a half-typed sign-in
 * attempt every time somebody wanted to check what they had typed.
 *
 * ---------------------------------------------------------------------------
 * ACCESSIBILITY
 * ---------------------------------------------------------------------------
 *
 * A real <button>, so it is reachable and operable from the keyboard with no
 * handler of our own. `aria-pressed` carries the state, which is what a toggle
 * button is for, and `aria-label` changes with it so a screen reader announces
 * the ACTION ("Show password" / "Hide password") rather than a static noun.
 * The icon is `aria-hidden` — it would otherwise be announced as a second,
 * meaningless child.
 *
 * `aria-controls` points at the input so assistive technology can associate
 * the two, and the visible focus ring comes from `.auth-password-toggle` in
 * globals.css via `:focus-visible`, which keeps it off mouse clicks and on
 * keyboard traversal.
 */

import type { CSSProperties } from "react";

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 5c-5 0-9.27 3.11-11 7 1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7Zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"
      />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M2.39 1.73 1 3.14l3.11 3.11A12.7 12.7 0 0 0 1 12c1.73 3.89 6 7 11 7 1.83 0 3.55-.41 5.07-1.14L20.85 21l1.41-1.41L2.39 1.73ZM12 17a5 5 0 0 1-4.92-5.92l1.86 1.86A3 3 0 0 0 12 16l1.06-.06 1.86 1.86c-.61.13-1.26.2-1.92.2Zm.86-9.94 6.96 6.96A12.74 12.74 0 0 0 23 12c-1.73-3.89-6-7-11-7-.86 0-1.7.11-2.51.31l3.37 3.37Z"
      />
    </svg>
  );
}

export interface PasswordVisibilityToggleProps {
  /** Whether the password is currently readable. */
  visible: boolean;
  /** Flip it. The caller owns the state; this component owns nothing. */
  onToggle: () => void;
  /** `id` of the input this controls, for `aria-controls`. */
  controls: string;
  disabled?: boolean;
  style?: CSSProperties;
}

export function PasswordVisibilityToggle({
  visible,
  onToggle,
  controls,
  disabled,
  style,
}: PasswordVisibilityToggleProps) {
  const label = visible ? "Hide password" : "Show password";
  return (
    <button
      // Never a submit. See the header.
      type="button"
      className="auth-password-toggle"
      aria-label={label}
      title={label}
      aria-pressed={visible}
      aria-controls={controls}
      onClick={onToggle}
      disabled={disabled}
      data-testid="password-visibility-toggle"
      style={style}
    >
      {visible ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  );
}
