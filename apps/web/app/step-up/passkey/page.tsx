/**
 * /step-up/passkey — the SYSTEM-BROWSER half of a passkey step-up the mobile
 * app started (2026-10-28).
 *
 * PUBLIC BY DESIGN. The system browser holds no PROOVRA session, so this page
 * lives outside the `(app)` tree (no app shell, no session gate) and the
 * middleware passes it through on either host. What authorises it is not a
 * session: it is the single-use handoff token in the URL FRAGMENT (which no
 * browser ever sends to a server) plus the person's own passkey. Completing
 * the challenge here can only APPROVE it; spending the approval still needs
 * the app session that started it.
 *
 * Never indexed: the URL is a short-lived capability.
 */
import type { Metadata } from "next";

import { PasskeyHandoff } from "./PasskeyHandoff";

export const metadata: Metadata = {
  title: "Confirm with your passkey · PROOVRA",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function StepUpPasskeyPage() {
  return <PasskeyHandoff />;
}
