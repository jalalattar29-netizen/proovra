"use client";

import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../components/marketing/EnterpriseFooter";
import { RevealSection } from "../../components/motion";
import { MARKETING_BTN } from "../../lib/marketing-buttons";
import Link from "next/link";
import {
  Archive,
  ArrowRight,
  Building2,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Compass,
  Eye,
  FileCheck2,
  FileText,
  Fingerprint,
  Landmark,
  Newspaper,
  Scale,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

const ABOUT_HERO_IMAGE = "/assets/hero/about-hero.png";

// ---------------------------------------------------------------------------
// Section 4 — Beliefs
// ---------------------------------------------------------------------------

const BELIEFS: ReadonlyArray<{ title: string; body: string; accent: string }> = [
  {
    title: "Evidence should be reviewable.",
    body: "A file alone rarely tells the whole story. Important records should carry the integrity and custody context needed for later review.",
    accent: "#2563EB",
  },
  {
    title: "Verification should be inspectable.",
    body: "Reviewers should be able to inspect recorded hashes, signatures, timestamp context, custody events, reports, and packages instead of relying only on screenshots or claims.",
    accent: "#7C3AED",
  },
  {
    title: "Transparency is better than overclaiming.",
    body: "PROOVRA is explicit about what the platform records and what it does not determine. Clear boundaries create more trust than exaggerated promises.",
    accent: "#0F766E",
  },
  {
    title: "Custody belongs in the workflow.",
    body: "Handling context should not be reconstructed weeks later from memory, emails, or chat threads. It should be recorded as part of the evidence lifecycle.",
    accent: "#B45309",
  },
  {
    title: "AI must stay advisory.",
    body: "AI assistance can help organize and explain operational context, but it must not become a truth engine, admissibility engine, or substitute for human review.",
    accent: "#2563EB",
  },
  {
    title: "Trust should survive sharing.",
    body: "When evidence moves outside the original workspace, reviewers should still receive structured materials they can inspect and understand.",
    accent: "#7C3AED",
  },
];

// ---------------------------------------------------------------------------
// Section 5 — Principles
// ---------------------------------------------------------------------------

const PRINCIPLES: ReadonlyArray<{
  title: string;
  body: string;
  Icon: LucideIcon;
  accent: string;
  accentSoft: string;
  accentBorder: string;
}> = [
  {
    title: "Verification-first",
    body: "Integrity checks, recorded fingerprints, signatures, and timestamp context should be part of the evidence record — not an afterthought.",
    Icon: Fingerprint,
    accent: "#0891B2",
    accentSoft: "#ECFEFF",
    accentBorder: "#A5F3FC",
  },
  {
    title: "Review-first",
    body: "Reports, verification pages, and packages should be understandable to reviewers who were not present when the evidence was captured.",
    Icon: Eye,
    accent: "#6366F1",
    accentSoft: "#EEF2FF",
    accentBorder: "#C7D2FE",
  },
  {
    title: "Custody-aware",
    body: "Important platform actions should produce custody events so later reviewers can inspect handling context.",
    Icon: ClipboardCheck,
    accent: "#0F766E",
    accentSoft: "#ECFDF5",
    accentBorder: "#A7F3D0",
  },
  {
    title: "Governance-ready",
    body: "Workspaces need roles, cases, retention concepts, legal hold concepts, audit logs, and access boundaries around sensitive evidence.",
    Icon: Landmark,
    accent: "#B45309",
    accentSoft: "#FFFBEB",
    accentBorder: "#FDE68A",
  },
  {
    title: "Boundary-honest",
    body: "PROOVRA should clearly say what it records, what it verifies, and what remains outside the platform's determination.",
    Icon: Scale,
    accent: "#7C3AED",
    accentSoft: "#F5F3FF",
    accentBorder: "#DDD6FE",
  },
];

// ---------------------------------------------------------------------------
// Section 6 — Boundaries
// ---------------------------------------------------------------------------

const NOT_CLAIMS: ReadonlyArray<string> = [
  "PROOVRA does not determine factual truth.",
  "PROOVRA does not determine authorship, identity, intent, or liability.",
  "PROOVRA does not guarantee legal admissibility, evidentiary weight, or court acceptance.",
  "PROOVRA does not certify that a real-world event happened.",
  "PROOVRA does not provide legal advice or forensic testimony.",
  "PROOVRA does not replace customer responsibility for lawful capture, consent, permissions, and use.",
];

// Section 7 — Trust resources: now rendered via the in-section Trust
// Architecture bands below; the previous TRUST_RESOURCES inline list was
// retired but kept here in this comment for traceability.

// ---------------------------------------------------------------------------
// Section 8 — Built for
// ---------------------------------------------------------------------------

const BUILT_FOR: ReadonlyArray<{
  title: string;
  body: string;
  Icon: typeof Scale;
  accent: string;
}> = [
  {
    title: "Legal and dispute-sensitive teams",
    body: "For matters where records may be reviewed by counsel, experts, clients, or counterparties.",
    Icon: Scale,
    accent: "#2563EB",
  },
  {
    title: "Investigations and incident review",
    body: "For teams preserving digital material during internal investigations, incidents, complaints, or escalations.",
    Icon: Search,
    accent: "#7C3AED",
  },
  {
    title: "Compliance and audit teams",
    body: "For teams that need reviewable records, governance context, and audit-friendly outputs.",
    Icon: ShieldCheck,
    accent: "#0F766E",
  },
  {
    title: "Insurance and claims workflows",
    body: "For claims materials, damage documentation, incident records, and reviewer handoffs.",
    Icon: FileText,
    accent: "#B45309",
  },
  {
    title: "Journalism and source-material review",
    body: "For preserving source material, captured screens, leaked documents, and review context without turning files into unsupported claims.",
    Icon: Newspaper,
    accent: "#2563EB",
  },
  {
    title: "Enterprise governance",
    body: "For organizations that need evidence workflows with roles, access boundaries, retention concepts, and reviewer-ready outputs.",
    Icon: Building2,
    accent: "#7C3AED",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionEyebrow({
  children,
  tone = "blue",
}: {
  children: React.ReactNode;
  tone?: "blue" | "violet" | "slate" | "white";
}) {
  const colorMap: Record<string, string> = {
    blue: "#2563EB",
    violet: "#7C3AED",
    slate: "#64748B",
    white: "rgba(255,255,255,0.78)",
  };
  return (
    <div
      className="text-[12px] font-bold uppercase tracking-[0.16em]"
      style={{ color: colorMap[tone] }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AboutPage() {
  return (
    <div className="page landing-page about-page" style={{ background: "#F6F9FC" }}>
      {/* ───────────────────────────────────────────────────────────────
          Section 1 — HERO (image + background untouched per spec)
          Only text content has been updated.
          ─────────────────────────────────────────────────────────────── */}
      <div className="relative min-h-[720px] overflow-hidden bg-white">
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            backgroundImage: `url("${ABOUT_HERO_IMAGE}")`,
            backgroundSize: "100% 100%",
            backgroundPosition: "center center",
            backgroundRepeat: "no-repeat",
          }}
        />

        <div className="relative z-10">
          <MarketingHeader />

          <section className="mx-auto max-w-[1320px] px-6 pb-24 pt-20 md:px-8 lg:pb-28 lg:pt-28">
            <div className="max-w-[640px]">
              <span className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#2563EB]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#7A3CFF]" />
                About PROOVRA
              </span>

              <h1 className="mt-4 max-w-[600px] text-[2rem] font-semibold leading-[1.06] tracking-[-0.025em] text-[#0F172A] md:text-[2.6rem] lg:text-[3rem]">
                Building trust into
                <span
                  className="bg-clip-text text-transparent"
                  style={{
                    backgroundImage:
                      "linear-gradient(90deg,#2563EB 0%,#7C3AED 50%,#C026D3 100%)",
                  }}
                >
                  {" "}
                  digital evidence.
                </span>
              </h1>

              <p className="mt-4 max-w-[560px] text-[15px] leading-[1.65] text-[#475569]">
                PROOVRA is building an evidence operations platform for
                organizations that need digital records to remain
                understandable, reviewable, and independently verifiable long
                after they are captured or shared.
              </p>

              <div className="mt-7 flex flex-wrap gap-3">
                <Link
                  href="/platform"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-[#071B4D] px-5 text-[13.5px] font-semibold text-white shadow-[0_10px_24px_rgba(7,27,77,0.22)] transition hover:-translate-y-0.5"
                >
                  Explore the platform
                </Link>
                <Link
                  href="/trust"
                  className={MARKETING_BTN.heroSecondary}
                >
                  Visit Trust Center
                </Link>
              </div>

              <div className="mt-6 flex flex-wrap gap-2">
                {["Evidence operations", "Verification-first", "Built for scrutiny"].map(
                  (chip) => (
                    <span
                      key={chip}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white/85 px-3 py-1 text-[12px] font-medium text-[#0F172A]"
                    >
                      <span
                        aria-hidden="true"
                        className="block h-1.5 w-1.5 rounded-full bg-[#2563EB]"
                      />
                      {chip}
                    </span>
                  )
                )}
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* ───────────────────────────────────────────────────────────────
          Section 2 — MISSION
          ─────────────────────────────────────────────────────────────── */}
      <RevealSection direction="up">
        <section className="bg-white">
          <div className="mx-auto max-w-[1100px] px-6 py-16 md:px-8 md:py-24">
            <div className="mb-10 text-center">
              <SectionEyebrow tone="blue">Our mission</SectionEyebrow>
              <h2 className="mx-auto mt-2 max-w-[820px] text-[1.85rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.3rem]">
                Make digital evidence easier to preserve, review, and verify.
              </h2>
              <p className="mx-auto mt-5 max-w-[780px] text-[15.5px] leading-[1.75] text-[#475569]">
                PROOVRA exists to help teams move beyond ordinary files,
                screenshots, folders, and disconnected handoffs. Our mission is
                to make important digital records easier to preserve with
                integrity context, easier to review with custody visibility,
                and easier to share with verification materials that other
                people can inspect.
              </p>
            </div>

            <div
              className="relative overflow-hidden rounded-[28px] border bg-white p-9 shadow-[0_2px_10px_rgba(8,18,22,0.03)] md:p-14"
              style={{ borderColor: "#E2E8F0", borderLeft: "4px solid #2563EB" }}
            >
              <div
                aria-hidden="true"
                className="absolute right-8 top-8 hidden h-12 w-12 items-center justify-center rounded-full md:flex"
                style={{ background: "#EFF6FF", color: "#2563EB" }}
              >
                <Sparkles size={20} />
              </div>
              <div className="text-[11.5px] font-bold uppercase tracking-[0.18em] text-[#7C3AED]">
                Our position
              </div>
              <p className="mt-4 max-w-[820px] text-[1.25rem] font-semibold leading-[1.55] tracking-[-0.005em] text-[#081426] md:text-[1.5rem]">
                "Trust in digital evidence should not depend on appearance,
                screenshots, or memory. It should be supported by recorded
                integrity signals, custody context, and reviewer-ready
                materials."
              </p>
            </div>
          </div>
        </section>
      </RevealSection>

      {/* ───────────────────────────────────────────────────────────────
          Section 2A — WHAT PROOVRA IS (company positioning)
          Centered enterprise positioning statement immediately below
          Our mission. Not a card — a large editorial statement.
          ─────────────────────────────────────────────────────────────── */}
      <RevealSection direction="up">
        <section className="bg-white">
          <div className="mx-auto max-w-[1080px] px-6 pb-20 md:px-8 md:pb-24">
            <div className="text-center">
              <SectionEyebrow tone="violet">What PROOVRA is</SectionEyebrow>
              <p className="mx-auto mt-6 max-w-[900px] text-[1.55rem] font-semibold leading-[1.32] tracking-[-0.015em] text-[#081426] md:text-[1.9rem]">
                PROOVRA is building the trust layer for digital evidence
                operations.
              </p>
              <p className="mx-auto mt-6 max-w-[820px] text-[15.5px] leading-[1.78] text-[#475569]">
                The platform helps organizations preserve, review, verify, and
                govern sensitive digital records through structured Evidence
                Records, integrity controls, custody visibility, verification
                materials, and reviewer-ready outputs.
              </p>
              <p className="mx-auto mt-4 max-w-[820px] text-[15.5px] leading-[1.78] text-[#475569]">
                Rather than treating evidence as a standalone file, PROOVRA
                treats it as a reviewable record that can carry technical
                context throughout its lifecycle.
              </p>
            </div>
          </div>
        </section>
      </RevealSection>

      {/* ───────────────────────────────────────────────────────────────
          Section 3 — WHY THE COMPANY EXISTS
          ─────────────────────────────────────────────────────────────── */}
      <section style={{ background: "#F8FAFC" }}>
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
          <div className="grid items-start gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
            <RevealSection direction="up">
              <div>
                <SectionEyebrow tone="violet">Why we exist</SectionEyebrow>
                <h2 className="mt-2 text-[1.85rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.2rem]">
                  Digital evidence moves faster than the context around it.
                </h2>
                <p className="mt-5 text-[15px] leading-[1.78] text-[#475569]">
                  Every day, important digital material is captured, exported,
                  forwarded, downloaded, renamed, screenshotted, uploaded, and
                  shared again. By the time that material reaches a reviewer,
                  lawyer, investigator, auditor, insurer, journalist, or
                  decision-maker, the file may still exist — but the context
                  needed to review it often becomes fragmented.
                </p>
                <p className="mt-5 text-[15px] leading-[1.78] text-[#475569]">
                  PROOVRA was created to address that gap. The platform is
                  being built around the idea that evidence should travel with
                  recorded integrity signals, custody history, verification
                  context, and reviewer-ready outputs — not as a loose file
                  that requires someone to reconstruct what happened later.
                </p>
              </div>
            </RevealSection>

            <RevealSection direction="up">
              <div
                className="relative rounded-[24px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)] md:p-8"
                style={{ borderColor: "#E2E8F0" }}
              >
                <div className="text-[11.5px] font-bold uppercase tracking-[0.16em] text-[#64748B]">
                  How context gets lost
                </div>

                <ol className="relative mt-6 grid gap-4">
                  {[
                    "File captured",
                    "Sent through messages or email",
                    "Saved in a folder",
                    "Renamed or exported",
                    "Reviewed without full context",
                  ].map((step, i) => (
                    <li key={step} className="relative flex items-start gap-4">
                      <span
                        aria-hidden="true"
                        className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
                        style={{
                          background: "#FFFFFF",
                          border: "1.5px solid #DDE6F2",
                          color: "#0F172A",
                        }}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {i < 4 ? (
                        <span
                          aria-hidden="true"
                          className="absolute left-4 top-8 z-0 h-[calc(100%+0.5rem)] w-px"
                          style={{ background: "#DDE6F2" }}
                        />
                      ) : null}
                      <div className="pt-1 text-[14.5px] leading-[1.55] text-[#0F172A]">
                        {step}
                      </div>
                    </li>
                  ))}
                </ol>

                <div
                  className="mt-7 rounded-[14px] p-4 text-[13.5px] leading-[1.55] text-white"
                  style={{
                    background:
                      "linear-gradient(135deg, #071B4D 0%, #2D1A6B 100%)",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={15} aria-hidden="true" className="text-[#A78BFA]" />
                    <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/80">
                      PROOVRA's intervention
                    </span>
                  </div>
                  <div className="mt-2 font-medium">
                    PROOVRA attaches review context earlier in the workflow.
                  </div>
                </div>
              </div>
            </RevealSection>
          </div>
        </div>
      </section>

      {/* ───────────────────────────────────────────────────────────────
          Section 3A — THE IDEA BEHIND PROOVRA (editorial)
          Left = large heading, right = narrative. No cards, no grids —
          a Stripe / Datadog / Cloudflare-style editorial composition.
          ─────────────────────────────────────────────────────────────── */}
      <RevealSection direction="up">
        <section className="bg-white">
          <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
            <div className="grid items-start gap-12 lg:grid-cols-[0.95fr_1.05fr] lg:gap-20">
              <div className="lg:sticky lg:top-24">
                <SectionEyebrow tone="violet">The idea behind PROOVRA</SectionEyebrow>
                <h2 className="mt-3 text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.025em] text-[#081426] md:text-[2.6rem]">
                  Evidence should be more than a file.
                </h2>
              </div>

              <div className="space-y-5 text-[15.5px] leading-[1.78] text-[#475569]">
                <p>
                  Traditional systems treat evidence as files — uploads,
                  attachments, exports, screenshots, and zipped bundles handed
                  from one team to the next. A file may survive that journey.
                  The context around it often does not.
                </p>
                <p>
                  PROOVRA was created around a different concept:{" "}
                  <span className="font-semibold text-[#081426]">
                    the Evidence Record
                  </span>{" "}
                  rather than the ordinary file. An Evidence Record is the
                  structured platform record that travels with the material it
                  preserves.
                </p>
                <p>
                  An Evidence Record can include the original content, recorded
                  metadata, a cryptographic fingerprint, hash-chained custody
                  history, signature and timestamp context where configured,
                  verification materials, and reviewer-ready outputs such as
                  Verification Reports and Verification Packages.
                </p>
                <p>
                  The goal is not simply to store information. The goal is to
                  preserve enough context that a reviewer who arrives later —
                  counsel, expert, auditor, regulator, journalist, or
                  decision-maker — can understand what was recorded, what
                  changed, and what still requires independent judgment.
                </p>
                <p>
                  PROOVRA records technical integrity, custody, timestamp,
                  signature, preservation, reporting, and reviewer-access
                  signals. It does not determine factual truth, authorship,
                  identity, liability, or legal admissibility.
                </p>
              </div>
            </div>
          </div>
        </section>
      </RevealSection>

      {/* ───────────────────────────────────────────────────────────────
          Section 3B — WHY DIGITAL EVIDENCE NEEDS A TRUST LAYER
          Soft silver background with a horizontal flow timeline:
          Capture → Evidence Record → Review → Verification → Governance
          → External Review. Matches the modern Platform page rhythm.
          ─────────────────────────────────────────────────────────────── */}
      <RevealSection direction="up">
        <section style={{ background: "#F8FAFC" }}>
          <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
            <div className="mb-12 max-w-[860px]">
              <SectionEyebrow tone="blue">Why a trust layer</SectionEyebrow>
              <h2 className="mt-2 text-[1.85rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.2rem]">
                Why digital evidence needs a trust layer.
              </h2>
              <p className="mt-5 text-[15.5px] leading-[1.78] text-[#475569]">
                More decisions depend on digital material than ever before.
              </p>
            </div>

            <div className="grid items-start gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:gap-16">
              <div className="space-y-5 text-[15.5px] leading-[1.78] text-[#475569]">
                <p>
                  Today organizations rely on photos, videos, documents,
                  messages, exported records, and screenshots for
                  investigations, claims, disputes, compliance, audits, and
                  governance work.
                </p>
                <p>
                  The volume of digital material continues to grow. The ability
                  to review it reliably often does not.
                </p>
                <p>
                  PROOVRA is being built to act as a{" "}
                  <span className="font-semibold text-[#081426]">
                    trust layer
                  </span>{" "}
                  between capture, review, verification, governance, and
                  external sharing — preserving review context throughout the
                  journey instead of leaving each stage to reconstruct it.
                </p>
              </div>

              {/* Horizontal flow timeline — desktop horizontal, mobile vertical */}
              <div
                className="relative rounded-[24px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)] md:p-9"
                style={{ borderColor: "#E2E8F0" }}
              >
                <div className="text-[11.5px] font-bold uppercase tracking-[0.16em] text-[#64748B]">
                  The trust-layer journey
                </div>

                {/* Connector line — desktop only */}
                <div className="relative mt-7">
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute left-6 right-6 top-[22px] hidden h-px lg:block"
                    style={{
                      background:
                        "linear-gradient(90deg, transparent 0%, #2563EB 12%, #7C3AED 50%, #2563EB 88%, transparent 100%)",
                      opacity: 0.45,
                    }}
                  />

                  <ol className="grid gap-4 lg:grid-cols-6 lg:gap-2">
                    {(
                      [
                        { label: "Capture", Icon: Camera, accent: "#FB923C" },
                        { label: "Evidence Record", Icon: FileCheck2, accent: "#2563EB" },
                        { label: "Review", Icon: Eye, accent: "#0F766E" },
                        { label: "Verification", Icon: ShieldCheck, accent: "#7C3AED" },
                        { label: "Governance", Icon: Landmark, accent: "#B45309" },
                        { label: "External Review", Icon: Share2, accent: "#DB2777" },
                      ] as const
                    ).map(({ label, Icon, accent }) => (
                      <li
                        key={label}
                        className="relative flex items-center gap-3 lg:flex-col lg:items-center lg:gap-0"
                      >
                        <span
                          aria-hidden="true"
                          className="relative z-10 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border bg-white"
                          style={{
                            borderColor: `${accent}40`,
                            color: accent,
                            background: `linear-gradient(180deg, #FFFFFF 0%, ${accent}0F 100%)`,
                          }}
                        >
                          <Icon size={17} strokeWidth={1.9} />
                        </span>
                        <span className="text-[13px] font-semibold text-[#0F172A] lg:mt-3 lg:text-center">
                          {label}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>

                <p className="mt-7 text-[13px] leading-[1.65] text-[#64748B]">
                  Each step carries forward the integrity, custody, and review
                  context recorded at earlier stages.
                </p>
              </div>
            </div>
          </div>
        </section>
      </RevealSection>

      {/* ───────────────────────────────────────────────────────────────
          Section 4 — WHAT WE BELIEVE
          ─────────────────────────────────────────────────────────────── */}
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
          <div className="mb-12 max-w-[820px]">
            <SectionEyebrow tone="blue">What we believe</SectionEyebrow>
            <h2 className="mt-2 text-[1.85rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.2rem]">
              Trust is stronger when it can be reviewed.
            </h2>
            <p className="mt-5 text-[15.5px] leading-[1.75] text-[#475569]">
              PROOVRA is guided by a simple belief: evidence workflows should
              not require blind trust. They should give reviewers enough
              recorded context to inspect what the platform recorded,
              understand what changed, and recognize what still requires
              human, legal, or expert analysis.
            </p>
          </div>

          <RevealSection direction="up">
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {BELIEFS.map((b) => (
                <div
                  key={b.title}
                  className="relative flex flex-col rounded-[20px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(8,18,22,0.05)]"
                  style={{ borderColor: "#DDE6F2" }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-7 h-9 w-[3px] rounded-r"
                    style={{ background: b.accent }}
                  />
                  <h3 className="text-[1.05rem] font-semibold tracking-[-0.01em] text-[#081426]">
                    {b.title}
                  </h3>
                  <p className="mt-3 flex-1 text-[14px] leading-[1.65] text-[#475569]">
                    {b.body}
                  </p>
                </div>
              ))}
            </div>
          </RevealSection>
        </div>
      </section>

      {/* ───────────────────────────────────────────────────────────────
          Section 5 — PLATFORM PRINCIPLES
          ─────────────────────────────────────────────────────────────── */}
      <section style={{ background: "#F8FAFC" }}>
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
          <div className="mb-12 max-w-[820px]">
            <SectionEyebrow tone="violet">Platform principles</SectionEyebrow>
            <h2 className="mt-2 text-[1.85rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.2rem]">
              The principles behind PROOVRA.
            </h2>
            <p className="mt-5 text-[15.5px] leading-[1.75] text-[#475569]">
              PROOVRA is being built around principles that reflect how
              evidence is actually challenged, reviewed, governed, and shared.
            </p>
          </div>

          <RevealSection direction="up">
            <div
              className="relative rounded-[24px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)] md:p-10"
              style={{ borderColor: "#E2E8F0" }}
            >
              <ol className="grid gap-7 md:gap-9">
                {PRINCIPLES.map((p, i) => {
                  const Icon = p.Icon;
                  return (
                    <li key={p.title} className="relative grid gap-5 md:grid-cols-[auto_1fr] md:gap-8">
                      <div className="flex items-start gap-4 md:flex-col md:items-start md:gap-3">
                        <span
                          aria-hidden="true"
                          className="flex h-12 w-12 items-center justify-center rounded-full border"
                          style={{
                            background: p.accentSoft,
                            borderColor: p.accentBorder,
                            color: p.accent,
                          }}
                        >
                          <Icon size={20} strokeWidth={1.85} />
                        </span>
                        <h3 className="text-[1.1rem] font-semibold tracking-[-0.01em] text-[#081426] md:text-[1.15rem]">
                          {p.title}
                        </h3>
                      </div>
                      <div>
                        <p className="text-[14.5px] leading-[1.7] text-[#475569]">
                          {p.body}
                        </p>
                      </div>
                      {i < PRINCIPLES.length - 1 ? (
                        <div
                          aria-hidden="true"
                          className="h-px md:col-span-2"
                          style={{ background: "#F1F5F9" }}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          </RevealSection>
        </div>
      </section>

      {/* ───────────────────────────────────────────────────────────────
          Section 6 — WHAT PROOVRA IS NOT (boundaries)
          ─────────────────────────────────────────────────────────────── */}
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
          <RevealSection direction="up">
            <div
              className="relative overflow-hidden rounded-[28px] p-9 text-white shadow-[0_24px_60px_rgba(7,27,77,0.22)] md:p-14"
              style={{
                backgroundImage: "url('/assets/cards/icon-card.png')",
                backgroundSize: "cover",
                backgroundPosition: "center center",
                backgroundRepeat: "no-repeat",
                backgroundColor: "#050F33",
              }}
            >
              {/* Readability scrim — keeps boundary copy legible without
                  flattening the icon-card artwork. */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(5,15,51,0.48) 0%, rgba(5,15,51,0.62) 100%)",
                }}
              />
              <div className="relative">
                <SectionEyebrow tone="white">Clear boundaries</SectionEyebrow>
                <h2 className="mt-3 max-w-[820px] text-[1.95rem] font-semibold leading-[1.12] tracking-[-0.02em] text-white md:text-[2.3rem]">
                  What PROOVRA does not claim.
                </h2>
                <p className="mt-5 max-w-[780px] text-[15.5px] leading-[1.75] text-white/80">
                  Trust-sensitive software must be careful with its claims.
                  PROOVRA is designed to record and expose technical
                  verification materials, but it does not replace courts,
                  regulators, investigators, experts, counsel, or human
                  judgment.
                </p>

                <ul className="mt-9 grid gap-4 md:grid-cols-2">
                  {NOT_CLAIMS.map((c) => (
                    <li
                      key={c}
                      className="flex gap-3 rounded-[14px] border border-white/10 bg-white/[0.04] p-4"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-[2px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                        style={{
                          background: "rgba(244,114,182,0.18)",
                          color: "#F472B6",
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                          <path
                            d="M2 5.5h7"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                        </svg>
                      </span>
                      <span className="text-[14.5px] leading-[1.6] text-white/90">
                        {c}
                      </span>
                    </li>
                  ))}
                </ul>

                <div
                  className="mt-9 rounded-[16px] border border-white/15 p-5"
                  style={{ background: "rgba(255,255,255,0.05)" }}
                >
                  <div className="flex items-start gap-3">
                    <CheckCircle2
                      size={18}
                      aria-hidden="true"
                      className="mt-[2px] shrink-0 text-[#A78BFA]"
                    />
                    <div>
                      <div className="text-[11.5px] font-bold uppercase tracking-[0.16em] text-white/70">
                        What PROOVRA does provide
                      </div>
                      <p className="mt-2 text-[14.5px] leading-[1.65] text-white/90">
                        A structured way to preserve, inspect, explain, and
                        share recorded integrity and custody context.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </RevealSection>
        </div>
      </section>

      {/* ───────────────────────────────────────────────────────────────
          Section 7 — TRUST AND GOVERNANCE (trust-architecture layout)
          Narrative + CTA at the top, then three full-width architecture
          bands below: Privacy & Compliance · Security & Verification ·
          Governance & Operations.
          ─────────────────────────────────────────────────────────────── */}
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
          <div className="flex flex-col gap-12">
            <RevealSection direction="up">
              <div className="max-w-[820px]">
                <SectionEyebrow tone="blue">Trust and governance</SectionEyebrow>
                <h2 className="mt-2 text-[1.85rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.2rem]">
                  Trust should be documented, not implied.
                </h2>
                <p className="mt-5 text-[15px] leading-[1.78] text-[#475569]">
                  PROOVRA's public Trust Center and legal documentation explain
                  the platform's boundaries, data handling, security posture,
                  subprocessors, AI use, verification methodology, and support
                  processes. These materials are designed for customers,
                  reviewers, procurement teams, and security evaluators who
                  need to understand how the platform operates.
                </p>
                <div className="mt-7 flex flex-wrap gap-3">
                  <Link
                    href="/trust"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-[#071B4D] px-5 text-[13.5px] font-semibold text-white shadow-[0_10px_24px_rgba(7,27,77,0.22)] transition hover:-translate-y-0.5"
                  >
                    Open Trust Center
                    <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                </div>
              </div>
            </RevealSection>

            {/* Trust Architecture — three layered bands. Each band groups
                the documents that belong to a domain of trust so the page
                reads as a trust ecosystem instead of a flat link list. */}
            <RevealSection direction="up">
              <div className="space-y-5">
                {(
                  [
                    {
                      band: "Privacy & Compliance",
                      accent: "#2563EB",
                      accentSoft: "#EFF6FF",
                      Icon: Scale,
                      body: "How customer and personal data is processed, retained, transferred, and disclosed.",
                      docs: [
                        { label: "Privacy Policy", href: "/legal/privacy" },
                        { label: "Data Processing Addendum (DPA)", href: "/legal/dpa" },
                        { label: "Subprocessors", href: "/legal/subprocessors" },
                        { label: "AI Use Policy", href: "/legal/ai-use-policy" },
                      ],
                    },
                    {
                      band: "Security & Verification",
                      accent: "#7C3AED",
                      accentSoft: "#F5F3FF",
                      Icon: ShieldCheck,
                      body: "How the platform secures records and what verification does and does not establish.",
                      docs: [
                        { label: "Security Overview", href: "/legal/security" },
                        { label: "Incident Response", href: "/legal/incident-response" },
                        { label: "Verification Methodology", href: "/legal/verification-methodology" },
                        { label: "Verification Disclaimer", href: "/legal/verification-disclaimer" },
                      ],
                    },
                    {
                      band: "Governance & Operations",
                      accent: "#0F766E",
                      accentSoft: "#ECFDF5",
                      Icon: Landmark,
                      body: "How customers govern access, retention, evidence handling, and support across the platform.",
                      docs: [
                        { label: "Trust Center", href: "/trust" },
                        { label: "Evidence Handling Policy", href: "/legal/evidence-handling" },
                        { label: "Acceptable Use Policy", href: "/legal/aup" },
                        { label: "Support Policy", href: "/legal/support" },
                      ],
                    },
                  ] as const
                ).map(({ band, accent, accentSoft, Icon, body, docs }) => (
                  <div
                    key={band}
                    className="relative overflow-hidden rounded-[20px] border bg-white shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
                    style={{ borderColor: "#E2E8F0" }}
                  >
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 w-[3px]"
                      style={{ background: accent }}
                    />
                    <div className="grid gap-6 p-6 md:grid-cols-[auto_1fr] md:gap-8 md:p-7">
                      <div className="flex items-start gap-3 md:max-w-[260px] md:flex-col md:gap-4">
                        <span
                          aria-hidden="true"
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px]"
                          style={{ background: accentSoft, color: accent }}
                        >
                          <Icon size={20} strokeWidth={1.9} />
                        </span>
                        <div>
                          <h3
                            className="text-[11.5px] font-bold uppercase tracking-[0.16em]"
                            style={{ color: accent }}
                          >
                            {band}
                          </h3>
                          <p className="mt-2 text-[13.5px] leading-[1.65] text-[#475569] md:text-[14px]">
                            {body}
                          </p>
                        </div>
                      </div>

                      <ul className="grid gap-2 sm:grid-cols-2">
                        {docs.map((d) => (
                          <li key={d.href}>
                            <Link
                              href={d.href}
                              className="group flex items-center justify-between rounded-[12px] border bg-white px-4 py-3 transition hover:-translate-y-0.5"
                              style={{ borderColor: "#E2E8F0" }}
                            >
                              <span className="flex items-center gap-2.5 text-[13.5px] font-medium text-[#0F172A]">
                                <span
                                  aria-hidden="true"
                                  className="block h-1.5 w-1.5 rounded-full"
                                  style={{ background: accent }}
                                />
                                {d.label}
                              </span>
                              <ArrowRight
                                size={13}
                                aria-hidden="true"
                                className="text-[#94A3B8] transition group-hover:translate-x-0.5"
                                style={{ color: accent }}
                              />
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ))}
              </div>
            </RevealSection>
          </div>
        </div>
      </section>

      {/* ───────────────────────────────────────────────────────────────
          Section 8 — BUILT FOR (enterprise industry layout)
          Two-column structure per row: left = industry name + small
          icon, right = use-case explanation. Reads like Palantir /
          Datadog industry pages, not a card grid.
          ─────────────────────────────────────────────────────────────── */}
      <section style={{ background: "#F8FAFC" }}>
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
          <div className="mb-12 max-w-[860px]">
            <SectionEyebrow tone="blue">Built for high-trust work</SectionEyebrow>
            <h2 className="mt-2 text-[1.85rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.2rem]">
              For teams that cannot treat evidence as ordinary files.
            </h2>
            <p className="mt-5 text-[15.5px] leading-[1.78] text-[#475569]">
              PROOVRA is designed for organizations that cannot treat important
              digital material as ordinary files. The platform supports
              workflows where records may later need to be reviewed,
              challenged, disclosed, audited, explained, governed, or
              independently verified.
            </p>
          </div>

          <RevealSection direction="up">
            <div
              className="overflow-hidden rounded-[24px] border bg-white shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
              style={{ borderColor: "#E2E8F0" }}
            >
              <ul
                className="divide-y"
                style={{ borderColor: "#F1F5F9" }}
              >
                {BUILT_FOR.map(({ Icon, ...c }) => (
                  <li
                    key={c.title}
                    className="grid items-start gap-6 px-6 py-7 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-12 md:px-9 md:py-8"
                    style={{ borderColor: "#F1F5F9" }}
                  >
                    <div className="flex items-start gap-3.5">
                      <span
                        aria-hidden="true"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]"
                        style={{
                          background: `${c.accent}14`,
                          color: c.accent,
                        }}
                      >
                        <Icon size={18} strokeWidth={1.9} />
                      </span>
                      <h3 className="text-[1.05rem] font-semibold tracking-[-0.01em] text-[#081426] md:text-[1.15rem]">
                        {c.title}
                      </h3>
                    </div>
                    <p className="text-[14.5px] leading-[1.78] text-[#475569]">
                      {c.body}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </RevealSection>
        </div>
      </section>

      {/* ───────────────────────────────────────────────────────────────
          Section 9 — LONG-TERM VISION
          Purple gradient panel removed per spec. Section now sits on a
          clean white-on-soft-silver page surface so the rhythm matches
          the rest of the About page.
          ─────────────────────────────────────────────────────────────── */}
      <section style={{ background: "#F8FAFC" }}>
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-24">
          <RevealSection direction="up">
            <div
              className="relative overflow-hidden rounded-[28px] border bg-white p-9 shadow-[0_2px_10px_rgba(8,18,22,0.03)] md:p-14"
              style={{ borderColor: "#DDE6F2" }}
            >
              <div className="relative grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
                <div>
                  <SectionEyebrow tone="violet">Where we are heading</SectionEyebrow>
                  <h2 className="mt-3 max-w-[640px] text-[1.95rem] font-semibold leading-[1.12] tracking-[-0.02em] text-[#081426] md:text-[2.3rem]">
                    A future where digital evidence is easier to understand and
                    verify.
                  </h2>
                  <p className="mt-5 max-w-[600px] text-[15.5px] leading-[1.78] text-[#475569]">
                    PROOVRA's long-term direction is not simply to store files.
                    The goal is to help make evidence operations more
                    transparent, reviewable, and independently verifiable
                    across organizations.
                  </p>
                  <p className="mt-4 max-w-[600px] text-[15px] leading-[1.78] text-[#475569]">
                    We believe evidence records, custody visibility,
                    verification packages, public verification surfaces, and
                    governance controls can become standard parts of how
                    sensitive digital material is handled — from capture to
                    review to external handoff.
                  </p>
                  <p className="mt-4 max-w-[600px] text-[15px] leading-[1.78] text-[#475569]">
                    That future requires careful boundaries. PROOVRA will
                    continue to separate technical verification from factual
                    conclusions, AI assistance from human judgment, and
                    recorded integrity signals from legal admissibility.
                  </p>
                  <p className="mt-4 max-w-[600px] text-[15px] leading-[1.78] text-[#475569]">
                    PROOVRA is not attempting to replace human judgment. The
                    long-term goal is to make evidence operations more
                    understandable, more reviewable, and easier to verify
                    across organizations. Future development should continue to
                    strengthen transparency, governance, reviewability, and
                    independent verification rather than replacing human
                    decision-making.
                  </p>
                </div>

                {/* Right-side flow strip — light enterprise card. */}
                <div className="relative">
                  <div
                    className="rounded-[20px] border p-6"
                    style={{
                      borderColor: "#E2E8F0",
                      background:
                        "linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%)",
                    }}
                  >
                    <div className="flex items-center gap-2 text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#64748B]">
                      <Compass size={15} aria-hidden="true" className="text-[#2563EB]" />
                      Evidence operations flow
                    </div>
                    <ol className="mt-5 grid gap-3">
                      {(
                        [
                          { label: "Capture", Icon: Camera, accent: "#FB923C" },
                          { label: "Preserve", Icon: Archive, accent: "#22D3EE" },
                          { label: "Verify", Icon: ShieldCheck, accent: "#A78BFA" },
                          { label: "Review", Icon: Eye, accent: "#34D399" },
                          { label: "Govern", Icon: Landmark, accent: "#F472B6" },
                        ] as const
                      ).map(({ label, Icon, accent }) => (
                        <li
                          key={label}
                          className="flex items-center gap-3 rounded-[12px] border bg-white px-4 py-3"
                          style={{ borderColor: "#E2E8F0" }}
                        >
                          <span
                            aria-hidden="true"
                            className="flex h-8 w-8 items-center justify-center rounded-full border"
                            style={{
                              background: `${accent}14`,
                              borderColor: `${accent}33`,
                              color: accent,
                            }}
                          >
                            <Icon size={15} strokeWidth={1.9} />
                          </span>
                          <span className="text-[14px] font-medium text-[#081426]">
                            {label}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              </div>
            </div>
          </RevealSection>
        </div>
      </section>

      {/* ───────────────────────────────────────────────────────────────
          Section 10 — FINAL CTA — matches Platform page FinalCTA style
          (navy → burgundy → violet linear gradient, no grid pattern).
          ─────────────────────────────────────────────────────────────── */}
      <section className="bg-white pb-16 pt-2 md:pb-20">
        <div className="mx-auto max-w-[1180px] px-6 md:px-8">
          <div
            className="relative overflow-hidden rounded-[28px] p-7 text-white shadow-[0_18px_50px_rgba(11,31,91,0.18)] md:p-9"
            style={{
              background:
                "linear-gradient(90deg,#0B1F5B 0%,#1D2E7A 25%,#8E1F3D 55%,#6A35C9 80%,#7C4DFF 100%)",
            }}
          >
            <div className="relative grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
              <div>
                <div
                  className="inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.18em]"
                  style={{ background: "rgba(11,31,91,0.35)", color: "#FFFFFF" }}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
                  See PROOVRA in practice
                </div>
                <h2
                  className="mt-3 max-w-[540px] text-[1.55rem] font-semibold leading-[1.18] tracking-[-0.02em] text-white md:text-[1.85rem]"
                >
                  See how PROOVRA works in practice.
                </h2>
                <p
                  className="mt-2.5 max-w-[560px] text-[13.5px] leading-[1.6]"
                  style={{ color: "rgba(255,255,255,0.88)" }}
                >
                  Explore how Evidence Records, verification pages, reports,
                  custody context, and trust documentation come together for
                  review-sensitive work.
                </p>
              </div>
              <div className="flex flex-col gap-3 md:items-end">
                <div className="flex flex-wrap gap-3 md:justify-end">
                  <Link
                    href="/request-demo"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-white px-5 text-[13.5px] font-semibold text-[#6A35C9] transition-all duration-200 hover:-translate-y-0.5 hover:text-[#5A2CC0]"
                    style={{ fontWeight: 600 }}
                  >
                    Request demo
                    <ArrowRight size={14} />
                  </Link>
                  <Link
                    href="/platform"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-white/40 px-5 text-[13.5px] font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/10"
                  >
                    Explore platform
                  </Link>
                </div>
                <Link
                  href="/brand/sample-report.pdf"
                  className="inline-flex items-center gap-1 text-[13px] font-semibold text-white/85 underline-offset-4 transition hover:text-white hover:underline md:justify-end"
                >
                  View sample report
                  <ArrowRight size={13} aria-hidden="true" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <EnterpriseFooter />
    </div>
  );
}
