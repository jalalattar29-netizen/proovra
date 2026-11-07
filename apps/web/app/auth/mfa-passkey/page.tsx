/**
 * /auth/mfa-passkey — the SYSTEM-BROWSER half of a sign-in whose second factor
 * is the person's passkey, started by the mobile app (AUTH-LOCKOUT-NONTOTP).
 *
 * PUBLIC BY DESIGN, like /step-up/passkey: the browser holds no session. What
 * authorises it is the single-use handoff token in the URL FRAGMENT plus the
 * person's own passkey. Proving the passkey here only marks THAT sign-in's
 * challenge as answered; the app holding the sign-in completes it.
 *
 * Never indexed: the URL is a short-lived capability.
 */
import type { Metadata } from "next";

import { PasskeyHandoff } from "../../step-up/passkey/PasskeyHandoff";

export const metadata: Metadata = {
  title: "Sign in with your passkey · PROOVRA",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function SignInPasskeyHandoffPage() {
  return <PasskeyHandoff flow="sign-in" />;
}
