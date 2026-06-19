import { SectionBadge } from "./SectionBadge";
import { PlatformDashboardPreview } from "./PlatformDashboardPreview";

export function EnterpriseOperationsPlatform() {
  return (
    <section
      id="live-operations-visibility"
      className="relative bg-[var(--proovra-page-bg)]"
      style={{
        fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif",
        paddingTop: 96,
        paddingBottom: 96,
      }}
    >
      <div className="mx-auto max-w-[1400px] px-5 md:px-7 lg:px-10 2xl:px-12">
        {/* Header */}
        <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
          <SectionBadge>Live Operations Visibility</SectionBadge>
          <h2 className="mt-5 text-[30px] font-extrabold leading-[1.08] tracking-[-0.02em] text-[#0F172A] md:text-[40px] lg:text-[46px]">
            One workspace for{" "}
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(90deg,#2563EB 0%,#4F46E5 50%,#7C3AED 100%)",
              }}
            >
              connected evidence operations.
            </span>
          </h2>
          <p className="mt-5 text-[15.5px] leading-[1.7] text-[#475569]">
            Monitor evidence records, cases, verification health, reports,
            packages, alerts, and reviewer activity from one workspace.
          </p>
        </div>

        {/* Full-width dashboard preview — shared with /platform "Real product. Real visibility." */}
        <div className="mt-12">
          <PlatformDashboardPreview />
        </div>
      </div>
    </section>
  );
}
