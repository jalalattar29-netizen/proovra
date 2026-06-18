import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";

export type WorkflowStep = {
  title: string;
  body: string;
  Icon: LucideIcon;
  accent?: string;
};

export type WorkflowStepsProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  steps: WorkflowStep[];
};

const DEFAULT_ACCENTS = ["#F97316", "#2563EB", "#7C3AED", "#06B6D4", "#EC4899"];

export function WorkflowSteps({ eyebrow, title, description, steps }: WorkflowStepsProps) {
  return (
    <section className="relative bg-[var(--proovra-page-bg)]">
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 py-16 lg:px-10 2xl:px-12 lg:py-24">
        {eyebrow ? (
          <span className="inline-flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-[0.22em] text-[#06B6D4]">
            {eyebrow}
          </span>
        ) : null}
        <h2 className="mt-3 max-w-3xl text-[28px] font-extrabold leading-[1.1] tracking-[-0.02em] text-[#0F172A] md:text-[34px] lg:text-[40px]">
          {title}
        </h2>
        {description ? (
          <p className="mt-3 max-w-2xl text-[16px] leading-[1.6] text-[#475569]">
            {description}
          </p>
        ) : null}

        <div className="relative mt-10">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 xl:gap-4">
            {steps.map(({ title: stepTitle, body, Icon, accent }, idx) => {
              const color = accent ?? DEFAULT_ACCENTS[idx % DEFAULT_ACCENTS.length];
              return (
                <div key={stepTitle} className="relative">
                  <div className="flex h-full flex-col gap-3 rounded-[20px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] p-5 shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
                    <div className="flex items-center justify-between">
                      <span
                        className="flex h-11 w-11 items-center justify-center rounded-2xl"
                        style={{ background: `${color}14` }}
                      >
                        <Icon size={20} style={{ color }} />
                      </span>
                      <span
                        className="rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wider text-white"
                        style={{ background: color }}
                      >
                        {String(idx + 1).padStart(2, "0")}
                      </span>
                    </div>
                    <h3 className="text-[16px] font-bold leading-[1.25] tracking-tight text-[#0F172A]">
                      {stepTitle}
                    </h3>
                    <p className="text-[13px] leading-[1.55] text-[#475569]">{body}</p>
                  </div>
                  {idx < steps.length - 1 ? (
                    <ArrowRight
                      size={14}
                      aria-hidden="true"
                      className="pointer-events-none absolute -right-[14px] top-[37px] hidden text-[#94A3B8] xl:block"
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
