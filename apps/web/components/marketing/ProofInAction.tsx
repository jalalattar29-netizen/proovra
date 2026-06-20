import Link from "next/link";
import {
  ArrowRight,
  ShieldCheck,
  FingerprintPattern,
  Clock,
  Signature,
  CircleCheck,
  Play,
} from "lucide-react";
import { MARKETING_ASSETS, MARKETING_LINKS } from "./tokens";
import { SectionBadge } from "./SectionBadge";

export function ProofInAction() {
  return (
    <section
      className="relative bg-[var(--proovra-page-bg)]"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <div className="mx-auto grid max-w-[1480px] grid-cols-1 items-center gap-10 px-5 md:px-7 py-20 lg:grid-cols-[0.9fr_1.7fr] lg:gap-12 lg:px-10 2xl:px-12 lg:py-28">
        <div className="flex flex-col gap-5">
          <SectionBadge>Public verification</SectionBadge>
          <h2 className="text-[30px] font-extrabold leading-[1.08] tracking-[-0.02em] text-[#0F172A] md:text-[36px] lg:text-[42px]">
            See proof in action.
          </h2>
          <p className="max-w-sm text-[15.5px] leading-[1.6] text-[#475569]">
            Open a sample verification page to see how PROOVRA records integrity
            signals end to end.
          </p>
          <div>
            <Link
              href={MARKETING_LINKS.verifyDemo}
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-2xl bg-[#0B1F5E] px-5 py-3 text-[14px] font-semibold text-white shadow-[0_10px_24px_rgba(11,31,94,0.22)] transition-all hover:bg-[#0a1c54]"
            >
              Open sample verification
              <ArrowRight size={15} />
            </Link>
          </div>
        </div>

        <div className="rounded-[24px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] shadow-[0_24px_60px_rgba(15,23,42,0.10)]">
          <div className="flex items-center gap-2 border-b border-[var(--proovra-border-warm)] px-4 py-3">
            <div className="flex gap-1.5">
              <span className="h-3 w-3 rounded-full bg-[#FF5F57]" />
              <span className="h-3 w-3 rounded-full bg-[#FEBC2E]" />
              <span className="h-3 w-3 rounded-full bg-[#28C840]" />
            </div>
            <div className="ml-3 flex h-7 flex-1 items-center gap-2 rounded-lg bg-[#F1F5F9] px-3 text-[12px] text-[#475569]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#10B981]" />
              verify.proovra.com/sample/7a3f9b21
            </div>
          </div>

          <div className="grid grid-cols-1 gap-0 md:grid-cols-[1.1fr_1fr]">
            <div className="relative aspect-[16/10] w-full overflow-hidden bg-[#0F172A] md:aspect-auto">
              <img
                src={MARKETING_ASSETS.useCases.carRentalReturn}
                alt="Sample verification: car rental return evidence record"
                loading="lazy"
                className="h-full w-full object-cover"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(15,23,42,0) 60%, rgba(15,23,42,0.45) 100%)",
                }}
              />
              <span className="pointer-events-none absolute left-4 top-4 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1 text-[11.5px] font-semibold text-[#0F172A]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#10B981]" />
                Verified sample
              </span>
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--proovra-surface)] text-[#0B1F5E] shadow-[0_8px_24px_rgba(15,23,42,0.20)]"
              >
                <Play size={20} fill="currentColor" />
              </span>
            </div>

            <div className="flex flex-col gap-4 p-6">
              <div className="flex items-start gap-3">
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-2xl"
                  style={{ background: "rgba(16,185,129,0.10)" }}
                >
                  <ShieldCheck size={20} className="text-[#10B981]" />
                </span>
                <div>
                  <h3 className="text-[17px] font-bold text-[#10B981]">
                    Evidence Verified
                  </h3>
                  <p className="mt-0.5 text-[12.5px] text-[#475569]">
                    Verification signals match the recorded integrity signals.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2.5 text-[12.5px]">
                {[
                  {
                    label: "Hash (SHA-256)",
                    value: "7A3F9B21E1FC01…A8027380CE60",
                    Icon: FingerprintPattern,
                  },
                  {
                    label: "Timestamp",
                    value: "2024-05-31 14:28:31 UTC",
                    Icon: Clock,
                  },
                  {
                    label: "Signer",
                    value: "Proovra Platform",
                    Icon: Signature,
                  },
                  {
                    label: "Status",
                    value: "Valid",
                    Icon: CircleCheck,
                    valid: true,
                  },
                ].map(({ label, value, Icon, valid }) => (
                  <div
                    key={label}
                    className="flex items-center justify-between rounded-xl border border-[var(--proovra-border-warm)] bg-[var(--proovra-page-bg-soft)] px-3 py-2.5"
                  >
                    <span className="flex items-center gap-1.5 text-[#475569]">
                      <Icon size={13} className="text-[#2563EB]" />
                      {label}
                    </span>
                    <span
                      className={`truncate font-semibold ${valid ? "text-[#10B981]" : "text-[#0F172A]"}`}
                      style={{ maxWidth: "60%" }}
                    >
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
