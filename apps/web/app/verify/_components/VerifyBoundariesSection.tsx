"use client";

import { AlertTriangle, Eye } from "lucide-react";
import { SectionEyebrow } from "./shared";

const ITEMS = [
  "Factual truth",
  "Authorship",
  "Identity",
  "Intent",
  "Legal admissibility",
  "Evidentiary weight",
  "Court acceptance",
  "Whether a real-world event happened",
];

export function VerifyBoundariesSection() {
  return (
    <section
      className="relative overflow-hidden py-16 md:py-20"
      style={{
        backgroundColor: "#07132B",
        backgroundImage: "url('/assets/cards/icon-card.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(7,19,43,0.88) 0%, rgba(7,19,43,0.78) 50%, rgba(7,19,43,0.68) 100%)",
        }}
      />
      <div className="relative mx-auto max-w-[1100px] px-6 md:px-8">
        <div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-start">
          <div>
            <SectionEyebrow color="#F8717A" variant="dark">
              What PROOVRA does not decide
            </SectionEyebrow>
            <h2 className="mt-3 text-[1.9rem] font-semibold leading-[1.12] tracking-[-0.02em] text-white md:text-[2.2rem]">
              Public verification exposes context.
              <br />
              It does not decide outcomes.
            </h2>
            <p
              className="mt-3 max-w-[520px] text-[15px] leading-[1.7]"
              style={{ color: "#D8E2F0" }}
            >
              Public verification exposes recorded technical and operational
              context. Final factual, legal, procedural, or expert conclusions
              remain the responsibility of qualified reviewers.
            </p>
          </div>
          <div
            className="rounded-[18px] border p-6"
            style={{
              background: "rgba(255,255,255,0.08)",
              borderColor: "rgba(255,255,255,0.16)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              boxShadow: "0 24px 60px rgba(0,0,0,0.32)",
            }}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="flex h-9 w-9 items-center justify-center rounded-[12px]"
                style={{
                  background: "rgba(248,113,122,0.18)",
                  border: "1px solid rgba(248,113,122,0.36)",
                }}
              >
                <AlertTriangle size={16} className="text-[#FCA5A5]" strokeWidth={2} />
              </span>
              <span className="text-[12.5px] font-semibold uppercase tracking-[0.18em] text-[#FCA5A5]">
                Out of scope
              </span>
            </div>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {ITEMS.map((b) => (
                <li
                  key={b}
                  className="flex items-start gap-2 text-[14px]"
                  style={{ color: "#E2EBF8" }}
                >
                  <Eye size={13} className="mt-1 shrink-0 text-[#FCA5A5]" strokeWidth={2.4} />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
