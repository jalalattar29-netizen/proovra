"use client";

import {
  Shield,
  Upload,
  Scan,
  Settings,
  Check,
  ChevronRight,
  Bell,
} from "lucide-react";

export function PhoneMockup() {
  return (
    <div className="relative">
      <div className="absolute -right-10 top-[34%] hidden grid-cols-4 gap-3 lg:grid">
        {Array.from({ length: 16 }).map((_, i) => (
          <span
            key={i}
            className="h-2 w-2 rounded-full bg-[#8dd8d4]/80 shadow-[0_0_8px_rgba(141,216,212,0.22)]"
          />
        ))}
      </div>

      <div className="relative h-[620px] w-[318px] rounded-[3.2rem] border border-[#56626a] bg-[linear-gradient(180deg,#26323a_0%,#141b22_100%)] p-[10px] shadow-[0_30px_70px_rgba(0,0,0,0.45)]">
        <div className="absolute -left-[6px] top-32 h-16 w-[4px] rounded-full bg-[#1f2a31]" />
        <div className="absolute -right-[6px] top-36 h-20 w-[4px] rounded-full bg-[#1f2a31]" />
        <div className="absolute -right-[6px] top-60 h-12 w-[4px] rounded-full bg-[#1f2a31]" />

        <div className="relative h-full w-full overflow-hidden rounded-[2.7rem] border border-[rgba(183,157,132,0.22)] bg-[#071116]">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-center opacity-[0.98]"
          />

          <div className="pointer-events-none absolute inset-0">
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(5,16,20,0.72)_0%,rgba(4,13,17,0.80)_55%,rgba(3,10,13,0.90)_100%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_34%_18%,rgba(120,170,164,0.10),transparent_26%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_74%_30%,rgba(255,255,255,0.03),transparent_24%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_100%,rgba(0,0,0,0.24),transparent_30%)]" />
            <div
              className="absolute inset-0 opacity-[0.04] mix-blend-soft-light"
              style={{
                backgroundImage:
                  "radial-gradient(rgba(255,255,255,0.75) 0.7px, transparent 0.7px)",
                backgroundSize: "6px 6px",
              }}
            />
          </div>

          <div className="relative flex items-center justify-between px-6 pb-2 pt-3 text-[11px] text-[#dfe6e4]">
            <span className="font-medium tracking-wide">09:41</span>
            <div className="h-7 w-24 rounded-full bg-black/85" />
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-4 rounded-sm bg-[#dfe6e4]/78" />
              <div className="h-2 w-2 rounded-full bg-[#dfe6e4]/78" />
            </div>
          </div>

          <div className="relative flex items-center justify-between px-5 py-3">
            <div className="flex items-center gap-2.5">
              <div className="relative flex h-7 w-7 items-center justify-center overflow-hidden rounded-md border border-[rgba(183,157,132,0.34)] bg-[#123338] shadow-[0_8px_18px_rgba(67,140,145,0.18)]">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover object-center opacity-[0.95]"
                />
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(124,178,182,0.18)_0%,rgba(33,84,88,0.38)_100%)]" />
                <Shield className="relative z-10 h-4 w-4 text-[#eef3f1]" />
              </div>

              <span className="text-[1.05rem] font-semibold tracking-tight text-[#edf2f0]">
                PROOVRA
              </span>
            </div>

            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-[rgba(183,157,132,0.34)] bg-[rgba(255,255,255,0.04)] backdrop-blur-sm">
              <Bell className="h-4 w-4 text-[#e1e8e5]" />
            </div>
          </div>

          <div className="relative mx-4 mt-3 overflow-hidden rounded-[1.8rem] border border-[rgba(183,157,132,0.36)] bg-[#08151a] px-4 py-4 shadow-[0_18px_40px_rgba(0,0,0,0.28)] backdrop-blur-md">
            <img
              src="/images/site-velvet-bg.webp.png"
              alt=""
              className="absolute inset-0 h-full w-full object-cover object-center opacity-[0.92]"
            />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(6,18,23,0.82)_0%,rgba(5,15,20,0.88)_100%)]" />

            <div className="relative z-10 mb-3 flex items-start justify-between">
              <div>
                <h3 className="text-[1.05rem] font-semibold tracking-tight text-[#f2f6f4]">
                  Case #4589
                </h3>
                <p className="mt-1 text-[0.82rem] text-[#cfd8d5]">
                  Evidence Upload
                </p>
              </div>

              <ChevronRight className="mt-0.5 h-5 w-5 text-[#d6dfdc]/82" />
            </div>

            <div className="relative mb-5 mt-4 overflow-hidden rounded-[1.35rem] border border-[rgba(183,157,132,0.22)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <img
                src="/images/site-velvet-bg.webp.png"
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-center opacity-[0.96]"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(28,66,72,0.28)_0%,rgba(7,22,27,0.56)_100%)]" />

              <div className="relative z-10 px-4 py-7">
                <div className="flex justify-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full border-[3px] border-[rgba(214,224,221,0.92)] bg-white/[0.02]">
                    <Check className="h-8 w-8 text-[#f1f5f3]" />
                  </div>
                </div>
              </div>
            </div>

            <div className="relative z-10 space-y-3">
              <p className="text-[0.86rem] font-medium text-[#eef3f1]">
                Verification Progress
              </p>

              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="relative flex h-5 w-5 items-center justify-center overflow-hidden rounded-full bg-[#355f62]">
                    <img
                      src="/images/site-velvet-bg.webp.png"
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover object-center opacity-[0.95]"
                    />
                    <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(124,178,182,0.14)_0%,rgba(25,63,68,0.32)_100%)]" />
                    <Check className="relative z-10 h-3.5 w-3.5 text-[#f2f6f4]" />
                  </div>
                  <span className="text-[0.9rem] text-[#dde5e2]">Uploaded</span>
                </div>

                <div className="flex items-center gap-3">
                  <div className="relative flex h-5 w-5 items-center justify-center overflow-hidden rounded-full bg-[#355f62]">
                    <img
                      src="/images/site-velvet-bg.webp.png"
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover object-center opacity-[0.95]"
                    />
                    <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(124,178,182,0.14)_0%,rgba(25,63,68,0.32)_100%)]" />
                    <Check className="relative z-10 h-3.5 w-3.5 text-[#f2f6f4]" />
                  </div>
                  <span className="text-[0.9rem] text-[#dde5e2]">Processing</span>
                  <div className="ml-2 h-[4px] flex-1 rounded-full bg-[rgba(214,224,221,0.16)]">
                    <div className="h-[4px] w-[68%] rounded-full bg-[rgba(214,224,221,0.40)]" />
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="h-5 w-5 rounded-full border border-[rgba(214,224,221,0.72)] bg-white/[0.02]" />
                  <span className="text-[0.9rem] text-[#d6dfdc]">Verified</span>
                </div>
              </div>
            </div>
          </div>

          <div className="absolute bottom-0 left-0 right-0 border-t border-[rgba(183,157,132,0.28)] bg-[#071319] px-4 pb-7 pt-4 backdrop-blur-md">
            <img
              src="/images/site-velvet-bg.webp.png"
              alt=""
              className="absolute inset-0 h-full w-full object-cover object-center opacity-[0.90]"
            />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(6,17,22,0.80)_0%,rgba(4,12,16,0.92)_100%)]" />

            <div className="relative z-10 grid grid-cols-4 gap-3">
              <div className="flex flex-col items-center gap-1.5">
                <Shield className="h-5 w-5 text-[#e1e8e5]" />
                <span className="text-[10px] font-medium text-[#dbe3e0]">Cases</span>
              </div>

              <div className="flex flex-col items-center gap-1.5">
                <Upload className="h-5 w-5 text-[#e1e8e5]" />
                <span className="text-[10px] font-medium text-[#dbe3e0]">Upload</span>
              </div>

              <div className="flex flex-col items-center gap-1.5">
                <Scan className="h-5 w-5 text-[#e1e8e5]" />
                <span className="text-[10px] font-medium text-[#dbe3e0]">Scan</span>
              </div>

              <div className="flex flex-col items-center gap-1.5">
                <Settings className="h-5 w-5 text-[#e1e8e5]" />
                <span className="text-[10px] font-medium text-[#dbe3e0]">Settings</span>
              </div>
            </div>

            <div className="relative z-10 mt-4 flex justify-center">
              <div className="h-1.5 w-28 rounded-full bg-[rgba(214,224,221,0.82)]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}