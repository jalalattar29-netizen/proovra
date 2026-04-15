"use client";

import { Shield, CheckCircle, Lock } from "lucide-react";

const features = [
  {
    icon: Shield,
    title: "Create a review-ready evidence record",
    description:
      "Upload files or capture material into a structured evidence record instead of relying on ordinary files or screenshots alone.",
    iconBg:
      "bg-[linear-gradient(180deg,rgba(58,92,102,0.98)_0%,rgba(35,58,67,0.98)_100%)]",
  },
  {
    icon: CheckCircle,
    title: "Preserve the recorded integrity state",
    description:
      "PROOVRA records integrity materials, timing context, and custody events so later review can detect post-submission mismatch and trace important record activity.",
    iconBg:
      "bg-[linear-gradient(180deg,rgba(73,128,135,0.98)_0%,rgba(44,79,88,0.98)_100%)]",
  },
  {
    icon: Lock,
    title: "Support later scrutiny with clearer review output",
    description:
      "Share a reviewer-facing verification page and structured report so external or internal reviewers can inspect preservation context in one place.",
    iconBg:
      "bg-[linear-gradient(180deg,rgba(177,164,149,0.98)_0%,rgba(142,126,111,0.98)_100%)]",
  },
];

export function Features() {
  return (
    <section className="w-full px-4 py-2 sm:px-6 md:px-8 md:py-3">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-4 md:grid-cols-3">
          {features.map((feature, index) => (
            <div
              key={index}
              className="group relative overflow-hidden rounded-[26px] border border-white/10 shadow-[0_18px_34px_rgba(0,0,0,0.12)]"
            >
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-center"
              />

              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(255,255,255,0.14)_18%,rgba(255,255,255,0.06)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_22%_16%,rgba(255,255,255,0.35),transparent_30%)] opacity-60" />

              <div className="relative z-10 p-5 sm:p-6 md:p-7">
                <div
                  className={`mb-5 flex h-14 w-14 items-center justify-center rounded-[16px] ${feature.iconBg} shadow-[0_10px_22px_rgba(0,0,0,0.14)]`}
                >
                  <feature.icon className="h-7 w-7 text-[#eef1ef]" />
                </div>

                <h3 className="text-[1rem] font-semibold tracking-[-0.025em] text-[#223036] md:text-[1.06rem]">
                  {feature.title}
                </h3>

                <p className="mt-2.5 max-w-none text-[0.95rem] leading-7 text-[#58656a]">
                  {feature.description}
                </p>
              </div>

              <div className="pointer-events-none absolute inset-x-4 bottom-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.55),transparent)] opacity-70" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}