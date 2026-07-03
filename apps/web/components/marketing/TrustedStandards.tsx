import {
  FingerprintPattern,
  Clock,
  Anchor,
  KeyRound,
  Lock,
  Link2,
} from "lucide-react";

const STANDARDS = [
  { label: "SHA-256", sub: "Content fingerprint", Icon: FingerprintPattern },
  { label: "RFC 3161", sub: "Trusted timestamp", Icon: Clock },
  { label: "OpenTimestamps", sub: "Bitcoin anchoring", Icon: Anchor },
  { label: "ED25519", sub: "Digital signatures", Icon: KeyRound },
  { label: "S3 Object Lock", sub: "Immutable storage", Icon: Lock },
  { label: "Custody Chain", sub: "Linked hash log", Icon: Link2 },
];

export function TrustedStandards() {
  return (
    <section
      className="relative border-y border-[var(--proovra-border-warm)] bg-[var(--proovra-page-bg)]"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 py-8 lg:px-10 2xl:px-12 lg:py-10">
        <div className="mb-5 flex items-center justify-center gap-3">
          <span className="h-px w-10 bg-[#CBD5E1]" />
          <p className="text-center text-[11px] font-semibold uppercase tracking-[0.22em] text-[#475569]">
            Built on trusted standards
          </p>
          <span className="h-px w-10 bg-[#CBD5E1]" />
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 lg:gap-3">
          {STANDARDS.map(({ label, sub, Icon }) => (
            <div
              key={label}
              className="group flex flex-col items-center gap-1.5 rounded-2xl border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] px-2 py-3 text-center shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-all hover:-translate-y-0.5 hover:border-[var(--proovra-border-warm-hover)] hover:shadow-[0_6px_16px_rgba(15,23,42,0.05)]"
            >
              <span
                className="flex h-8 w-8 items-center justify-center rounded-xl"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(124,58,237,0.10), rgba(37,99,235,0.10))",
                }}
              >
                <Icon size={14} className="text-[#2563EB]" />
              </span>
              <div className="flex flex-col leading-tight">
                <span className="whitespace-nowrap text-[12.5px] font-bold tracking-tight text-[#0F172A]">
                  {label}
                </span>
                <span className="text-[10.5px] text-[#64748B]">{sub}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
