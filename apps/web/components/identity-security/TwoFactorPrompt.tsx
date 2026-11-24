"use client";

/**
 * T-034 (stage B) — A NON-BLOCKING PROMPT TO ENROL A SECOND FACTOR, BEFORE IT
 * IS NEEDED.
 *
 * In a Team workspace a second factor is what review step-up asks for: when a
 * workspace rule is on, when a sign-in looks unusual, and always when saving
 * Review settings. Without one, the first time a person learns this was a
 * refusal in the middle of a verdict. This card says it on Home, links to the
 * existing Security enrolment (and back), and disappears once a factor exists.
 *
 * It reads the same canonical factor list the Settings summary reads; a failed
 * read shows nothing (the server still decides at the action).
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { stepUpEnrollmentHref } from "./StepUpModal";

export function TwoFactorPrompt({ enabled, returnTo = "/home" }: { enabled: boolean; returnTo?: string }) {
  const [hasMfa, setHasMfa] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    apiFetch("/v1/identity/mfa/factors")
      .then((r: { hasMfa?: boolean } | null) => {
        if (alive) setHasMfa(r ? Boolean(r.hasMfa) : null);
      })
      .catch(() => {
        if (alive) setHasMfa(null);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  if (!enabled || hasMfa !== false) return null;
  return (
    <section className="app-panel" data-two-factor-prompt aria-labelledby="two-factor-prompt-title">
      <div className="app-panel__head">
        <h2 className="app-panel__title" id="two-factor-prompt-title">
          Enrol two-factor authentication
        </h2>
      </div>
      <div className="app-panel__body">
        <p className="app-field-help" style={{ marginTop: 0 }}>
          Your account has no second factor yet. Review decisions can ask for one when your workspace
          requires it or a sign-in looks unusual, and saving Review settings always does. Set one up now
          so a review is never held up.
        </p>
        <Link href={stepUpEnrollmentHref(returnTo)} className="app-secondary-action" data-two-factor-prompt-link>
          Set up two-factor
        </Link>
      </div>
    </section>
  );
}

export default TwoFactorPrompt;
