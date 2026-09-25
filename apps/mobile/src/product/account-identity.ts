/**
 * ACCOUNT IDENTITY FOR THE APP CHROME (T-09c / RC-10) — pure projections.
 *
 * THE DEFECT THIS SERVES
 * ----------------------
 * Native showed the signed-in identity NOWHERE in its chrome. The web renders
 * an avatar with the user's name in `AppAccountToolbar` on every authenticated
 * page (`:578-590`); on native a user could not tell which account they were in
 * without opening the Settings tab. With no workspace switcher in the chrome
 * either (until T-09b), "I am looking at the wrong data" was close to
 * undiagnosable from the UI.
 *
 * Pure — no React, no fetch — so the fallback chain is unit-testable without a
 * device, which is what a chrome-level string needs: it is on screen
 * constantly and must never be wrong.
 *
 * NOTHING HERE INVENTS A NAME. The chain is displayName → email → a neutral
 * placeholder. Guessing at someone's identity in the chrome is worse than
 * showing none.
 */

export interface AccountIdentityInput {
  readonly displayName?: string | null;
  readonly email?: string | null;
}

/**
 * Initials for the avatar fallback, mirroring the web's
 * `app-topbar-v2-avatar-fallback` (`AppAccountToolbar.tsx:583-586`).
 *
 * One word → its first two letters ("Jalal" → "JA").
 * Several → first letter of the first and last ("Jalal Attar" → "JA").
 * The email local-part is split on `.`/`_`/`-` too, so "jalal.attar@x.com"
 * yields "JA" rather than "JA" from "jalal" alone by accident.
 */
export function accountInitials(user: AccountIdentityInput | null): string {
  const source = user?.displayName?.trim() || user?.email?.split("@")[0]?.trim() || "";
  const words = source.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "•";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/** The name the account control announces to assistive technology. */
export function accountDisplayName(user: AccountIdentityInput | null): string {
  return user?.displayName?.trim() || user?.email?.trim() || "Account";
}
