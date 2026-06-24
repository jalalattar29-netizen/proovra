// Shared marketing CTA button classes — single source of truth for the
// public marketing surfaces (Solutions, header, request-demo, contact-
// sales, verify-demo). Tokens are derived from the homepage hero pattern
// (apps/web/components/marketing/HeroSection.tsx L424-438).
//
// Four semantic variants:
//   - primaryDark      : deep PROOVRA navy, white text. Used for the
//                        primary "next step" action on dark heroes and
//                        as the persistent dark CTA in the header.
//   - secondaryLight   : white surface, slate-900 text. Used for the
//                        light/quiet companion action on dark heroes.
//   - purpleSecondary  : white surface, brand purple text. Used on the
//                        request-demo + contact-sales pages where the
//                        page is already "in" the demo/sales flow and
//                        the CTAs deflect to adjacent surfaces (pricing,
//                        contact, etc.) without competing with the form.
//   - heroSecondary    : white surface, brand blue border + text. The
//                        canonical companion to the dark primary on
//                        light hero/landing-content surfaces (Verify,
//                        Offline Verifier, Platform, Technology,
//                        Solutions, Why PROOVRA, Trust, Support, FAQ,
//                        homepage hero). Source of truth: the secondary
//                        on /verify and /offline-verifier heroes.
//                        DO NOT use inside final-CTA panels, footer,
//                        pricing CTA blocks, dashboard, or form submits.
//
// These are deliberately string constants rather than a Button component
// so consumers can compose them with extra utility classes (gap, width,
// arrow icons) without prop drilling.

export const MARKETING_BTN = {
  primaryDark: [
    "inline-flex items-center justify-center gap-2",
    "whitespace-nowrap rounded-2xl",
    "bg-[#0B1F5E] px-6 py-3.5",
    "text-[15px] font-semibold text-white",
    "shadow-[0_12px_30px_rgba(11,31,94,0.28)]",
    "transition-all duration-200",
    "hover:bg-[#0a1c54] hover:-translate-y-0.5",
    "hover:shadow-[0_18px_36px_rgba(11,31,94,0.34)]",
    "focus-visible:outline-none focus-visible:ring-2",
    "focus-visible:ring-[#5B21B6]/40 focus-visible:ring-offset-2",
  ].join(" "),

  secondaryLight: [
    "inline-flex items-center justify-center gap-2",
    "whitespace-nowrap rounded-2xl",
    "border border-[#E5E7EB] bg-white px-6 py-3.5",
    "text-[15px] font-semibold text-[#0F172A]",
    "shadow-[0_4px_12px_rgba(15,23,42,0.04)]",
    "transition-all duration-200",
    "hover:border-[#CBD5E1] hover:-translate-y-0.5",
    "hover:shadow-[0_8px_20px_rgba(15,23,42,0.06)]",
    "focus-visible:outline-none focus-visible:ring-2",
    "focus-visible:ring-[#5B21B6]/40 focus-visible:ring-offset-2",
  ].join(" "),

  purpleSecondary: [
    "inline-flex items-center justify-center gap-2",
    "whitespace-nowrap rounded-2xl",
    "border border-[#E9D5FF] bg-white px-6 py-3.5",
    "text-[15px] font-semibold text-[#5B21B6]",
    "shadow-[0_4px_12px_rgba(91,33,182,0.06)]",
    "transition-all duration-200",
    "hover:border-[#C4B5FD] hover:bg-[#FAF5FF] hover:-translate-y-0.5",
    "hover:shadow-[0_8px_20px_rgba(91,33,182,0.10)]",
    "focus-visible:outline-none focus-visible:ring-2",
    "focus-visible:ring-[#5B21B6]/40 focus-visible:ring-offset-2",
  ].join(" "),

  heroSecondary: [
    "inline-flex items-center justify-center gap-2",
    "whitespace-nowrap rounded-2xl",
    "border-2 border-[#2563EB] bg-white px-5 py-2.5",
    "text-[14px] font-semibold text-[#2563EB]",
    "transition-all duration-200",
    "hover:bg-[#EEF6FF] hover:-translate-y-0.5",
    "focus-visible:outline-none focus-visible:ring-2",
    "focus-visible:ring-[#2563EB]/40 focus-visible:ring-offset-2",
  ].join(" "),
} as const;
