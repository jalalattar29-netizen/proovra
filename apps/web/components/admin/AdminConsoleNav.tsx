"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ADMIN_NAV_ITEMS } from "./admin-nav-config";

export default function AdminConsoleNav() {
  const pathname = usePathname();

  // `/admin` must match exactly so it does not light up on every nested
  // route. Every other entry treats a sub-path as active so that, e.g.,
  // `/admin/identity/providers` still highlights the "Identity Governance"
  // entry.
  const isActive = (href: string) => {
    if (href === "/admin") return pathname === "/admin";
    return pathname === href || pathname?.startsWith(`${href}/`);
  };

  return (
    <div className="mb-6 flex flex-wrap gap-3">
      {ADMIN_NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`rounded-full border px-4 py-2 text-[0.88rem] font-semibold transition-all ${
            isActive(item.href)
              ? "border-[rgba(214,184,157,0.32)] bg-[rgba(214,184,157,0.10)] text-[#e6c9ae]"
              : "border-white/10 bg-white/[0.04] text-[#d8e0dd] hover:border-[rgba(214,184,157,0.24)] hover:text-[#e6c9ae]"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}
