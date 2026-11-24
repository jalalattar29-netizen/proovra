"use client";

/**
 * /auth/reauth-complete — the end of the separate sign-in window a privileged
 * action asked for (T-029, `reauth_required`).
 *
 * The page the person was working on stayed open, with what they typed. This
 * window only says so: go back there and choose Continue. It tries to close
 * itself when it was opened by that page; nothing here runs any action.
 */
import { useEffect, useState } from "react";

export default function ReauthCompletePage() {
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined" && window.opener) {
      try {
        window.close();
      } catch {
        /* a browser may refuse; the text below still says what to do */
      }
    }
    setTried(true);
  }, []);
  return (
    <main
      data-reauth-complete
      style={{ maxWidth: 480, margin: "64px auto", padding: "0 16px", fontSize: 15, lineHeight: 1.6 }}
    >
      <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>You&apos;re signed in again</h1>
      <p style={{ margin: 0 }}>
        Go back to the page you were working on and choose <strong>Continue</strong>. What you
        typed there is still there, and nothing ran while you were signing in.
      </p>
      {tried ? (
        <p style={{ margin: "12px 0 0", color: "#475569" }}>You can close this window.</p>
      ) : null}
    </main>
  );
}
