"use client";

import React, { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { PhoneMockup } from "./phone-mockup";

function VelvetButton({
  children,
  dark = false,
  href = "#",
  bronze = false,
}: {
  children: React.ReactNode;
  dark?: boolean;
  href?: string;
  bronze?: boolean;
}) {
  return (
    <a
      href={href}
      className={`group relative inline-flex min-h-[52px] w-full items-center justify-center overflow-hidden rounded-[15px] border border-transparent px-5 text-center text-[0.95rem] font-semibold ui-transition active:scale-[0.985] sm:w-auto sm:px-7 md:px-8 ${
        bronze
          ? "hover-button-bronze"
          : dark
            ? "hover-button-secondary"
            : "hover-button-primary"
      }`}
    >
      <img
        src="/images/site-velvet-bg.webp.png"
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-center"
      />

      <div
        className={
          bronze
            ? "absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.68)_0%,rgba(6,16,20,0.82)_100%)]"
            : dark
              ? "absolute inset-0 bg-[linear-gradient(180deg,rgba(7,22,27,0.72)_0%,rgba(5,16,20,0.86)_100%)]"
              : "absolute inset-0 bg-[linear-gradient(180deg,rgba(9,28,33,0.62)_0%,rgba(6,18,22,0.82)_100%)]"
        }
      />

      <div
        className={
          bronze
            ? "absolute inset-0 rounded-[15px] border border-[rgba(183,157,132,0.46)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_10px_26px_rgba(0,0,0,0.22)]"
            : dark
              ? "absolute inset-0 rounded-[15px] border border-[rgba(183,157,132,0.34)] shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_10px_26px_rgba(0,0,0,0.24)]"
              : "absolute inset-0 rounded-[15px] border border-[rgba(183,157,132,0.38)] ring-1 ring-white/8 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_14px_30px_rgba(8,24,29,0.28)]"
        }
      />

      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.09)_0%,rgba(255,255,255,0.018)_34%,transparent_100%)]" />

      <span
        className={
          bronze
            ? "relative z-10 inline-flex items-center justify-center text-[#b79d84]"
            : dark
              ? "relative z-10 inline-flex items-center justify-center text-[#dce2df]"
              : "relative z-10 inline-flex items-center justify-center text-[#f3f5f4]"
        }
      >
        {children}
      </span>
    </a>
  );
}

const badges = [
  "Signed integrity records",
  "Trusted timestamps",
  "Verification page + report",
  "Review-ready evidence trail",
];

const bronzeText = "#b79d84";
const bronzeSoft = "#a88f78";
const bronzeBorder = "rgba(183,157,132,0.24)";

export function Hero({
  appRegister,
  demoUrl,
  sampleReportUrl,
}: {
  appRegister: string;
  demoUrl: string;
  sampleReportUrl: string;
}) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setRevealed(true), 120);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <section className="relative w-full px-4 pb-5 pt-6 sm:px-6 sm:pt-8 md:px-8 md:pb-7 md:pt-10">
      <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-10">
        <div className="relative min-w-0 pt-1 lg:pt-4">
          <div className="pointer-events-none absolute -left-10 top-6 h-40 w-40 rounded-full bg-[#7eb5ae]/10 blur-3xl" />
          <div className="pointer-events-none absolute left-24 top-24 h-24 w-24 rounded-full bg-white/[0.05] blur-2xl" />
          <div className="pointer-events-none absolute left-0 top-20 h-56 w-56 rounded-full bg-[#8fd2c8]/[0.05] blur-[100px]" />
          <div className="pointer-events-none absolute -left-6 top-44 h-72 w-72 rounded-full bg-[#1d3a40]/20 blur-[120px]" />

          <div
            className={`relative z-10 inline-flex max-w-full items-center gap-[0.62rem] rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-[0.72rem] font-bold uppercase tracking-[0.18em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md transition-all duration-700 sm:w-fit sm:px-5 sm:text-[0.8rem] md:text-[0.86rem] ${
              revealed ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
            }`}
          >
            <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#b79d84] opacity-95" />
            <span className="leading-none [overflow-wrap:anywhere]">
              Evidence Verification Platform
            </span>
          </div>

          <div className="relative z-10 mt-5 max-w-[680px] min-w-0">
            <h1 className="tracking-[-0.045em] text-[#e9edea]">
              <div
                className={`transition-all duration-700 ${
                  revealed ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
                }`}
                style={{ transitionDelay: "160ms" }}
              >
                <span className="block text-[1.82rem] font-bold leading-[0.95] sm:text-[2rem] md:text-[2.55rem] lg:text-[2.9rem]">
                  Turn files into
                </span>
                <span className="mt-2 block text-[1.82rem] font-bold leading-[0.95] text-[#f1f4f2] sm:text-[2rem] md:text-[2.55rem] lg:text-[2.9rem]">
                  verifiable digital evidence
                </span>
              </div>

              <div
                className={`mt-4 transition-all duration-700 ${
                  revealed ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
                }`}
                style={{ transitionDelay: "310ms" }}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
                  <span className="text-[1.08rem] font-normal leading-[1.12] text-[#d6ddda] sm:text-[1.16rem] md:text-[1.4rem] lg:text-[1.55rem]">
                    with{" "}
                    <span className="font-semibold text-[#bfe8df]">
                      signed integrity records
                    </span>
                  </span>

                  <span className="text-[1.08rem] font-semibold leading-[1.12] text-[#edf1ef] sm:text-[1.16rem] md:text-[1.4rem] lg:text-[1.55rem]">
                    trusted timestamps
                  </span>
                </div>

                <span
                  className="mt-2 block text-[1.08rem] font-medium leading-[1.12] sm:text-[1.16rem] md:text-[1.4rem] lg:text-[1.55rem]"
                  style={{ color: bronzeText }}
                >
                  and a defensible review trail
                </span>
              </div>
            </h1>

            <div
              className={`mt-5 h-px w-24 transition-all duration-700 ${
                revealed ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
              }`}
              style={{
                transitionDelay: "520ms",
                background:
                  "linear-gradient(90deg, rgba(191,232,223,0.92) 0%, rgba(183,157,132,0.42) 58%, transparent 100%)",
              }}
            />
          </div>

          <p
            className={`relative z-10 mt-5 max-w-[700px] text-[0.97rem] font-normal leading-[1.78] tracking-[-0.012em] text-[#c7cfcc] transition-all duration-700 sm:text-[1rem] md:text-[1.04rem] ${
              revealed ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
            }`}
            style={{ transitionDelay: "640ms" }}
          >
            <span className="font-semibold text-[#e7ece9]">PROOVRA</span> helps
            teams and professionals turn uploaded or captured files into{" "}
            <span className="font-semibold text-[#e6ebe8]">
              review-ready evidence records
            </span>{" "}
            with{" "}
            <span className="font-semibold text-[#bfe8df]">
              integrity checks, timestamp history, verification output,
            </span>{" "}
            and a{" "}
            <span style={{ color: bronzeText }} className="font-semibold">
              structured report
            </span>{" "}
            that stays clearer under disputes, audits, investigations, and
            claims review.
          </p>

          <div
            className={`relative z-10 mt-5 flex max-w-[760px] flex-col gap-3 transition-all duration-700 sm:flex-row sm:flex-wrap ${
              revealed ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
            }`}
            style={{ transitionDelay: "890ms" }}
          >
            <VelvetButton href={appRegister}>Upload evidence</VelvetButton>

            <VelvetButton bronze href={sampleReportUrl}>
              <>
                View sample report
                <ExternalLink className="ml-2 h-[15px] w-[15px] shrink-0 text-[#b79d84] stroke-[2.2]" />
              </>
            </VelvetButton>

            <VelvetButton dark href={demoUrl}>
              Request demo
            </VelvetButton>
          </div>

          <div
            className={`relative z-10 mt-4 transition-all duration-700 ${
              revealed ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
            }`}
            style={{ transitionDelay: "1080ms" }}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.84rem] font-medium text-[#cfd7d3] sm:text-[0.86rem]">
              <span className="h-2 w-2 rounded-full bg-[#9ed8cf] shadow-[0_0_10px_rgba(158,216,207,0.45)]" />
              <span className="text-[#e2e8e5]">Built for legal, compliance, claims, and investigations</span>
            </div>
          </div>

          <div
            className={`relative z-10 mt-5 flex max-w-[760px] flex-wrap gap-2.5 transition-all duration-700 ${
              revealed ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
            }`}
            style={{ transitionDelay: "1180ms" }}
          >
            {badges.map((badge, index) => (
              <div
                key={badge}
                className={`max-w-full rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.74rem] text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md ui-transition sm:text-[0.78rem] ${
                  index === 2 ? "hover-chip-bronze" : "hover-chip"
                }`}
                style={
                  index === 2
                    ? {
                        borderColor: bronzeBorder,
                        color: "#e1d4c7",
                        background:
                          "linear-gradient(180deg, rgba(183,157,132,0.08) 0%, rgba(255,255,255,0.03) 100%)",
                      }
                    : undefined
                }
              >
                <span
                  className="mr-2"
                  style={{ color: index === 2 ? bronzeSoft : "#9dd2ca" }}
                >
                  ✓
                </span>
                <span className="[overflow-wrap:anywhere]">{badge}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="relative flex min-w-0 justify-center lg:justify-end">
          <div className="pointer-events-none absolute right-[14%] top-[8%] z-0 hidden h-72 w-72 rounded-full bg-[#6ca39e]/12 blur-3xl lg:block" />
          <div className="pointer-events-none absolute right-[10%] top-[26%] z-0 hidden h-48 w-48 rounded-full bg-white/[0.045] blur-3xl lg:block" />
          <div className="pointer-events-none absolute right-[26%] bottom-[8%] z-0 hidden h-44 w-44 rounded-full bg-[#214147]/30 blur-3xl lg:block" />
          <div
            className="pointer-events-none absolute right-[20%] top-[44%] z-0 hidden h-40 w-40 rounded-full blur-[90px] lg:block"
            style={{ background: "rgba(183,157,132,0.08)" }}
          />

          <div className="pointer-events-none absolute right-[1.5%] top-[36%] z-10 hidden grid-cols-4 gap-3 opacity-65 lg:grid">
            {Array.from({ length: 16 }).map((_, i) => (
              <span
                key={i}
                className="h-2 w-2 rounded-full bg-[#98d3cd] shadow-[0_0_14px_rgba(152,211,205,0.45)]"
              />
            ))}
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-[6%] z-0 mx-auto hidden h-16 w-[64%] rounded-full bg-black/25 blur-2xl lg:block" />

          <div
            className={`relative z-20 w-full max-w-[340px] transition-all duration-[1100ms] ${
              revealed ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
            } sm:max-w-[360px] md:max-w-[390px] lg:max-w-[360px] lg:-translate-x-6 xl:max-w-[390px] xl:-translate-x-10`}
            style={{ transitionDelay: "360ms" }}
          >
            <div className="pointer-events-none absolute -inset-6 rounded-[40px] bg-[radial-gradient(circle_at_center,rgba(132,204,193,0.10)_0%,transparent_65%)] blur-2xl sm:-inset-8" />
            <PhoneMockup />
          </div>
        </div>
      </div>
    </section>
  );
}