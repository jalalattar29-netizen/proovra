"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Card, Button } from "../../../components/ui";
import { dashboardStyles } from "../../../components/dashboard/styles";

const ADMIN_NAV = [
  { href: "/admin", label: "Console Home" },
  { href: "/admin/dashboard", label: "Platform Analytics" },
  { href: "/admin/audit", label: "Audit Integrity" },
];

const CARDS = [
  {
    href: "/admin/dashboard",
    title: "Admin Dashboard",
    body: "Global analytics, funnel visibility, geography, top routes, and recent platform activity.",
  },
  {
    href: "/admin/audit",
    title: "Audit Console",
    body: "Tamper-evident administrative audit log, integrity verification, and privileged action review.",
  },
];

export default function AdminPage() {
  const pathname = usePathname();

  return (
    <div>
      <div className="app-hero app-hero-full">
        <div className="container">
          <div style={{ maxWidth: 860 }}>
            <div style={dashboardStyles.heroChip}>
              <span style={dashboardStyles.heroDot} />
              Admin Console
            </div>

            <h1 className="mt-5 max-w-[820px] text-[1.72rem] font-medium leading-[1.01] tracking-[-0.045em] text-[#edf1ef] md:text-[2.28rem] lg:text-[2.95rem]">
              Global operations, audit, and
              <span className="text-[#bfe8df]"> platform visibility</span>.
            </h1>

            <p className="mt-5 max-w-[780px] text-[0.98rem] leading-[1.82] text-[#c7cfcc]">
              Use the admin console to review platform-wide analytics, audit integrity,
              route activity, and operational oversight from one controlled surface.
            </p>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16, paddingBottom: 72 }}>
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            {ADMIN_NAV.map((item) => {
              const active = pathname === item.href;

              return (
                <Link key={item.href} href={item.href}>
                  <Button
                    className="rounded-[999px] border px-5 py-2.5 text-[0.88rem] font-semibold"
                    style={active ? dashboardStyles.primaryButton : dashboardStyles.secondaryButton}
                  >
                    {item.label}
                  </Button>
                </Link>
              );
            })}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 16,
            }}
          >
            {CARDS.map((card) => (
              <Card
                key={card.href}
                className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
                style={dashboardStyles.outerCard}
              >
                <div className="absolute inset-0">
                  <img
                    src="/images/site-velvet-bg.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center scale-[1.12]"
                  />
                </div>
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.05),transparent_28%)]" />

                <div className="relative z-10 p-6 md:p-7">
                  <div className="text-[1.12rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                    {card.title}
                  </div>

                  <p className="mt-3 text-[0.94rem] leading-[1.75] text-[#aab5b2]">
                    {card.body}
                  </p>

                  <div className="mt-6">
                    <Link href={card.href}>
                      <Button
                        className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={dashboardStyles.primaryButton}
                      >
                        Open
                      </Button>
                    </Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}