/**
 * Operations workbench — semantic icon set.
 *
 * Every icon is `stroke="currentColor"` and `aria-hidden`: colour comes from
 * the surrounding class, and meaning always comes from the adjacent text. No
 * emoji, no colour literals, no icon-only controls.
 */

import * as React from "react";

type IconProps = { size?: number; className?: string };

function Svg({
  size = 16,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** The page mark: a pulse line. Operations watches for conditions. */
export function IconOperations(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </Svg>
  );
}

export function IconSearch(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </Svg>
  );
}

export function IconDots(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="5" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="12" cy="19" r="1.4" />
    </Svg>
  );
}

export function IconRefresh(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 11a8 8 0 1 0-.6 4" />
      <path d="M20 5v6h-6" />
    </Svg>
  );
}

export function IconClose(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function IconExternal(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m5 13 4 4L19 7" />
    </Svg>
  );
}

export function IconCopy(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </Svg>
  );
}

/**
 * The spinner is the only icon that animates, and it declares its own
 * reduced-motion behaviour in CSS rather than here — a component that decides
 * whether to animate cannot be overridden by a user who has asked the whole
 * system not to.
 */
export function IconSpinner(p: IconProps) {
  return (
    <Svg {...p} className={`opsw-spin${p.className ? ` ${p.className}` : ""}`}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Svg>
  );
}
