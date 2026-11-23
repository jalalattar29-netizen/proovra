"use client";

/**
 * Renders a `ReviewDestination`: a link when the destination opens here, a
 * "Switch to {workspace}" control when the active space is the only blocker,
 * and NOTHING when it would open a refusal. Never upgrade copy.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties, type ReactNode } from "react";

import { usePlatformContext } from "../../lib/platform-context";
import type { ReviewDestination } from "./reviewDestination";
import "./review-surfaces.css";

export function ReviewDestinationLink({
  destination,
  className,
  style,
  children,
  testId,
}: {
  destination: ReviewDestination;
  className?: string;
  style?: CSSProperties;
  /** Overrides the destination label for a link (a switch keeps its own words). */
  children?: ReactNode;
  testId?: string;
}) {
  const { switchWorkspace } = usePlatformContext();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!destination) return null;
  if (destination.kind === "link") {
    return (
      <Link
        href={destination.href}
        className={className}
        style={style}
        data-review-destination={destination.routeId}
        data-review-destination-kind="link"
        data-testid={testId}
      >
        {children ?? destination.label}
      </Link>
    );
  }
  return (
    <button
      type="button"
      // TEAM-UI-SPEC §1 — no inline colours on a control: a switch reads as a
      // text link through the scoped class unless the caller names one.
      className={className ?? "review-destination-switch"}
      style={style}
      disabled={busy}
      data-review-destination={destination.routeId}
      data-review-destination-kind="switch"
      data-testid={testId}
      onClick={() => {
        setBusy(true);
        void Promise.resolve(switchWorkspace(destination.workspaceId))
          .then((ok) => {
            // Navigate only after a switch that happened (false = refused or superseded).
            if (ok !== false) router.push(destination.href);
          })
          .finally(() => setBusy(false));
      }}
    >
      {destination.label}
    </button>
  );
}

export default ReviewDestinationLink;
