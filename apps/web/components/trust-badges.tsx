"use client";

import { Fingerprint, Shield, FileCheck, Clock3 } from "lucide-react";

const badges = [
  {
    icon: Fingerprint,
    label: "SHA-256 fingerprinting",
  },
  {
    icon: Shield,
    label: "Protected verification workflow",
  },
  {
    icon: FileCheck,
    label: "Audit-ready PDF reports",
  },
  {
    icon: Clock3,
    label: "Chain-of-custody visibility",
  },
];

export function TrustBadges() {
  return (
    <section className="w-full px-4 pb-7 pt-5 sm:px-6 md:px-8 md:pb-9">
      <div className="mx-auto max-w-7xl overflow-hidden rounded-[22px] border border-white/10 shadow-[0_14px_26px_rgba(0,0,0,0.10)]">
        <div className="relative">
          <img
            src="/images/panel-silver.webp.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />

          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.20)_0%,rgba(255,255,255,0.10)_45%,rgba(255,255,255,0.06)_100%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_24%_18%,rgba(255,255,255,0.32),transparent_28%)] opacity-70" />

          <div className="relative z-10 grid grid-cols-1 gap-4 px-4 py-5 sm:grid-cols-2 sm:px-6 md:flex md:flex-wrap md:items-center md:justify-between md:gap-x-7 md:gap-y-4 md:px-7 md:py-6">
            {badges.map((badge, index) => (
              <div
                key={index}
                className="flex min-w-0 items-center justify-center gap-3 text-center text-[#3b474c] md:justify-start md:text-left"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(180deg,rgba(58,90,94,0.92)_0%,rgba(24,43,48,0.96)_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_18px_rgba(9,24,28,0.22)] backdrop-blur-sm">
                  <badge.icon className="h-[18px] w-[18px] text-[#dfe8e5]" />
                </div>

                <span className="min-w-0 text-[0.9rem] font-medium leading-6 tracking-[-0.01em] text-[#3f4b50] sm:text-[0.96rem]">
                  {badge.label}
                </span>

                {index < badges.length - 1 && (
                  <span className="ml-4 hidden text-[#9ba6aa] xl:inline">|</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}