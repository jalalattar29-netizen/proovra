/**
 * /step-up/idp — starts the Organization sign-in that confirms a step-up
 * (IDP_REAUTH, 2026-10-28).
 *
 * PUBLIC BY DESIGN. It runs in a browser that may hold no PROOVRA session (the
 * system browser the app opens, or a popup), so it lives outside the `(app)`
 * tree and the middleware passes it through on either host. What authorises it
 * is the single-use handoff token in the URL FRAGMENT — never sent to any
 * server by the browser — and then the person's own sign-in at their
 * Organization's identity provider. Completing it can only APPROVE the
 * challenge; spending the approval still needs the session that started it.
 *
 * The round trip ENDS here too: the API returns the browser to this route
 * with `?result=approved|denied` (and a stable reason code — no secret).
 *
 * Never indexed: the URL is a short-lived capability.
 */
import type { Metadata } from "next";

import { IdpHandoff } from "./IdpHandoff";

export const metadata: Metadata = {
  title: "Confirm with your organization sign-in · PROOVRA",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function StepUpIdpPage() {
  return <IdpHandoff />;
}
