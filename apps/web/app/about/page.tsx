"use client";

import { MarketingHeader } from "../../components/header";
import { Footer } from "../../components/Footer";
import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";

export default function AboutPage() {
  return (
    <div className="page landing-page about-page">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.74)_38%,rgba(8,18,22,0.66)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_16%,rgba(158,216,207,0.09),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_24%,rgba(214,184,157,0.06),transparent_18%)]" />
        <div className="absolute inset-0 opacity-[0.04] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.026)_0px,rgba(255,255,255,0.026)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10">
          <MarketingHeader />

          <section className="mx-auto max-w-7xl px-6 pb-16 pt-10 md:px-8 md:pb-20 md:pt-14">
            <div className="max-w-[760px]">
              <div className="inline-flex rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
              <span className="h-1.5 w-1.5 rounded-full bg-[#b79d84] opacity-90" />
                About
              </div>

              <h1 className="mt-5 max-w-[640px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                About <span className="text-[#bfe8df]">PROO✓RA</span>
              </h1>

              <p className="mt-5 max-w-[650px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                PROO✓RA is a verifiable digital evidence platform built to{" "}
                <span className="text-[#bfe8df]">capture</span>,{" "}
                <span className="text-[#e6ebe8]">seal</span>, and{" "}
                <span className="text-[#d6b89d]">prove integrity</span> through
                cryptographic fingerprints, trusted timestamps, and a transparent
                chain of custody.
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9dd2ca]">✓</span>
                  Integrity-first platform
                </div>

                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9dd2ca]">✓</span>
                  Verification-ready workflows
                </div>

                <div className="rounded-full border border-[rgba(214,184,157,0.24)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#e1d4c7] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#d6b89d]">✓</span>
                  Built for scrutiny
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <SilverWatermarkSection
        className="section section-body relative overflow-hidden"
        style={{ paddingTop: 48, paddingBottom: 56 }}
      >
        <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          <img
            src="/images/landing-network-bg.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.12] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_22%,rgba(255,255,255,0.03)_78%,rgba(255,255,255,0.08)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.03)_12%,rgba(255,255,255,0.00)_24%,rgba(255,255,255,0.00)_76%,rgba(255,255,255,0.03)_88%,rgba(255,255,255,0.10)_100%)]" />
        </div>

        <div className="container relative z-10">
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] shadow-[0_30px_80px_rgba(0,0,0,0.14)]">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-center"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />
              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                  At a glance
                </div>
                <ul className="mt-4 grid gap-3">
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    Capture evidence with context and timestamps.
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    Lock integrity using cryptographic fingerprints.
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    Review custody events in a clear timeline.
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    Verify &amp; share via a neutral verification view or PDF report.
                  </li>
                </ul>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] shadow-[0_30px_80px_rgba(0,0,0,0.14)]">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-center"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />
              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                  How it works
                </div>
                <ol className="mt-4 grid gap-3 counter-reset-[about-counter]">
                  <li className="relative list-none pl-10 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.18rem] before:flex before:h-7 before:w-7 before:items-center before:justify-center before:rounded-full before:border before:border-[rgba(183,157,132,0.28)] before:bg-[rgba(183,157,132,0.10)] before:text-[0.78rem] before:font-semibold before:text-[#8f735a] before:content-[counter(about-counter)] [counter-increment:about-counter]">
                    <strong className="font-semibold text-[#1f3438]">Capture</strong> a photo,
                    video, document, or file with context.
                  </li>
                  <li className="relative list-none pl-10 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.18rem] before:flex before:h-7 before:w-7 before:items-center before:justify-center before:rounded-full before:border before:border-[rgba(183,157,132,0.28)] before:bg-[rgba(183,157,132,0.10)] before:text-[0.78rem] before:font-semibold before:text-[#8f735a] before:content-[counter(about-counter)] [counter-increment:about-counter]">
                    <strong className="font-semibold text-[#1f3438]">Fingerprint</strong> it
                    cryptographically to create a verifiable integrity record.
                  </li>
                  <li className="relative list-none pl-10 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.18rem] before:flex before:h-7 before:w-7 before:items-center before:justify-center before:rounded-full before:border before:border-[rgba(183,157,132,0.28)] before:bg-[rgba(183,157,132,0.10)] before:text-[0.78rem] before:font-semibold before:text-[#8f735a] before:content-[counter(about-counter)] [counter-increment:about-counter]">
                    <strong className="font-semibold text-[#1f3438]">Custody</strong> events
                    form a timeline that can be reviewed later.
                  </li>
                  <li className="relative list-none pl-10 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.18rem] before:flex before:h-7 before:w-7 before:items-center before:justify-center before:rounded-full before:border before:border-[rgba(183,157,132,0.28)] before:bg-[rgba(183,157,132,0.10)] before:text-[0.78rem] before:font-semibold before:text-[#8f735a] before:content-[counter(about-counter)] [counter-increment:about-counter]">
                    <strong className="font-semibold text-[#1f3438]">Verify &amp; report</strong>{" "}
                    through a shareable verification view or PDF output.
                  </li>
                </ol>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] shadow-[0_30px_80px_rgba(0,0,0,0.14)]">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-center"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />
              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                  Important note
                </div>
                <p className="mt-4 text-[0.98rem] leading-[1.88] text-[#55666a]">
                  PROO✓RA is not a court, a law-enforcement authority, or a legal service
                  provider. Verification confirms the integrity and provenance of digital
                  evidence — not the truthfulness or legal validity of the content itself.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] shadow-[0_30px_80px_rgba(0,0,0,0.14)]">
            <img
              src="/images/panel-silver.webp.png"
              alt=""
              className="absolute inset-0 h-full w-full object-cover object-center"
            />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />

            <div className="relative z-10 px-6 py-7 md:px-10 md:py-10 lg:px-12 lg:py-12 text-[#33464a]">
              <h2 className="mb-4 text-[1.42rem] font-semibold leading-[1.15] tracking-[-0.03em] text-[#1d3136]">
                Why PROO✓RA exists
              </h2>
              <p className="mb-6 text-[0.98rem] leading-[1.92] text-[#55666a]">
                In a world where digital content can be altered, disputed, or dismissed in
                seconds, trust has become fragile. PROO✓RA exists to restore that trust — by
                making integrity independently verifiable.
              </p>

              <h2 className="mb-4 mt-10 text-[1.42rem] font-semibold leading-[1.15] tracking-[-0.03em] text-[#1d3136]">
                What makes PROO✓RA different
              </h2>

              <div className="mb-6 rounded-[24px] border border-[rgba(79,112,107,0.18)] bg-[rgba(255,255,255,0.30)] p-6 shadow-[0_12px_28px_rgba(0,0,0,0.05)]">
                <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                  Integrity &amp; Verification Stack
                </div>
                <ul className="mt-4 grid gap-3">
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    Cryptographic hashing (SHA-256) to fingerprint every file
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    Trusted timestamping (TSA) for time-based proof
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    Optional independent anchoring (e.g. OpenTimestamps)
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    Immutable chain-of-custody tracking
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    Signed PDF reports for external verification
                  </li>
                </ul>
              </div>

              <p className="mb-6 text-[0.98rem] leading-[1.92] text-[#55666a]">
                PROO✓RA is not just storage. It is not file sharing. And it is not a legal
                shortcut. It is a verifiable, cryptographically-backed evidence system designed
                for high-trust environments.
              </p>

              <div className="mb-6 rounded-[24px] border border-[rgba(79,112,107,0.18)] bg-[rgba(255,255,255,0.30)] p-6 shadow-[0_12px_28px_rgba(0,0,0,0.05)]">
                <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                  Every supported file can be
                </div>
                <ul className="mt-4 grid gap-3">
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    cryptographically fingerprinted,
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    securely stored,
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    time-bound to a verifiable moment,
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    linked to an immutable custody record,
                  </li>
                  <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                    independently verified without exposing the original content.
                  </li>
                </ul>
              </div>

              <h2 className="mb-4 mt-10 text-[1.42rem] font-semibold leading-[1.15] tracking-[-0.03em] text-[#1d3136]">
                Who PROO✓RA is built for
              </h2>
              <p className="mb-6 text-[0.98rem] leading-[1.92] text-[#55666a]">
                Teams that need proof that stands up to scrutiny — not screenshots.
              </p>

              <div className="grid gap-6 lg:grid-cols-2">
                <div className="rounded-[24px] border border-[rgba(79,112,107,0.18)] bg-[rgba(255,255,255,0.30)] p-6 shadow-[0_12px_28px_rgba(0,0,0,0.05)]">
                  <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                    Common users
                  </div>
                  <ul className="mt-4 grid gap-3">
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      legal professionals preparing or defending cases,
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      compliance and risk teams documenting critical events,
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      journalists and investigators protecting source material,
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      companies safeguarding sensitive operational evidence,
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      insurance and claims teams handling disputes.
                    </li>
                  </ul>
                </div>

                <div className="rounded-[24px] border border-[rgba(79,112,107,0.18)] bg-[rgba(255,255,255,0.30)] p-6 shadow-[0_12px_28px_rgba(0,0,0,0.05)]">
                  <div className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#8e7863]">
                    Principles
                  </div>
                  <ul className="mt-4 grid gap-3">
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Integrity first — evidence must speak for itself.
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      No silent modifications — changes are visible or impossible.
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      User control — you decide what to capture and what to share.
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Neutral by design — we preserve integrity, not meaning.
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Built for scrutiny — outputs are designed to be questioned.
                    </li>
                  </ul>
                </div>
              </div>

              <h2 className="mb-4 mt-10 text-[1.42rem] font-semibold leading-[1.15] tracking-[-0.03em] text-[#1d3136]">
                Limitations
              </h2>

              <h3 className="mb-3 mt-8 text-[1.05rem] font-semibold uppercase tracking-[0.14em] text-[#8e7863]">
                Verification, not trust
              </h3>
              <p className="mb-6 text-[0.98rem] leading-[1.92] text-[#55666a]">
                PROO✓RA is designed so that evidence does not need to be trusted — it can be
                independently verified. Anyone with access to the verification data can confirm
                integrity without relying on PROO✓RA itself.
              </p>

              <ul className="grid gap-3">
                <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                  PROO✓RA does not provide legal advice.
                </li>
                <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                  PROO✓RA does not guarantee admissibility in any jurisdiction.
                </li>
                <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                  PROO✓RA does not replace legal, forensic, or investigative professionals.
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-6 relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] shadow-[0_30px_80px_rgba(0,0,0,0.14)]">
            <img
              src="/images/panel-silver.webp.png"
              alt=""
              className="absolute inset-0 h-full w-full object-cover object-center"
            />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />

            <div className="relative z-10 px-6 py-7 md:px-10 md:py-10 lg:px-12 lg:py-12">
              <h2 className="mb-3 text-[1.6rem] font-semibold leading-[1.08] tracking-[-0.035em] text-[#1d3136]">
                Built for High-Stakes Environments
              </h2>

              <p className="mb-8 text-[0.98rem] leading-[1.88] text-[#55666a]">
                When outcomes carry legal, financial, or reputational consequences, evidence
                cannot rely on trust alone — it must withstand examination.
              </p>

              <div className="grid gap-8 lg:grid-cols-2">
                <div>
                  <h3 className="mb-3 text-[1.05rem] font-semibold uppercase tracking-[0.14em] text-[#8e7863]">
                    Legal &amp; dispute-driven use cases
                  </h3>
                  <ul className="grid gap-3">
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Documenting incidents prior to litigation
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Preserving time-sensitive materials
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Supporting investigations and disclosure workflows
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Preparing evidence for review or expert analysis
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="mb-3 text-[1.05rem] font-semibold uppercase tracking-[0.14em] text-[#8e7863]">
                    Corporate, compliance &amp; investigations
                  </h3>
                  <ul className="grid gap-3">
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Incident reviews and internal investigations
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Regulatory / compliance documentation
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Whistleblower-related evidence handling
                    </li>
                    <li className="relative list-none pl-6 text-[0.98rem] leading-[1.8] text-[#55666a] before:absolute before:left-0 before:top-[0.78rem] before:h-2 before:w-2 before:rounded-full before:bg-[#7ea9a2] before:content-['']">
                      Post-incident reporting and audits
                    </li>
                  </ul>
                </div>
              </div>

              <h3 className="mb-3 mt-10 text-[1.05rem] font-semibold uppercase tracking-[0.14em] text-[#8e7863]">
                Journalism &amp; sensitive documentation
              </h3>
              <p className="text-[0.98rem] leading-[1.88] text-[#55666a]">
                Preserve integrity without publicly exposing sources or raw content —
                verification can happen independently, while access stays controlled by the
                owner.
              </p>

              <div className="my-8 h-px bg-[linear-gradient(90deg,transparent_0%,rgba(79,112,107,0.18)_18%,rgba(183,157,132,0.26)_50%,rgba(79,112,107,0.18)_82%,transparent_100%)]" />

              <p className="mb-0 text-[0.92rem] leading-[1.8] text-[#6a787b]">
                PROO✓RA is a technical integrity platform. It does not provide legal advice
                and does not guarantee admissibility of evidence in any jurisdiction.
              </p>
            </div>
          </div>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}