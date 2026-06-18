import { Info } from "lucide-react";

export function ImportantClarification() {
  return (
    <section
      className="relative bg-[var(--proovra-page-bg)]"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 pb-16 lg:px-10 2xl:px-12 lg:pb-24">
        <div className="rounded-[20px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-page-bg-soft)] p-6 md:p-7">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-5">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl"
              style={{ background: "rgba(37,99,235,0.10)" }}
              aria-hidden="true"
            >
              <Info size={18} className="text-[#2563EB]" />
            </span>
            <div className="flex flex-col gap-2">
              <h3 className="text-[15px] font-bold tracking-tight text-[#0F172A]">
                Important clarification
              </h3>
              <p className="max-w-3xl text-[13.5px] leading-[1.7] text-[#475569]">
                PROOVRA is not a court, law-enforcement authority, or legal
                service provider. Verification confirms the recorded integrity
                state, timing context, custody metadata, and preservation-related
                details for an evidence record. It does not by itself establish
                factual truth, authorship, identity, or legal admissibility in a
                specific jurisdiction.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
