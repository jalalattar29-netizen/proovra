import type { ReactNode } from "react";
import { MarketingHeader } from "../MarketingHeader";
import { EnterpriseFooter } from "../EnterpriseFooter";

export function MarketingPage({ children }: { children: ReactNode }) {
  return (
    <main
      className="min-h-screen w-full bg-white text-[#0F172A]"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <MarketingHeader />
      {children}
      <EnterpriseFooter />
    </main>
  );
}
