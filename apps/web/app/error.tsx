"use client";

import { useEffect } from "react";
import { Button } from "../components/ui";
import { captureException } from "../lib/sentry";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, { feature: "web_global_error" });
  }, [error]);

  return (
    <div className="page">
      <div className="section" style={{ textAlign: "center" }}>
        <h1 style={{ marginBottom: 8 }}>Something went wrong</h1>
        <p style={{ color: "#64748b" }}>
          An unexpected error occurred. You can try reloading the page.
        </p>
        <div style={{ marginTop: 16 }}>
          <Button onClick={reset}>Try again</Button>
        </div>
      </div>
    </div>
  );
}
