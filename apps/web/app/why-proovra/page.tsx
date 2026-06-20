import type { Metadata } from "next";
import { FileBadge, Camera, Briefcase, ShieldCheck, ScrollText, Globe2 } from "lucide-react";
import { MarketingPage } from "../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../components/marketing/page-shell/FeatureGrid";
import { ComparisonTable } from "../../components/marketing/page-shell/ComparisonTable";
import { PageCTA } from "../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Why PROOVRA — Move from files to Evidence Records",
  description:
    "Ordinary files lose context the moment they are sent. PROOVRA Evidence Records carry integrity signals, custody history, and independent verifiability — designed for review-sensitive work.",
};

const SHIFTS = [
  { title: "From ordinary files to Evidence Records", body: "Files lose context when shared. Evidence Records carry integrity signals and custody with them.", Icon: FileBadge, accent: "#2563EB" },
  { title: "From screenshots to verifiable records", body: "Screenshots are deniable. Cryptographic fingerprints and timestamps are not.", Icon: Camera, accent: "#7C3AED" },
  { title: "From scattered evidence to evidence operations", body: "Stop reconstructing custody from email threads. Make it a first-class system.", Icon: Briefcase, accent: "#06B6D4" },
  { title: "From trust-us to verify-yourself", body: "Reviewers should not have to take your word for it — they should check.", Icon: ShieldCheck, accent: "#F97316" },
  { title: "From ad-hoc audit trail to immutable log", body: "Spreadsheets and chat threads are not an audit trail. A linked-hash log is.", Icon: ScrollText, accent: "#EC4899" },
  { title: "From local proof to global verifiability", body: "Public verification URLs and signed packages let anyone independently confirm.", Icon: Globe2, accent: "#2563EB" },
];

function FlowLayer({
  label,
  items,
  bg,
  border,
  text,
}: {
  label: string;
  items: string[];
  bg: string;
  border: string;
  text: string;
}) {
  return (
    <div>
      <div className="text-center text-[10px] font-extrabold uppercase tracking-[0.2em] text-[#64748B]">
        {label}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2.5">
        {items.map((it) => (
          <span
            key={it}
            className="inline-flex items-center rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold"
            style={{ background: bg, borderColor: border, color: text }}
          >
            {it}
          </span>
        ))}
      </div>
    </div>
  );
}

function FlowConnector() {
  return (
    <div className="flex justify-center py-3 md:py-4" aria-hidden="true">
      <span
        className="block h-8 w-px"
        style={{
          background:
            "linear-gradient(180deg, rgba(15,23,42,0.18), rgba(15,23,42,0.04))",
        }}
      />
    </div>
  );
}

function TrustLayerInsideOrganization() {
  return (
    <section className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-[1120px] px-6 md:px-8">
        <div className="flex flex-col items-center text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white px-3.5 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#2563EB] shadow-[0_2px_8px_rgba(37,99,235,0.06)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
            Where PROOVRA fits
          </span>
          <h2 className="mx-auto mt-4 max-w-[880px] text-[1.75rem] font-bold leading-[1.14] tracking-[-0.02em] text-[#07132B] md:text-[2.15rem]">
            PROOVRA does not replace your workflow. It becomes the trust layer
            inside it.
          </h2>
          <p className="mx-auto mt-5 max-w-[820px] text-[14.5px] leading-[1.75] text-[#475569]">
            Most organizations already have evidence sources, case processes,
            review teams, legal requirements, storage systems, and reporting
            workflows. PROOVRA sits between your sources and your teams —
            before intake, during capture, across review, inside governance,
            and before reports or verification packages are shared.
          </p>
        </div>

        <div className="mx-auto mt-14 max-w-[920px]">
          <FlowLayer
            label="Evidence Sources"
            items={["Capture", "Intake", "External submissions"]}
            bg="rgba(6,182,212,0.10)"
            border="rgba(6,182,212,0.32)"
            text="#0E7490"
          />

          <FlowConnector />

          <div className="relative mx-auto max-w-[640px] overflow-hidden rounded-[20px] border border-[#E0E7FF] bg-white px-7 py-8 text-center shadow-[0_18px_50px_rgba(79,70,229,0.10)]">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(ellipse at 50% 100%, rgba(124,58,237,0.10), transparent 60%), radial-gradient(ellipse at 50% 0%, rgba(6,182,212,0.10), transparent 55%)",
              }}
            />
            <div className="relative">
              <div className="text-[10.5px] font-extrabold uppercase tracking-[0.2em] text-[#4F46E5]">
                PROOVRA Trust Layer
              </div>
              <div className="mt-2 text-[1.05rem] font-bold tracking-[-0.01em] text-[#07132B] md:text-[1.2rem]">
                Integrity · Custody · Verification
              </div>
              <div className="mt-2 text-[12.5px] leading-[1.55] text-[#475569]">
                Tamper-evident records, custody visibility, and independent
                verifiability — sitting between your sources and your teams.
              </div>
            </div>
          </div>

          <FlowConnector />

          <FlowLayer
            label="Teams"
            items={[
              "Legal",
              "Claims",
              "Investigations",
              "Compliance",
              "Review",
            ]}
            bg="rgba(37,99,235,0.08)"
            border="rgba(37,99,235,0.28)"
            text="#1D4ED8"
          />

          <FlowConnector />

          <FlowLayer
            label="Outputs"
            items={[
              "Reports",
              "Verification Packages",
              "Governance Records",
            ]}
            bg="rgba(124,58,237,0.08)"
            border="rgba(124,58,237,0.28)"
            text="#6D28D9"
          />
        </div>
      </div>
    </section>
  );
}

export default function WhyProovraPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Why PROOVRA"
        title="Files lose context."
        highlight="Evidence Records keep it."
        description="High-trust work runs on evidence, not files. PROOVRA turns digital artifacts into Evidence Records — structured, signed, time-anchored, and independently verifiable."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "See verification demo", href: MARKETING_LINKS.verifyDemo }}
      />
      <FeatureGrid
        eyebrow="Six shifts"
        title="What changes when evidence becomes an operations problem."
        items={SHIFTS}
        surface="soft"
        columns={3}
      />
      <TrustLayerInsideOrganization />
      <ComparisonTable
        eyebrow="Side by side"
        title="Ordinary files vs PROOVRA Evidence Records"
        leftHeader="Ordinary files"
        rightHeader="PROOVRA Evidence Records"
        rows={[
          { feature: "Independent integrity check", left: false, right: true },
          { feature: "Captured time context", left: false, right: true },
          { feature: "Linked-hash custody log", left: false, right: true },
          { feature: "Reviewer-ready PDF report", left: false, right: true },
          { feature: "Portable verification package", left: false, right: true },
          { feature: "Public verification URL", left: false, right: true },
          { feature: "Recipient can verify offline", left: false, right: true },
        ]}
      />
      <PageCTA
        title="Stop trusting files."
        highlight="Start verifying records."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
      />
    </MarketingPage>
  );
}
