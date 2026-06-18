import Link from "next/link";
import {
  FingerprintPattern,
  Clock,
  Anchor,
  KeyRound,
  Package,
  Link2,
  ArrowRight,
} from "lucide-react";
import { MARKETING_LINKS } from "./tokens";
import { SectionBadge } from "./SectionBadge";

const PILLARS = [
  {
    title: "Cryptographic Hashing",
    body: "SHA-256 fingerprinting for every evidence record — content-addressed and tamper-evident.",
    Icon: FingerprintPattern,
    accent: "#F97316",
  },
  {
    title: "Trusted Timestamping",
    body: "RFC 3161 timestamping authority integration for independent, time-anchored proof.",
    Icon: Clock,
    accent: "#06B6D4",
  },
  {
    title: "OpenTimestamps (OTS)",
    body: "Bitcoin-anchored timestamps via OpenTimestamps for public, independent verifiability.",
    Icon: Anchor,
    accent: "#A855F7",
  },
  {
    title: "Digital Signatures",
    body: "ED25519 signatures on every evidence fingerprint with versioned keys and optional KMS.",
    Icon: KeyRound,
    accent: "#22D3EE",
  },
  {
    title: "Verification Packages",
    body: "Portable, signed bundles with manifest, hashes, signatures, and custody chain.",
    Icon: Package,
    accent: "#EC4899",
  },
  {
    title: "Chain of Custody",
    body: "Linked-hash custody log records every action with actor, time, and prior-event binding.",
    Icon: Link2,
    accent: "#FACC15",
  },
];

export function SecurityMethodology() {
  return (
    <section
      id="security-methodology"
      className="relative overflow-hidden text-white"
      style={{
        fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif",
        background:
          "linear-gradient(135deg, #0B1F5E 0%, #1E1B4B 50%, #2E1065 100%)",
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-32 top-0 h-[420px] w-[520px] rounded-full opacity-40 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, rgba(124,58,237,0.55), transparent 70%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 bottom-0 h-[380px] w-[520px] rounded-full opacity-35 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, rgba(6,182,212,0.55), transparent 70%)",
        }}
      />

      <div className="relative mx-auto grid max-w-[1480px] grid-cols-1 gap-12 px-5 md:px-7 py-20 lg:grid-cols-[1fr_2.2fr] lg:gap-16 lg:px-10 2xl:px-12 lg:py-30">
        <div className="flex flex-col gap-5">
          <SectionBadge>Built on trust. Backed by technology.</SectionBadge>
          <h2 className="text-[30px] font-extrabold leading-[1.1] tracking-[-0.02em] text-white md:text-[36px] lg:text-[42px]">
            Unmatched security. <br />
            <span className="text-[#C4B5FD]">Uncompromising integrity.</span>
          </h2>
          <p className="max-w-md text-[15.5px] leading-[1.7] text-white/70">
            PROOVRA&apos;s infrastructure ensures your evidence remains authentic,
            verifiable, and tamper-evident at every layer of the lifecycle.
          </p>
          <Link
            href={MARKETING_LINKS.trustCenter}
            className="inline-flex w-fit items-center gap-2 rounded-2xl bg-[#7C3AED] px-5 py-3 text-[14.5px] font-semibold text-white shadow-[0_12px_28px_rgba(124,58,237,0.40)] transition-all hover:bg-[#6d28d9]"
          >
            Explore our security
            <ArrowRight size={16} />
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map(({ title, body, Icon, accent }) => (
            <div
              key={title}
              className="group rounded-[20px] border border-white/10 bg-white/[0.04] p-5 backdrop-blur-sm transition-all hover:-translate-y-1 hover:border-white/20 hover:bg-white/[0.06]"
            >
              <span
                className="flex h-11 w-11 items-center justify-center rounded-2xl"
                style={{
                  background: `${accent}26`,
                  boxShadow: `inset 0 0 0 1px ${accent}40`,
                }}
              >
                <Icon size={20} style={{ color: accent }} />
              </span>
              <h3 className="mt-4 text-[16px] font-bold tracking-tight text-white">
                {title}
              </h3>
              <p className="mt-1.5 text-[13px] leading-[1.6] text-white/75">
                {body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
