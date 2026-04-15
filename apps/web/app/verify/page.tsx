"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../components/ui";
import { MarketingHeader } from "../../components/header";
import { Footer } from "../../components/Footer";
import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";

function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2l7 3v6c0 5.25-3.438 10.125-7 11-3.562-.875-7-5.75-7-11V5l7-3Zm0 2.18L7 6.32V11c0 4.164 2.61 8.11 5 8.95 2.39-.84 5-4.786 5-8.95V6.32l-5-2.14Z"
      />
    </svg>
  );
}

function FingerprintIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 3a6 6 0 0 0-6 6v1a1 1 0 1 0 2 0V9a4 4 0 0 1 8 0v1a1 1 0 1 0 2 0V9a6 6 0 0 0-6-6Zm0 5a1 1 0 0 0-1 1v2a9 9 0 0 0 2.638 6.362l1.655 1.655a1 1 0 1 0 1.414-1.414l-1.655-1.655A7 7 0 0 1 13 11V9a1 1 0 0 0-1-1Zm-4 3a1 1 0 0 0-1 1c0 2.673.948 5.26 2.676 7.296a1 1 0 0 0 1.524-1.296A9.19 9.19 0 0 1 9 12a1 1 0 0 0-1-1Zm8 0a1 1 0 0 0-1 1c0 1.978.77 3.838 2.168 5.236a1 1 0 0 0 1.414-1.414A5.36 5.36 0 0 1 17 12a1 1 0 0 0-1-1Zm-4 4a1 1 0 0 0-.832 1.555l1.6 2.4a1 1 0 1 0 1.664-1.11l-1.6-2.4A1 1 0 0 0 12 15Z"
      />
    </svg>
  );
}

function TimelineIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v3H3V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1Zm14 9v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7h18ZM7 14h4a1 1 0 1 0 0-2H7a1 1 0 1 0 0 2Zm0 4h7a1 1 0 1 0 0-2H7a1 1 0 1 0 0 2Z"
      />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Zm3 3a2 2 0 0 1 1 3.732V18a1 1 0 1 1-2 0v-1.268A2 2 0 0 1 12 13Z"
      />
    </svg>
  );
}

const TRUST_ITEMS = [
  {
    title: "Recorded integrity state and signature review",
    description:
      "Inspect the recorded file hash, fingerprint state, signature materials, and core integrity checks associated with the evidence record.",
    icon: <FingerprintIcon />,
    accent: "teal",
  },
  {
    title: "Custody trail and review activity",
    description:
      "Review the forensic custody sequence separately from access-related viewing or download activity for clearer external and internal review.",
    icon: <TimelineIcon />,
    accent: "silver",
  },
  {
    title: "Timing and preservation context",
    description:
      "Review TSA status, OpenTimestamps status, immutable storage signals, and related timing or publication context when recorded.",
    icon: <LockIcon />,
    accent: "bronze",
  },
] as const;

function SilverCardShell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-[28px] border border-[#4f706b]/18 shadow-[0_18px_38px_rgba(0,0,0,0.07),inset_0_1px_0_rgba(255,255,255,0.48)] ${className}`}
    >
      <img
        src="/images/panel-silver.webp.png"
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-center"
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

export default function VerifyIntroPage() {
  const [token, setToken] = useState("");
  const router = useRouter();

  const trimmedToken = token.trim();
  const canSubmit = trimmedToken.length > 0;

  const ui = useMemo(
    () => ({
      inputShadow: "0 14px 32px rgba(6, 16, 22, 0.08)",
    }),
    []
  );

  const handleVerify = () => {
    if (!canSubmit) return;
    router.push(`/verify/${encodeURIComponent(trimmedToken)}`);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleVerify();
    }
  };

  return (
    <div className="page landing-page">
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
              <div className="inline-flex items-center gap-[0.72rem] rounded-full border border-white/10 bg-white/[0.055] px-5 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#b79d84] opacity-95" />
                Verify
              </div>

              <h1 className="mt-5 max-w-[700px] text-[1.72rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.28rem] lg:text-[2.9rem]">
                Review digital evidence through a{" "}
                <span className="text-[#bfe8df]">
                  verification-first reviewer-facing record
                </span>
                .
              </h1>

              <p className="mt-5 max-w-[720px] text-[0.96rem] leading-[1.8] tracking-[-0.006em] text-[#c7cfcc] md:text-[1rem]">
                Open a PROOVRA verification token or public verification ID to
                inspect the recorded integrity state, supporting review
                materials, identity context, custody history, access activity,
                timing context, storage-protection indicators, and technical
                verification details where available.
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9dd2ca]">✓</span>
                  Read-only verification flow
                </div>

                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9dd2ca]">✓</span>
                  No account required for inspection
                </div>

                <div className="rounded-full border border-[rgba(214,184,157,0.24)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] px-3.5 py-2 text-[0.78rem] text-[#e1d4c7] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#d6b89d]">✓</span>
                  Built for later scrutiny
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

        <div className="container relative z-10 mx-auto max-w-7xl px-6 md:px-8">
          <section
            className="grid gap-6 lg:grid-cols-[1.08fr_0.92fr]"
            style={{ maxWidth: 1120, margin: "0 auto" }}
          >
            <SilverCardShell className="min-h-[560px]">
              <div className="flex h-full flex-col justify-between p-7 md:p-8">
                <div className="grid gap-6">
                  <div className="inline-flex w-fit items-center gap-2.5 rounded-full border border-[#23373b]/8 bg-[rgba(35,55,59,0.05)] px-4 py-2.5 text-[0.76rem] font-semibold uppercase tracking-[0.18em] text-[#566366]">
                    <span className="text-[#3f5e62]">
                      <ShieldIcon />
                    </span>
                    Verification portal
                  </div>

                  <div className="grid gap-4">
                    <h2 className="m-0 max-w-[720px] text-[1.9rem] font-semibold leading-[1.02] tracking-[-0.04em] text-[#16282d] md:text-[2.45rem]">
                      Review digital evidence through a{" "}
                      <span className="text-[#3e6b68]">
                        clear recorded integrity and verification record
                      </span>
                      .
                    </h2>

                    <p className="m-0 max-w-[760px] text-[1rem] leading-[1.82] text-[#5c6a6e]">
                      Enter a verification token to inspect recorded integrity
                      state, signature materials, custody history, access
                      activity, timing context, storage-protection indicators,
                      identity summary, and supporting verification materials
                      when they are recorded for the evidence.
                    </p>

                    <p className="m-0 max-w-[760px] text-[0.92rem] leading-[1.78] text-[#697679]">
                      The verification view is designed to support technical,
                      operational, and legal review of the recorded evidence
                      state. It helps reviewers inspect preservation signals and
                      supporting materials, but does not independently establish
                      authorship, factual truth, identity, legal admissibility,
                      or evidentiary weight.
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-3">
                    {TRUST_ITEMS.map((item) => {
                      const isTeal = item.accent === "teal";
                      const isBronze = item.accent === "bronze";

                      return (
                        <div
                          key={item.title}
                          className="grid gap-3 rounded-[22px] border p-5"
                          style={{
                            background: isBronze
                              ? "linear-gradient(180deg, rgba(255,255,255,0.78) 0%, rgba(248,245,241,0.94) 100%)"
                              : "linear-gradient(180deg, rgba(255,255,255,0.76) 0%, rgba(245,246,244,0.92) 100%)",
                            border: isBronze
                              ? "1px solid rgba(183,157,132,0.16)"
                              : "1px solid rgba(35,55,59,0.08)",
                            boxShadow: "0 12px 28px rgba(0,0,0,0.05)",
                          }}
                        >
                          <div
                            className="grid h-10 w-10 place-items-center rounded-[14px]"
                            style={{
                              background: isTeal
                                ? "rgba(62,107,104,0.10)"
                                : isBronze
                                  ? "rgba(183,157,132,0.14)"
                                  : "rgba(35,55,59,0.08)",
                              color: isTeal ? "#2d5f5c" : isBronze ? "#9b826b" : "#2f474c",
                            }}
                          >
                            {item.icon}
                          </div>

                          <div
                            className="text-[0.98rem] font-semibold leading-[1.35]"
                            style={{
                              color: isTeal ? "#18383d" : isBronze ? "#7f6450" : "#1e3237",
                            }}
                          >
                            {item.title}
                          </div>

                          <div className="text-[0.88rem] leading-[1.65] text-[#667174]">
                            {item.description}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-8 flex flex-wrap gap-2.5">
                  {[
                    "Recorded integrity and signature checks",
                    "Custody trail and review activity",
                    "TSA / OTS / anchor visibility",
                    "Storage-protection context",
                  ].map((item, index) => (
                    <span
                      key={item}
                      className="rounded-full border px-3.5 py-2 text-[0.8rem] font-medium backdrop-blur-md"
                      style={
                        index === 2
                          ? {
                              border: "1px solid rgba(183,157,132,0.20)",
                              background:
                                "linear-gradient(180deg, rgba(183,157,132,0.10) 0%, rgba(255,255,255,0.08) 100%)",
                              color: "#9b826b",
                            }
                          : {
                              border: "1px solid rgba(35,55,59,0.08)",
                              background: "rgba(35,55,59,0.05)",
                              color: "#37595d",
                            }
                      }
                    >
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            </SilverCardShell>

            <SilverCardShell className="min-h-[560px]">
              <div className="flex h-full flex-col justify-center p-7 md:p-8">
                <div className="grid gap-5">
                  <div className="grid gap-2.5">
                    <div className="text-[0.76rem] font-semibold uppercase tracking-[0.18em] text-[#5f6d71]">
                      Open verification
                    </div>

                    <h2 className="m-0 text-[1.75rem] font-semibold leading-[1.08] tracking-[-0.03em] text-[#1b2f34] md:text-[2rem]">
                      Enter the verification token
                    </h2>

                    <p className="m-0 text-[0.96rem] leading-[1.82] text-[#627277]">
                      Paste the token from a PROOVRA report, public verification
                      link, or shared verification record to open the structured
                      review page.
                    </p>
                  </div>

                  <div className="grid gap-4 rounded-[22px] border border-[#23373b]/8 bg-[rgba(255,255,255,0.38)] p-5 backdrop-blur-md">
                    <label
                      htmlFor="verification-token"
                      className="text-[0.82rem] font-semibold text-[#405357]"
                    >
                      Verification token or public verification ID
                    </label>

                    <input
                      id="verification-token"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Paste token here"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      inputMode="text"
                      spellCheck={false}
                      aria-describedby="verification-token-help"
                      style={{
                        width: "100%",
                        height: 58,
                        borderRadius: 16,
                        border: "1px solid rgba(79,112,107,0.16)",
                        background: "rgba(255,255,255,0.92)",
                        color: "#0f172a",
                        padding: "0 18px",
                        fontSize: 16,
                        fontWeight: 500,
                        outline: "none",
                        boxShadow: ui.inputShadow,
                      }}
                    />

                    <div
                      id="verification-token-help"
                      className="text-[0.82rem] leading-[1.65] text-[#667174]"
                    >
                      This opens a read-only verification view with recorded
                      integrity state, identity context, custody events, access
                      activity, timing context, storage protection, and
                      technical materials where available.
                    </div>

                    <Button
                      onClick={handleVerify}
                      disabled={!canSubmit}
                      className="h-[52px] rounded-[16px] px-5 text-[0.96rem] font-medium"
                    >
                      Open verification
                    </Button>
                  </div>

                  <div className="grid gap-3 pt-1">
                    {[
                      "Review the recorded evidence state without changing the underlying evidence record.",
                      "Inspect integrity results, custody events, review activity, timing context, identity details, storage-protection signals, and supporting verification materials.",
                      "Useful for external review, legal handoff, compliance review, insurance review, internal escalation, and independent technical checking.",
                    ].map((item, index) => (
                      <div
                        key={item}
                        className="flex items-start gap-3 text-[0.92rem] leading-[1.72] text-[#516267]"
                      >
                        <span
                          className="mt-[0.1rem] inline-grid h-[22px] w-[22px] place-items-center rounded-full text-[0.72rem] font-semibold"
                          style={{
                            background:
                              index === 1
                                ? "rgba(214,184,157,0.18)"
                                : "rgba(62,107,104,0.12)",
                            color: index === 1 ? "#9b826b" : "#376764",
                            flexShrink: 0,
                          }}
                        >
                          ✓
                        </span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-[18px] border border-[rgba(183,157,132,0.16)] bg-[linear-gradient(180deg,rgba(255,255,255,0.74)_0%,rgba(248,245,241,0.94)_100%)] p-4 text-[0.84rem] leading-[1.7] text-[#6a5b4f]">
                    This portal verifies the recorded integrity state and
                    supporting review materials only. It does not independently
                    establish authorship, factual truth, identity, legal
                    admissibility, procedural validity, or evidentiary weight.
                    Those questions remain subject to legal, judicial,
                    administrative, or expert assessment.
                  </div>

                  <div className="mt-2 flex flex-wrap justify-between gap-3 border-t border-[#23373b]/8 pt-4 text-[0.8rem] text-[#6a777b]">
                    <span>Read-only verification flow</span>
                    <span>No account required for inspection</span>
                  </div>
                </div>
              </div>
            </SilverCardShell>
          </section>
        </div>
      </SilverWatermarkSection>

      <Footer />
    </div>
  );
}