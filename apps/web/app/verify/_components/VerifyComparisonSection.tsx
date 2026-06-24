"use client";

import Link from "next/link";
import { ArrowRight, ShieldCheck, PackageCheck, CheckCircle2 } from "lucide-react";
import { SectionEyebrow, SECTION_BORDER, SECTION_INK, SECTION_MUTED } from "./shared";

const COLUMNS = [
  {
    Icon: ShieldCheck,
    eyebrow: "Public Verify",
    eyebrowColor: "#2563EB",
    title: "Reviewer-facing verification page",
    body: "Opens a verification record online using a token or public verification ID.",
    bullets: [
      "Opens a reviewer-facing verification page.",
      "Uses a token or public verification ID.",
      "Reads materials made available through PROOVRA.",
      "Useful for quick external review.",
      "Requires browser access to PROOVRA.",
    ],
    cta: { label: "Public Verify", href: "/verify" },
  },
  {
    Icon: PackageCheck,
    eyebrow: "Offline Verifier",
    eyebrowColor: "#10A37F",
    title: "Local Verification Package inspection",
    body: "Inspect a Verification Package ZIP entirely in the browser. The ZIP never leaves your device.",
    bullets: [
      "Verifies a Verification Package ZIP locally.",
      "Processes the ZIP in the browser.",
      "Does not upload the package to PROOVRA.",
      "Can export result JSON.",
      "Useful for independent package inspection.",
    ],
    cta: { label: "Offline Verifier", href: "/offline-verifier" },
  },
];

export function VerifyComparisonSection() {
  return (
    <section className="bg-white py-16 md:py-20">
      <div className="mx-auto max-w-[1200px] px-6 md:px-8">
        <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
          <SectionEyebrow>Public Verify vs Offline Verifier</SectionEyebrow>
          <h2
            className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] md:text-[2.2rem]"
            style={{ color: SECTION_INK }}
          >
            Two reviewer paths.
          </h2>
          <p
            className="mt-3 max-w-[680px] text-[15px] leading-[1.7]"
            style={{ color: SECTION_MUTED }}
          >
            The right choice depends on whether you are reviewing through
            PROOVRA online or inspecting a package independently on your own
            machine.
          </p>
        </div>
        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          {COLUMNS.map((c) => (
            <article
              key={c.title}
              className="flex h-full flex-col rounded-[20px] border bg-white p-6 md:p-7"
              style={{
                borderColor: SECTION_BORDER,
                boxShadow: "0 12px 30px rgba(15,23,42,0.06)",
              }}
            >
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="flex h-10 w-10 items-center justify-center rounded-[12px]"
                  style={{
                    background: `${c.eyebrowColor}14`,
                    border: `1px solid ${c.eyebrowColor}3D`,
                  }}
                >
                  <c.Icon size={18} strokeWidth={2} style={{ color: c.eyebrowColor }} />
                </span>
                <SectionEyebrow color={c.eyebrowColor}>{c.eyebrow}</SectionEyebrow>
              </div>
              <h3
                className="mt-4 text-[17px] font-semibold tracking-[-0.005em]"
                style={{ color: SECTION_INK }}
              >
                {c.title}
              </h3>
              <p className="mt-2 text-[13.5px] leading-[1.65]" style={{ color: SECTION_MUTED }}>
                {c.body}
              </p>
              <ul className="mt-4 grid gap-2">
                {c.bullets.map((b) => (
                  <li
                    key={b}
                    className="flex items-start gap-2.5 text-[13px] leading-[1.55]"
                    style={{ color: SECTION_INK }}
                  >
                    <CheckCircle2
                      size={13}
                      strokeWidth={2.4}
                      className="mt-0.5 shrink-0"
                      style={{ color: c.eyebrowColor }}
                    />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-5">
                <Link
                  href={c.cta.href}
                  className="inline-flex items-center justify-center gap-2 rounded-[12px] border-2 px-4 py-2 text-[13.5px] font-semibold transition"
                  style={{
                    borderColor: c.eyebrowColor,
                    color: c.eyebrowColor,
                    background: "#FFFFFF",
                  }}
                >
                  {c.cta.label}
                  <ArrowRight size={14} />
                </Link>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
