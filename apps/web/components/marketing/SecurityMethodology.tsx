import Link from "next/link";
import {
  Fingerprint,
  Clock3,
  Share2,
  PenLine,
  PackageCheck,
  GitBranch,
  ArrowRight,
} from "lucide-react";
import { MARKETING_LINKS } from "./tokens";
import { SectionBadge } from "./SectionBadge";

const PILLARS = [
  {
    title: "Cryptographic Hashing",
    body: "SHA-256 fingerprinting for every evidence record — content-addressed and tamper-evident.",
    Icon: Fingerprint,
    gradientId: "hashingGradient",
  },
  {
    title: "Trusted Timestamping",
    body: "RFC 3161 timestamping authority integration for independent, time-anchored proof.",
Icon: Clock3,
gradientId: "timestampGradient",
  },
  {
    title: "OpenTimestamps (OTS)",
    body: "Bitcoin-anchored timestamps via OpenTimestamps for public, independent verifiability.",
Icon: Share2,
gradientId: "otsGradient",
  },
  {
    title: "Digital Signatures",
    body: "ED25519 signatures on every evidence fingerprint with versioned keys and optional KMS.",
    Icon: PenLine,
    gradientId: "signaturesGradient",
  },
  {
    title: "Verification Packages",
    body: "Portable, signed bundles with manifest, hashes, signatures, and custody chain.",
Icon: PackageCheck,
    gradientId: "packagesGradient",
  },
  {
    title: "Chain of Custody",
    body: "Linked-hash custody log records every action with actor, time, and prior-event binding.",
    Icon: GitBranch,
    gradientId: "custodyGradient",
  },
];

const ICON_BG = "rgba(168, 85, 247, 0.075)";
const ICON_BORDER = "rgba(236, 72, 153, 0.22)";

export function SecurityMethodology() {
  return (
    <section
      id="security-methodology"
      className="relative overflow-hidden text-white"
      style={{
        fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif",
        background:
          "linear-gradient(115deg, #050B2E 0%, #07144A 28%, #10145A 55%, #24105A 78%, #3B0F75 100%)",
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 78% 45%, rgba(124,58,237,0.18), transparent 48%)",
        }}
      />

      <div className="relative mx-auto grid max-w-[1480px] grid-cols-1 gap-12 px-5 md:px-7 py-20 lg:grid-cols-[1fr_2.2fr] lg:gap-16 lg:px-10 2xl:px-12 lg:py-30">
        <div className="flex flex-col gap-5">
          <SectionBadge>Built on trust. Backed by technology.</SectionBadge>
          <h2 className="text-[30px] font-extrabold leading-[1.1] tracking-[-0.02em] text-white md:text-[36px] lg:text-[42px]">
            Unmatched security. <br />
            <span className="text-[#C4B5FD]">Uncompromising integrity.</span>
          </h2>
          <p
            className="max-w-md text-[15.5px] leading-[1.7]"
            style={{ color: "rgba(255, 255, 255, 0.72)" }}
          >
            PROOVRA&apos;s infrastructure ensures your evidence remains authentic,
            verifiable, and tamper-evident at every layer of the lifecycle.
          </p>
          <Link
            href={MARKETING_LINKS.trustCenter}
className="inline-flex w-fit items-center gap-2 rounded-[14px] px-5 py-3 text-[14.5px] font-semibold text-white transition-transform hover:-translate-y-0.5"
style={{
  background:
    "linear-gradient(135deg, #4C1D95 0%, #5B21B6 45%, #6D28D9 100%)",
  boxShadow: "0 14px 28px rgba(76, 29, 149, 0.28)",
}}
          >
            Explore our security
            <ArrowRight size={16} />
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
{PILLARS.map(({ title, body, Icon, gradientId }) => (
              <div
              key={title}
              className="group rounded-[20px] p-5 transition-all hover:-translate-y-1"
              style={{
                background: "rgba(255, 255, 255, 0.055)",
                border: "1px solid rgba(255, 255, 255, 0.10)",
              }}
            >
<span
  className="flex h-11 w-11 items-center justify-center rounded-[14px]"
  style={{
    background: ICON_BG,
    border: `1px solid ${ICON_BORDER}`,
    boxShadow:
      "inset 0 0 0 1px rgba(255,255,255,0.035), 0 0 22px rgba(236,72,153,0.14)",
  }}
>
  <svg width="0" height="0" aria-hidden="true" focusable="false">
    <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stopColor="#F97316" />
      <stop offset="38%" stopColor="#EC4899" />
      <stop offset="72%" stopColor="#D946EF" />
      <stop offset="100%" stopColor="#8B5CF6" />
    </linearGradient>
  </svg>

  <Icon
    size={25}
    strokeWidth={1.85}
    fill="none"
    stroke={`url(#${gradientId})`}
  />
</span>
              <h3 className="mt-4 text-[16px] font-bold tracking-tight text-white">
                {title}
              </h3>
              <p
                className="mt-1.5 text-[13px] leading-[1.6]"
                style={{ color: "rgba(255, 255, 255, 0.68)" }}
              >
                {body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
