"use client";

import { useParams } from "next/navigation";
import { Card } from "../../../components/ui";
import { MarketingHeader } from "../../../components/header";
import { Footer } from "../../../components/Footer";

export default function SharePage() {
  const params = useParams<{ id: string }>();

  return (
    <div className="page landing-page">
      <div className="relative min-h-screen overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.74)_34%,rgba(8,18,22,0.68)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_14%,rgba(158,216,207,0.08),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_84%_22%,rgba(214,184,157,0.06),transparent_18%)]" />
        <div className="absolute inset-0 opacity-[0.035] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.022)_0px,rgba(255,255,255,0.022)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10 flex min-h-screen flex-col">
          <MarketingHeader />

          <main className="flex flex-1 items-center justify-center px-6 py-10 md:px-8 md:py-14">
            <div className="w-full max-w-[760px]">
              <Card className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] bg-transparent p-0 shadow-[0_30px_80px_rgba(0,0,0,0.18)]">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover object-center"
                />
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />

                <div className="relative z-10 px-7 py-8 md:px-8 md:py-9">
                  <div className="mb-5 flex gap-4">
                    <div className="text-[2rem] leading-none text-[#9b826b]">ℹ️</div>
                    <div>
                      <h2 className="m-0 text-[1.55rem] font-semibold tracking-[-0.03em] text-[#1d3136]">
                        Share Link Page Not Active
                      </h2>
                      <p className="mt-2 mb-0 text-[0.96rem] leading-[1.8] text-[#55666a]">
                        This page is not used in the current sharing flow.
                        Please return to the evidence page and use{" "}
                        <strong>Share Evidence</strong> to:
                      </p>
                    </div>
                  </div>

                  <div className="rounded-[18px] border border-[rgba(79,112,107,0.16)] bg-[rgba(255,255,255,0.38)] p-4">
                    <ul className="m-0 pl-5 text-[0.92rem] leading-[1.9] text-[#55666a]">
                      <li>Copy the verification link</li>
                      <li>Download the PDF report</li>
                      <li>Download the verification package</li>
                    </ul>
                  </div>

                  <div className="mt-5 rounded-[18px] border border-[rgba(79,112,107,0.16)] bg-[rgba(255,255,255,0.38)] p-4">
                    <p className="m-0 text-[0.86rem] leading-[1.7] text-[#66777b]">
                      Evidence ID:{" "}
                      <code className="rounded bg-[rgba(183,157,132,0.12)] px-2 py-1 text-[#7f6450]">
                        {params?.id ?? "Unknown"}
                      </code>
                    </p>
                  </div>

                  <p className="mt-4 mb-0 text-[0.86rem] leading-[1.7] text-[#66777b]">
                    Public verification remains available through the evidence verification page.
                  </p>
                </div>
              </Card>
            </div>
          </main>

          <Footer />
        </div>
      </div>
    </div>
  );
}