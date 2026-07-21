/**
 * SystemStateSymbol — the one restrained line-symbol set for canonical
 * system states (2026-07-21).
 *
 * Deliberately NOT a childish icon chip: no enclosing filled circle, no
 * saturated colour, no gradient, no 3D, no illustration. A single
 * neutral stroke glyph (~48px) that inherits `currentColor` so it reads
 * as calm, operational chrome. One glyph per semantic family; unknown
 * kinds fall back to the document/route mark.
 */

import type { SystemStateKind } from "./ProovraSystemState";

export function SystemStateSymbol({
  kind,
  size = 48,
}: {
  kind: SystemStateKind;
  size?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 48 48",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  // forbidden / capability → access boundary (lock)
  if (kind === "forbidden" || kind === "capability-unavailable") {
    return (
      <svg {...common}>
        <rect x="12" y="21" width="24" height="16" rx="2.5" />
        <path d="M17 21v-4a7 7 0 0 1 14 0v4" />
        <path d="M24 28v3" />
      </svg>
    );
  }

  // removed → document with a strike (archived / gone)
  if (kind === "removed") {
    return (
      <svg {...common}>
        <path d="M15 8h12l6 6v22a2 2 0 0 1-2 2H15a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z" />
        <path d="M27 8v6h6" />
        <path d="M17 40 33 12" />
      </svg>
    );
  }

  // server-error → system node / signal
  if (kind === "server-error" || kind === "unavailable") {
    return (
      <svg {...common}>
        <rect x="10" y="12" width="28" height="10" rx="2" />
        <rect x="10" y="26" width="28" height="10" rx="2" />
        <path d="M15 17h.02M15 31h.02" />
        <path d="M24 22v4" />
      </svg>
    );
  }

  // workspace / organization → building boundary
  if (kind === "workspace-unavailable" || kind === "organization-unavailable") {
    return (
      <svg {...common}>
        <path d="M12 38V12a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v26" />
        <path d="M28 20h6a2 2 0 0 1 2 2v16" />
        <path d="M10 38h28" />
        <path d="M17 17h6M17 23h6M17 29h6M33 26h.02M33 32h.02" />
      </svg>
    );
  }

  // invitation / token → mail + clock
  if (
    kind === "invitation-expired" ||
    kind === "invitation-invalid" ||
    kind === "invitation-revoked" ||
    kind === "token-expired"
  ) {
    return (
      <svg {...common}>
        <path d="M10 14h20a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V16a2 2 0 0 1 2-2Z" />
        <path d="M8.5 15 20 24l11.5-9" />
        <circle cx="35" cy="33" r="6" />
        <path d="M35 30v3l2 1.5" />
      </svg>
    );
  }

  // default: not-found → document + route/search mark
  return (
    <svg {...common}>
      <path d="M15 8h12l6 6v13" />
      <path d="M27 8v6h6" />
      <path d="M15 8a2 2 0 0 0-2 2v28a2 2 0 0 0 2 2h9" />
      <circle cx="32" cy="33" r="5.5" />
      <path d="m36 37 3 3" />
    </svg>
  );
}
