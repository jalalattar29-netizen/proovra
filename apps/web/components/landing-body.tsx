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
      className={`landing-v2-card group relative overflow-hidden rounded-[24px] border border-[#4f706b]/44 shadow-[0_18px_38px_rgba(0,0,0,0.07),inset_0_1px_0_rgba(255,255,255,0.48)] ${className}`}
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
  demoUrl,
  sampleReportUrl,
}: {
  appLogin: string;
  appRegister: string;
  demoUrl: string;
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
            body="A verification-first workflow from file intake to later review, escalation, and scrutiny."
          />

          <div className="mt-8 sm:mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            <HowItWorksStep
              icon={<Icons.Capture />}
              title="Create record"
body="Upload an existing file or capture material into a structured evidence record instead of relying on ordinary files, screenshots, or loose attachments alone."            />

            <HowItWorksStep
              icon={<Icons.Fingerprint />}
              title="Fingerprint & timestamp"
body="Record integrity materials, timing context, and related metadata so later review can detect post-submission mismatch and inspect what was preserved at completion."
            />

            <HowItWorksStep
              icon={<Icons.Reports />}
              title="Generate report"
body="Produce a reviewer-facing PDF report with the recorded integrity state, timing context, review trail, and supporting verification references."
            />

            <HowItWorksStep
              icon={<Icons.Verify />}
              title="Verify later"
body="Share a verification page where reviewers can inspect the recorded integrity state, review trail, preservation context, and technical materials in one place."
            />
          </div>
        </div>

        <div className="container mt-[56px] sm:mt-[76px]">
          <SectionHeading
            title="What reviewers can actually inspect"
body="PROOVRA does not stop at storage. It exposes the recorded evidence state and supporting review materials needed for later scrutiny."
          />

          <div className="mt-8 sm:mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            <ProofLayerCard
              eyebrow="Integrity"
              title="Recorded integrity summary"
body="Reviewers can inspect whether the current evidence state still matches the recorded completion state, whether mismatch handling is required, and what was preserved at completion."
            />
            <ProofLayerCard
              eyebrow="Timestamping"
              title="Trusted timestamp visibility"
              body="Where available, reviewers can inspect timestamp status, issuing authority details, and timing records attached to the evidence state."
            />
            <ProofLayerCard
              eyebrow="Review Trail"
              title="Chain of custody timeline"
body="Key evidence lifecycle events and access-related activity can be reviewed in a clearer sequence instead of relying on screenshots, memory, or scattered attachments alone."
            />
            <ProofLayerCard
              eyebrow="Verification"
              title="Verification page and report"
body="A reviewer-facing verification page and structured PDF report make external review easier across disputes, audits, investigations, claims, and internal escalation."
            />
            <ProofLayerCard
              eyebrow="Storage"
              title="Preservation indicators"
body="Storage protection metadata such as object lock mode, retention context, and preservation-related signals can be surfaced where available."
            />
            <ProofLayerCard
              eyebrow="Technical Materials"
              title="Expert review details"
body="Forensic and technical reviewers can inspect hashes, signatures, timestamp references, and related verification materials without exposing the original file publicly."
            />
          </div>
        </div>

        <div className="container mt-[56px] sm:mt-[76px]">
          <SectionHeading
            title="Why teams use PROOVRA instead of ordinary files or screenshots"
body="When evidence is challenged later, plain files usually lack enough preservation context, review structure, or defensible verification history."
          />

          <div className="mt-8 sm:mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            <TrustCard
              icon={<Icons.Fingerprint />}
              title="Tamper detection after submission"
body="Evidence records are tied to recorded integrity materials so later review can detect post-submission changes more reliably than with ordinary loose files."
            />
            <TrustCard
              icon={<Icons.Evidence />}
              title="Structured review trail"
body="Creation, preservation, reporting, verification, and related evidence actions can be reviewed in one clearer trail instead of across disconnected files and messages."
            />
            <TrustCard
              icon={<Icons.Verify />}
              title="Independent verification workflow"
body="Reviewers can inspect the record through a dedicated verification view instead of depending only on the person who collected or sent the file."
            />
            <TrustCard
              icon={<Icons.Security />}
              title="Preservation visibility"
body="Timing and storage-protection context can be surfaced alongside the record to support later scrutiny, internal review, and external handoff."
            />
          </div>
        </div>

        <div className="container mt-[56px] sm:mt-[76px]">
          <SectionHeading
            title="Built for evidence-sensitive workflows"
body="Designed for professionals and teams that need digital material to remain reviewable, traceable, and harder to dispute later."
          />

          <div className="mt-8 sm:mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-5">
            <WhoItForCard
              icon={<Icons.Lawyers />}
              title="Legal teams"
              body="Strengthen evidentiary defensibility with clearer review trails, report outputs, and preservation context."
            />

            <WhoItForCard
              icon={<Icons.Compliance />}
              title="Compliance & internal reviews"
              body="Maintain traceable records for internal findings, regulated processes, and audit evidence under closer scrutiny."
            />

            <WhoItForCard
              icon={<Icons.Enterprises />}
              title="Corporate incidents & claims"
              body="Track supporting material across incident reviews, complaints, operational events, and case documentation."
            />

            <WhoItForCard
              icon={<Icons.Journalists />}
              title="Journalism & investigations"
              body="Preserve source material with later-verifiable integrity while keeping access to the original content controlled."
            />

            <WhoItForCard
              icon={<Icons.Security />}
              title="Insurance & risk review"
              body="Reduce disputed or tampered claim submissions with evidence records that stay easier to review later."
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
                  Review stronger evidence, not just a file
                </h2>

                <p className="mt-4 text-[0.98rem] sm:text-[1rem] leading-7 sm:leading-8 text-[#5d6a6d] [overflow-wrap:anywhere]">
Instead of sending only a raw file, share an evidence record with a dedicated verification page, recorded integrity state, timing context, structured review trail, and a reviewer-facing report.

                </p>
              </div>

              <div className="mt-6 flex w-full flex-col gap-3 md:mt-0 md:w-auto">
                <CTAButton href={demoUrl} label="Request demo" />
                <CTAButton
                  href={sampleReportUrl}
                  label="View sample report"
                  dark
                  external
                />
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

          <p
            className="page-subtitle text-[0.98rem] sm:text-[1rem] [overflow-wrap:anywhere]"
            style={{ marginBottom: 18, color: "#5d6a6d" }}
          >
            PROOVRA is a technical integrity and verification platform.
          </p>

          <SilverCardShell>
            <div className="p-6 sm:p-7">
              <p
                style={{ margin: 0, color: "#49575b", lineHeight: "2rem" }}
                className="[overflow-wrap:anywhere]"
              >
PROOVRA is not a court, law-enforcement authority, or legal service provider. Verification confirms the recorded integrity state, timing context, custody metadata, and preservation-related details for an evidence record. It does not by itself establish factual truth, authorship, identity, or legal admissibility in a specific jurisdiction.

              </p>
            </div>
          </SilverCardShell>
        </div>

        <div className="container mt-[56px] sm:mt-[76px] text-center">
          <div className="mx-auto max-w-[900px] min-w-0">
            <h2 className="text-[1.7rem] sm:text-[1.9rem] md:text-[2.1rem] font-semibold tracking-[-0.04em] text-[#23373b] [overflow-wrap:anywhere]">
              Start with a clearer evidence workflow
            </h2>

            <p
              className="page-subtitle text-[0.98rem] sm:text-[1rem] [overflow-wrap:anywhere]"
              style={{ color: "#5d6a6d", marginTop: 16 }}
            >
Upload files, preserve the recorded integrity state, and support later review with a stronger evidence workflow.
            </p>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <CTAButton href={appRegister} label="Upload evidence" />
              <CTAButton href={demoUrl} label="Request demo" dark />
              <CTAButton
                href={sampleReportUrl}
                label="View sample report"
                dark
                external
              />
            </div>

            <div className="mt-5 text-[0.9rem] text-[#5d6a6d]">
              Already have an account?{" "}
              <Link
                href={appLogin}
                className="font-semibold text-[#35585d] underline underline-offset-4"
              >
                Open dashboard
              </Link>
            </div>
          </div>
        </div>
      </div>
    </SilverWatermarkSection>
  );
}