"use client";

import { SilverWatermarkSection } from "./SilverWatermarkSection";
import Link from "next/link";
import { Icons } from "./icons";

type TrustCardProps = {
  icon: React.ReactNode;
  title: string;
  body: string;
};

function SilverCardShell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`landing-v2-card group relative overflow-hidden rounded-[24px] sm:rounded-[28px] border border-[#4f706b]/44 shadow-[0_18px_38px_rgba(0,0,0,0.07),inset_0_1px_0_rgba(255,255,255,0.48)] ${className}`}
    >
      <img
        src="/images/panel-silver.webp.png"
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-center"
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />
      <div className="relative z-10 min-w-0">{children}</div>
    </div>
  );
}

function IconBadge({
  children,
  warm = false,
}: {
  children: React.ReactNode;
  warm?: boolean;
}) {
  return (
    <div
      className={
        warm
          ? "landing-v2-icon-badge mb-5 flex h-12 w-12 sm:h-14 sm:w-14 shrink-0 items-center justify-center rounded-[16px] sm:rounded-[18px] border border-[#b39b86]/30 bg-[linear-gradient(180deg,rgba(177,157,139,0.96)_0%,rgba(138,122,108,0.98)_100%)] shadow-[0_10px_24px_rgba(86,70,56,0.16)] text-[#eef2f0] [&_svg]:h-5 [&_svg]:w-5 sm:[&_svg]:h-6 sm:[&_svg]:w-6 [&_svg]:text-[#eef2f0] [&_svg]:stroke-[#eef2f0] [&_svg]:fill-none"
          : "landing-v2-icon-badge mb-5 flex h-12 w-12 sm:h-14 sm:w-14 shrink-0 items-center justify-center rounded-[16px] sm:rounded-[18px] border border-[#b39b86]/30 bg-[linear-gradient(180deg,rgba(62,96,99,0.96)_0%,rgba(24,43,48,0.98)_100%)] shadow-[0_10px_24px_rgba(22,48,52,0.18)] text-[#eef2f0] [&_svg]:h-5 [&_svg]:w-5 sm:[&_svg]:h-6 sm:[&_svg]:w-6 [&_svg]:text-[#eef2f0] [&_svg]:stroke-[#eef2f0] [&_svg]:fill-none"
      }
    >
      {children}
    </div>
  );
}

function TrustCard({ icon, title, body }: TrustCardProps) {
  return (
    <SilverCardShell>
      <div className="p-5 sm:p-6">
        <IconBadge>{icon}</IconBadge>

        <h3 className="text-[1.06rem] sm:text-[1.18rem] font-semibold tracking-[-0.03em] text-[#23373b] [overflow-wrap:anywhere]">
          {title}
        </h3>

        <p className="mt-3 text-[0.95rem] sm:text-[0.98rem] leading-7 sm:leading-8 text-[#5c686c] [overflow-wrap:anywhere]">
          {body}
        </p>
      </div>
    </SilverCardShell>
  );
}

type ProofLayerCardProps = {
  eyebrow: string;
  title: string;
  body: string;
};

function ProofLayerCard({ eyebrow, title, body }: ProofLayerCardProps) {
  return (
    <SilverCardShell>
      <div className="p-5 sm:p-6">
        <div className="text-[0.72rem] sm:text-[0.76rem] font-semibold uppercase tracking-[0.22em] sm:tracking-[0.24em] text-[#8d7d6e]">
          {eyebrow}
        </div>

        <h3 className="mt-3 text-[1.06rem] sm:text-[1.18rem] font-semibold tracking-[-0.03em] text-[#23373b] [overflow-wrap:anywhere]">
          {title}
        </h3>

        <p className="mt-3 text-[0.95rem] sm:text-[0.98rem] leading-7 sm:leading-8 text-[#5d6a6d] [overflow-wrap:anywhere]">
          {body}
        </p>
      </div>
    </SilverCardShell>
  );
}

function SectionHeading({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="max-w-[860px] min-w-0">
      <h2 className="text-[1.8rem] sm:text-[2rem] md:text-[2.5rem] font-semibold tracking-[-0.04em] text-[#23373b] [overflow-wrap:anywhere]">
        {title}
      </h2>
      <p className="mt-4 text-[0.98rem] sm:text-[1.02rem] leading-7 sm:leading-8 text-[#5d6a6d] [overflow-wrap:anywhere]">
        {body}
      </p>
    </div>
  );
}

function CTAButton({
  href,
  label,
  dark = false,
  external = false,
}: {
  href: string;
  label: string;
  dark?: boolean;
  external?: boolean;
}) {
  const className = `inline-flex min-h-[48px] w-full sm:w-auto items-center justify-center rounded-full px-5 sm:px-6 py-3 text-sm font-semibold text-center transition duration-300 ${
    dark
      ? "landing-v2-btn-light border border-[#4f706b]/44 bg-[linear-gradient(180deg,rgba(255,255,255,0.62)_0%,rgba(242,244,241,0.92)_100%)] text-[#23373b] shadow-[0_12px_24px_rgba(0,0,0,0.06)] hover:translate-y-[-1px]"
      : "landing-v2-btn-dark border border-[#b39b86]/42 bg-[linear-gradient(180deg,rgba(62,96,99,0.96)_0%,rgba(24,43,48,0.98)_100%)] text-[#eef3f1] shadow-[0_16px_28px_rgba(20,48,52,0.18)] hover:translate-y-[-1px]"
  }`;

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {label}
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      {label}
    </Link>
  );
}

function WhoItForCard({
  icon,
  title,
  body,
  warm = false,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  warm?: boolean;
}) {
  return (
    <SilverCardShell>
      <div className="p-5 sm:p-6">
        <IconBadge warm={warm}>{icon}</IconBadge>

        <h3 className="text-[1.02rem] sm:text-[1.12rem] font-semibold tracking-[-0.03em] text-[#23373b] [overflow-wrap:anywhere]">
          {title}
        </h3>

        <p className="mt-3 text-[0.95rem] sm:text-[0.98rem] leading-7 sm:leading-8 text-[#5c686c] [overflow-wrap:anywhere]">
          {body}
        </p>
      </div>
    </SilverCardShell>
  );
}

function HowItWorksStep({
  icon,
  title,
  body,
  warm = false,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  warm?: boolean;
}) {
  return (
    <SilverCardShell>
      <div className="p-5 sm:p-6">
        <IconBadge warm={warm}>{icon}</IconBadge>

        <h3 className="text-[1.06rem] sm:text-[1.18rem] font-semibold tracking-[-0.03em] text-[#23373b] [overflow-wrap:anywhere]">
          {title}
        </h3>

        <p className="mt-3 text-[0.95rem] sm:text-[0.98rem] leading-7 sm:leading-8 text-[#5c686c] [overflow-wrap:anywhere]">
          {body}
        </p>
      </div>
    </SilverCardShell>
  );
}

export function LandingBody({
  appLogin,
  appRegister,
  sampleReportUrl,
}: {
  appLogin: string;
  appRegister: string;
  sampleReportUrl: string;
}) {
  return (
    <SilverWatermarkSection
      className="section section-body relative overflow-hidden"
      style={{ paddingTop: 72, paddingBottom: 72 }}
    >
      <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
        <img
          src="/images/landing-network-bg.png"
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.12] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
        />

        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_22%,rgba(255,255,255,0.03)_78%,rgba(255,255,255,0.08)_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.03)_12%,rgba(255,255,255,0.00)_24%,rgba(255,255,255,0.00)_76%,rgba(255,255,255,0.03)_88%,rgba(255,255,255,0.10)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_14%,rgba(255,255,255,0.08),transparent_18%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_52%,rgba(255,255,255,0.05),transparent_26%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_88%,rgba(255,255,255,0.035),transparent_24%)]" />
      </div>

      <div className="relative z-10">
        <div id="how-it-works" className="container">
          <SectionHeading
            title="How PROOVRA works"
            body="A practical workflow from original capture to later review."
          />

          <div className="mt-8 sm:mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            <HowItWorksStep
              icon={<Icons.Capture />}
              title="Capture"
              body="Create an evidence record for photos, videos, audio, or documents and preserve the original submitted material."
            />

            <HowItWorksStep
              icon={<Icons.Fingerprint />}
              title="Fingerprint"
              body="Record file hashes and signed fingerprint data so later review can detect integrity issues and mismatches."
            />

            <HowItWorksStep
              icon={<Icons.Reports />}
              title="Report"
              body="Generate a structured PDF report with verification details, timestamps, custody events, and cryptographic references."
            />

            <HowItWorksStep
              icon={<Icons.Verify />}
              title="Verify"
              body="Open a dedicated verification page to review integrity status, custody history, storage protection, and proof materials."
            />
          </div>
        </div>

        <div className="container mt-[56px] sm:mt-[76px]">
          <SectionHeading
            title="What reviewers can actually inspect"
            body="The verification workflow is not just a download link. It exposes the technical materials needed for later integrity review."
          />

          <div className="mt-8 sm:mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            <ProofLayerCard
              eyebrow="Integrity"
              title="File hash and fingerprint materials"
              body="Reviewers can inspect the recorded file SHA-256 hash, fingerprint hash, and related verification status checks."
            />
            <ProofLayerCard
              eyebrow="Cryptography"
              title="Digital signature references"
              body="The system surfaces the signature material and signing-key metadata used to verify the evidence record."
            />
            <ProofLayerCard
              eyebrow="Timeline"
              title="Chain of custody history"
              body="Forensic custody events and access-related events are recorded separately so later review stays clearer and more structured."
            />
            <ProofLayerCard
              eyebrow="Timestamping"
              title="TSA and OpenTimestamps status"
              body="Where available, reviewers can inspect timestamp details, OpenTimestamps state, calendar information, and proof progress."
            />
            <ProofLayerCard
              eyebrow="Storage"
              title="Immutable storage indicators"
              body="Storage protection metadata such as Object Lock mode, retention windows, legal hold, and region can be surfaced in verification."
            />
            <ProofLayerCard
              eyebrow="Output"
              title="Verification page and report"
              body="Share a dedicated verification page and an audit-ready PDF report for structured review across disputes, audits, and investigations."
            />
          </div>
        </div>

        <div className="container mt-[56px] sm:mt-[76px]">
          <SectionHeading
            title="Why teams use PROOVRA instead of ordinary files or screenshots"
            body="When evidence is challenged later, ordinary exports usually do not show enough provenance, integrity, or review history."
          />

          <div className="mt-8 sm:mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            <TrustCard
              icon={<Icons.Fingerprint />}
              title="Cryptographic integrity"
              body="Evidence records are tied to cryptographic hashes and signed verification materials rather than relying on appearance alone."
            />
            <TrustCard
              icon={<Icons.Evidence />}
              title="Structured chain of custody"
              body="Capture, report generation, verification, restoration, archival, and related record events can be surfaced in a clear timeline."
            />
            <TrustCard
              icon={<Icons.Verify />}
              title="Independent review workflow"
              body="Reviewers can inspect a dedicated verification page instead of depending only on the person who originally collected the file."
            />
            <TrustCard
              icon={<Icons.Security />}
              title="Storage protection visibility"
              body="Immutable storage and retention metadata can be presented when available, helping teams understand preservation posture."
            />
          </div>
        </div>

        <div className="container mt-[56px] sm:mt-[76px]">
          <SectionHeading
            title="Built for evidence-sensitive workflows"
            body="Designed for people who need digital material to remain reviewable, traceable, and harder to dispute later."
          />

          <div className="mt-8 sm:mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-5">
            <WhoItForCard
              icon={<Icons.Lawyers />}
              title="Legal teams"
              body="Preserve media and documents with integrity records, report outputs, and a clearer verification trail for dispute workflows."
            />

            <WhoItForCard
              icon={<Icons.Compliance />}
              title="Compliance & internal reviews"
              body="Document internal findings, regulated workflows, and audit evidence with better integrity visibility and retention context."
            />

            <WhoItForCard
              icon={<Icons.Enterprises />}
              title="Corporate incidents & claims"
              body="Track supporting material for investigations, operational incidents, complaints, and case files across teams."
            />

            <WhoItForCard
              icon={<Icons.Journalists />}
              title="Journalism & investigations"
              body="Preserve sensitive source material while keeping a verification workflow separate from public exposure of the original content."
            />

            <WhoItForCard
              icon={<Icons.Security />}
              title="Insurance & risk review"
              body="Support claims and incident documentation with evidence records that remain easier to review later under scrutiny."
              warm
            />
          </div>
        </div>

        <div className="container mt-[56px] sm:mt-[76px]">
          <SilverCardShell>
            <div className="p-6 sm:p-8 md:flex md:items-center md:justify-between md:gap-8">
              <div className="min-w-0 max-w-[720px]">
                <div className="text-[0.72rem] sm:text-[0.76rem] font-semibold uppercase tracking-[0.22em] sm:tracking-[0.24em] text-[#8d7d6e]">
                  Verification-first workflow
                </div>

                <h2 className="mt-3 text-[1.65rem] sm:text-[1.85rem] md:text-[2.2rem] font-semibold tracking-[-0.04em] text-[#23373b] [overflow-wrap:anywhere]">
                  Share evidence with more confidence
                </h2>

                <p className="mt-4 text-[0.98rem] sm:text-[1rem] leading-7 sm:leading-8 text-[#5d6a6d] [overflow-wrap:anywhere]">
                  Instead of sending only a file, send an evidence record with a
                  dedicated verification page, integrity materials, timestamp
                  status, and a structured PDF report.
                </p>
              </div>

              <div className="mt-6 flex w-full flex-col gap-3 md:mt-0 md:w-auto">
                <CTAButton href={appLogin} label="Open dashboard" />
                <CTAButton href="/verify" label="Go to verification portal" dark />
              </div>
            </div>
          </SilverCardShell>
        </div>

        <div className="container mt-[56px] sm:mt-[76px]">
          <h2
            className="text-[1.65rem] sm:text-[1.85rem] md:text-[2rem] font-semibold tracking-[-0.04em] text-[#23373b] [overflow-wrap:anywhere]"
            style={{ marginBottom: 8 }}
          >
            Important clarification
          </h2>

          <p className="page-subtitle text-[0.98rem] sm:text-[1rem] [overflow-wrap:anywhere]" style={{ marginBottom: 18, color: "#5d6a6d" }}>
            PROOVRA is a technical integrity and verification platform.
          </p>

          <SilverCardShell>
            <div className="p-6 sm:p-7">
              <p style={{ margin: 0, color: "#49575b", lineHeight: "2rem" }} className="[overflow-wrap:anywhere]">
                PROOVRA is not a court, law-enforcement authority, or legal
                service provider. Verification confirms recorded integrity,
                signature, timestamp, custody, and preservation-related metadata
                for a digital evidence record. It does not by itself establish
                factual truth, authorship, identity, or legal admissibility in a
                specific jurisdiction.
              </p>
            </div>
          </SilverCardShell>
        </div>

        <div className="container mt-[56px] sm:mt-[76px] text-center">
          <div className="mx-auto max-w-[900px] min-w-0">
            <h2 className="text-[1.7rem] sm:text-[1.9rem] md:text-[2.1rem] font-semibold tracking-[-0.04em] text-[#23373b] [overflow-wrap:anywhere]">
              Start building stronger digital evidence records
            </h2>

            <p className="page-subtitle text-[0.98rem] sm:text-[1rem] [overflow-wrap:anywhere]" style={{ color: "#5d6a6d", marginTop: 16 }}>
              Capture originals, preserve integrity, and verify later with a
              clearer review trail.
            </p>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <CTAButton href={appRegister} label="Start capturing evidence" />
              <CTAButton
                href={sampleReportUrl}
                label="View sample report"
                dark
                external
              />
            </div>
          </div>
        </div>
      </div>
    </SilverWatermarkSection>
  );
}