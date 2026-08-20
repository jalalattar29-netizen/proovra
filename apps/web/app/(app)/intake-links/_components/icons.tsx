/**
 * Intake links — semantic icon set.
 *
 * Every icon is `stroke="currentColor"` and `aria-hidden`: colour comes from
 * the surrounding class, and meaning always comes from the adjacent text. No
 * emoji, no colour literals, no icon-only controls.
 */

import * as React from "react";

import type { RequestPurposeIcon } from "../../../../lib/intake-links/catalog";

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

export function IconLink(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Svg>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
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

export function IconClose(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  );
}

export function IconChevronPrev(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m15 18-6-6 6-6" />
    </Svg>
  );
}

export function IconChevronNext(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m9 18 6-6-6-6" />
    </Svg>
  );
}

export function IconDots(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </Svg>
  );
}

export function IconSpinner(p: IconProps) {
  return (
    <svg
      width={p.size ?? 14}
      height={p.size ?? 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      className={`app-spinner${p.className ? ` ${p.className}` : ""}`}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Delivery channels
// ---------------------------------------------------------------------------

export function IconMail(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </Svg>
  );
}

export function IconSms(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
    </Svg>
  );
}

export function IconWhatsapp(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.45L3.5 20.5l1.6-4.8A8.5 8.5 0 1 1 21 11.5Z" />
      <path d="M8.8 9.2c.3 2.6 2.4 4.7 5 5l.9-1.4 1.8.8" />
    </Svg>
  );
}

export function DeliveryChannelIcon({
  icon,
  size,
}: {
  icon: "link" | "mail" | "sms" | "whatsapp";
  size?: number;
}) {
  switch (icon) {
    case "mail":
      return <IconMail size={size} />;
    case "sms":
      return <IconSms size={size} />;
    case "whatsapp":
      return <IconWhatsapp size={size} />;
    case "link":
    default:
      return <IconLink size={size} />;
  }
}

// ---------------------------------------------------------------------------
// Accepted file types
// ---------------------------------------------------------------------------

export function AcceptedKindIcon({
  icon,
  size = 18,
}: {
  icon: "photo" | "video" | "audio" | "document";
  size?: number;
}) {
  switch (icon) {
    case "photo":
      return (
        <Svg size={size}>
          <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
          <circle cx="8.5" cy="10" r="1.6" />
          <path d="m4 17.5 5-4.5 4 3.5 3-2.5 4 3.5" />
        </Svg>
      );
    case "video":
      return (
        <Svg size={size}>
          <rect x="2.5" y="5.5" width="13" height="13" rx="2.5" />
          <path d="m15.5 10.5 6-3v9l-6-3z" />
        </Svg>
      );
    case "audio":
      return (
        <Svg size={size}>
          <path d="M12 3v13" />
          <path d="M8 7v7M16 7v7M4 10v3M20 10v3" />
          <circle cx="12" cy="18.5" r="2.5" />
        </Svg>
      );
    case "document":
    default:
      return (
        <Svg size={size}>
          <path d="M14 2.5H7.5A2 2 0 0 0 5.5 4.5v15a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z" />
          <path d="M14 2.5V7h4.5" />
          <path d="M9 12.5h6M9 16h4" />
        </Svg>
      );
  }
}

// ---------------------------------------------------------------------------
// Request purposes
// ---------------------------------------------------------------------------

export function RequestPurposeGlyph({
  icon,
  size = 18,
}: {
  icon: RequestPurposeIcon;
  size?: number;
}) {
  switch (icon) {
    case "media":
      return <AcceptedKindIcon icon="photo" size={size} />;
    case "document":
      return <AcceptedKindIcon icon="document" size={size} />;
    case "insurance":
      return (
        <Svg size={size}>
          <path d="M12 2.8 4.5 6v6.2c0 4.4 3.1 7.6 7.5 9 4.4-1.4 7.5-4.6 7.5-9V6z" />
          <path d="m9 12 2.2 2.2L15.5 10" />
        </Svg>
      );
    case "legal":
      return (
        <Svg size={size}>
          <path d="M12 3v18" />
          <path d="M5 7h14" />
          <path d="M7.5 7 4.5 14h6zM16.5 7l-3 7h6z" />
        </Svg>
      );
    case "property":
      return (
        <Svg size={size}>
          <path d="M3.5 10.5 12 3.5l8.5 7" />
          <path d="M5.5 9.8V20h13V9.8" />
          <path d="M10 20v-5.5h4V20" />
        </Svg>
      );
    case "incident":
      return (
        <Svg size={size}>
          <path d="M12 3.5 21 19H3z" />
          <path d="M12 9.5v4M12 16.5h.01" />
        </Svg>
      );
    case "compliance":
      return (
        <Svg size={size}>
          <rect x="5" y="3.5" width="14" height="17" rx="2.5" />
          <path d="M9 3.5h6v3H9z" />
          <path d="m9.5 12.5 1.8 1.8 3.4-3.6" />
        </Svg>
      );
    case "source":
      return (
        <Svg size={size}>
          <circle cx="12" cy="8.5" r="3.5" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </Svg>
      );
    case "general":
    default:
      return (
        <Svg size={size}>
          <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
          <path d="M3.5 10h17" />
          <path d="M8 14.5h4" />
        </Svg>
      );
  }
}
