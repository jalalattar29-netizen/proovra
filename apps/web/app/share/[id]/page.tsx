"use client";

/**
 * /share/[id] — A RETIRED LINK SHAPE (Free audit F-27a).
 *
 * No product journey links here: `publicShareUrl` (packages/shared
 * tenant-url.ts) has no caller, no email, notification or app deep link
 * builds a /share/ URL, and there is no backend route or token model behind
 * it (external-access-content.ts: "share-link … STUB"). Sharing today is the
 * record's verification link, opened at /verify/<reference>.
 *
 * The page used to echo the URL segment back as "Evidence ID" and to name a
 * "Share Evidence" action that does not exist. It now says the link format is
 * retired and points to /verify — it neither reads nor shows the segment, so
 * nothing about a token or record is reflected or implied.
 */

import Link from "next/link";
import { Card } from "../../../components/ui";
import { MarketingHeader } from "../../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../../components/marketing/EnterpriseFooter";

export default function SharePage() {
  return (
    <div className="page landing-page">
      <div className="relative min-h-screen overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/assets/hero/register-logo...png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,229,207,0.10)_0%,rgba(255,255,255,0.02)_45%,rgba(33,22,45,0.10)_100%)]" />

        <div className="relative z-10 flex min-h-screen flex-col">
          <MarketingHeader />

          <main className="flex flex-1 items-center justify-center px-6 py-10 md:px-8 md:py-14">
            <div className="w-full max-w-[760px]">
              <Card className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] bg-white/95 p-0 shadow-[0_30px_80px_rgba(0,0,0,0.18)]">

                <div className="relative z-10 px-7 py-8 md:px-8 md:py-9">
                  <div className="mb-5" data-share-retired>
                    <h2 className="m-0 text-[1.55rem] font-semibold tracking-[-0.03em] text-[#1d3136]">
                      This link format is no longer used
                    </h2>
                    <p className="mt-2 mb-0 text-[0.96rem] leading-[1.8] text-[#55666a]">
                      PROOVRA records are shared with their verification link,
                      which opens on the Verify page. If someone sent you a
                      record, ask them for its verification link, or enter the
                      record&apos;s reference on the Verify page.
                    </p>
                  </div>

                  <Link
                    href="/verify"
                    className="inline-flex items-center rounded-[14px] bg-[#1d3136] px-5 py-3 text-[0.95rem] font-semibold text-white no-underline"
                    data-share-retired-verify
                  >
                    Open the Verify page
                  </Link>
                </div>
              </Card>
            </div>
          </main>

          <EnterpriseFooter />
        </div>
      </div>
    </div>
  );
}