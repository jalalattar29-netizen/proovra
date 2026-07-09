"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ADMIN_NAV_ITEMS } from "./admin-nav-config";

/**
 * Platform Admin console navigation (pill row rendered on every /admin/*
 * sub-page). Colours are sourced from the canonical design tokens
 * (lib/design-tokens/tokens.css) so the nav matches the new public PROOVRA
 * design language on the LIGHT enterprise-console surface:
 *
 *   - inactive → neutral slate (--ink-secondary) on a white card surface with
 *     the default hairline border. Medium, fully-legible contrast (never the
 *     old near-white washed-out text that assumed a dark hero backdrop).
 *   - hover    → premium accent highlight (accent-050 fill, accent-600 text,
 *     accent-500 border) with a smooth transition.
 *   - active   → strong emphasis: accent-050 fill, accent-600 text, accent
 *     border, bold weight + a soft shadow so the current location is obvious.
 */
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
    <div className="mb-6 flex flex-wrap gap-2.5">
      {ADMIN_NAV_ITEMS.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full border px-4 py-2 text-sm transition-all duration-200 ${
              active
                ? "border-[color:var(--accent-500)] bg-[color:var(--accent-050)] font-bold text-[color:var(--accent-600)] shadow-[0_1px_2px_rgba(15,23,42,0.06)]"
                : "border-[color:var(--border-default)] bg-[color:var(--surface-card)] font-semibold text-[color:var(--ink-secondary)] hover:border-[color:var(--accent-500)] hover:bg-[color:var(--accent-050)] hover:text-[color:var(--accent-600)]"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
