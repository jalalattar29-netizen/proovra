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
    accent: "#2d5b59",
    eyebrow: "Analytics",
  },
  {
    href: "/admin/audit",
    title: "Audit Console",
    body: "Tamper-evident administrative audit log, integrity verification, and privileged action review.",
    accent: "#8a6e57",
    eyebrow: "Integrity",
  },
];

export default function AdminPage() {
  const pathname = usePathname();

  return (
    <div className="admin-console-page">
      <style jsx global>{`
        .admin-console-page .admin-shell {
          display: grid;
          gap: 18px;
          padding-bottom: 72px;
        }

        .admin-console-page .admin-nav-row {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .admin-console-page .admin-summary-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.08fr) minmax(0, 0.92fr);
          gap: 18px;
          align-items: stretch;
        }

        .admin-console-page .admin-cards-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 18px;
        }

        .admin-console-page .admin-card {
          position: relative;
          overflow: hidden;
          border-radius: 30px;
          border: 1px solid rgba(79, 112, 107, 0.16);
          background: transparent;
          box-shadow:
            0 18px 38px rgba(0, 0, 0, 0.08),
            inset 0 1px 0 rgba(255, 255, 255, 0.48);
        }

        .admin-console-page .admin-card-overlay {
          position: absolute;
          inset: 0;
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.24) 0%,
              rgba(248, 249, 246, 0.34) 42%,
              rgba(239, 241, 238, 0.42) 100%
            );
        }

        .admin-console-page .admin-card-shine {
          position: absolute;
          inset: 0;
          background: radial-gradient(
            circle at 16% 12%,
            rgba(255, 255, 255, 0.34),
            transparent 28%
          );
          opacity: 0.9;
        }

        .admin-console-page .admin-card-inner {
          position: relative;
          z-index: 10;
          padding: 24px;
          height: 100%;
          display: flex;
          flex-direction: column;
        }

        .admin-console-page .admin-card-title {
          font-size: 1.08rem;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: #21353a;
        }

        .admin-console-page .admin-card-copy {
          margin-top: 8px;
          color: #5d6d71;
          line-height: 1.7;
          font-size: 0.94rem;
        }

        .admin-console-page .admin-card-eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-height: 30px;
          padding: 6px 12px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          border: 1px solid rgba(183, 157, 132, 0.16);
          background:
            linear-gradient(
              180deg,
              rgba(214, 184, 157, 0.12) 0%,
              rgba(255, 255, 255, 0.44) 100%
            );
          color: #8a6e57;
          width: fit-content;
        }

        .admin-console-page .admin-dot {
          width: 7px;
          height: 7px;
          border-radius: 999px;
          background: #b79d84;
          flex-shrink: 0;
        }

        .admin-console-page .admin-hero-note {
          border: 1px solid rgba(183, 157, 132, 0.14);
          background: linear-gradient(
            135deg,
            rgba(214, 184, 157, 0.1),
            rgba(255, 255, 255, 0.36)
          );
          border-radius: 22px;
          padding: 18px;
        }

        .admin-console-page .admin-hero-note-title {
          font-size: 0.82rem;
          font-weight: 800;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #7b6a5d;
        }

        .admin-console-page .admin-hero-note-value {
          margin-top: 10px;
          font-size: 1.9rem;
          line-height: 1;
          font-weight: 800;
          letter-spacing: -0.05em;
          color: #8a6e57;
        }

        .admin-console-page .admin-hero-note-copy {
          margin-top: 10px;
          font-size: 0.85rem;
          line-height: 1.65;
          color: #6f665d;
        }

        .admin-console-page .admin-card-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: auto;
          padding-top: 18px;
        }

        .admin-console-page .admin-card-link {
          text-decoration: none;
        }

        @media (max-width: 980px) {
          .admin-console-page .admin-summary-grid,
          .admin-console-page .admin-cards-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 720px) {
          .admin-console-page .admin-card-inner {
            padding: 20px;
          }
        }
      `}</style>

      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
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
      </div>

      <div className="app-body app-body-full">
        <div className="container admin-shell">
          <div className="admin-nav-row">
            {ADMIN_NAV.map((item) => {
              const active = pathname === item.href;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="admin-card-link"
                >
                  <Button
                    className="rounded-[999px] border px-5 py-2.5 text-[0.88rem] font-semibold"
                    style={
                      active
                        ? dashboardStyles.primaryButton
                        : dashboardStyles.secondaryButton
                    }
                  >
                    {item.label}
                  </Button>
                </Link>
              );
            })}
          </div>

          <div className="admin-summary-grid">
            <Card className="admin-card" style={dashboardStyles.outerCard}>
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="admin-card-overlay" />
              <div className="admin-card-shine" />

              <div className="admin-card-inner">
                <div className="admin-card-title">Admin entry point</div>
                <div className="admin-card-copy">
                  Move between analytics and audit oversight from one clean admin surface,
                  using the same visual language as the rest of the dashboard pages.
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: 12,
                    marginTop: 18,
                  }}
                >
                  <div className="admin-hero-note">
                    <div className="admin-hero-note-title">Modules</div>
                    <div className="admin-hero-note-value">2</div>
                    <div className="admin-hero-note-copy">
                      Platform analytics and audit integrity are available from here.
                    </div>
                  </div>

                  <div className="admin-hero-note">
                    <div className="admin-hero-note-title">Admin Routes</div>
                    <div className="admin-hero-note-value">3</div>
                    <div className="admin-hero-note-copy">
                      Navigate quickly across console home, dashboard, and audit pages.
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            <Card className="admin-card" style={dashboardStyles.outerCard}>
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="admin-card-overlay" />
              <div className="admin-card-shine" />

              <div className="admin-card-inner">
                <div className="admin-card-title">Operational overview</div>
                <div className="admin-card-copy">
                  Choose the surface that matches your task: analytics for platform-level
                  visibility, or audit for integrity and privileged action review.
                </div>

                <div
                  style={{
                    display: "grid",
                    gap: 12,
                    marginTop: 18,
                  }}
                >
                  <div
                    style={{
                      border: "1px solid rgba(79,112,107,0.10)",
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                      borderRadius: 20,
                      padding: 16,
                      boxShadow:
                        "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
                    }}
                  >
                    <div className="admin-card-eyebrow">
                      <span className="admin-dot" />
                      Analytics
                    </div>
                    <div
                      style={{
                        marginTop: 10,
                        fontSize: 13,
                        lineHeight: 1.7,
                        color: "#67777c",
                      }}
                    >
                      Review funnel performance, geography, top routes, and platform
                      activity.
                    </div>
                  </div>

                  <div
                    style={{
                      border: "1px solid rgba(79,112,107,0.10)",
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                      borderRadius: 20,
                      padding: 16,
                      boxShadow:
                        "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
                    }}
                  >
                    <div className="admin-card-eyebrow">
                      <span className="admin-dot" />
                      Integrity
                    </div>
                    <div
                      style={{
                        marginTop: 10,
                        fontSize: 13,
                        lineHeight: 1.7,
                        color: "#67777c",
                      }}
                    >
                      Inspect tamper-evident audit entries and verify the current chain
                      status.
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          <div className="admin-cards-grid">
            {CARDS.map((card) => (
              <Card
                key={card.href}
                className="admin-card"
                style={dashboardStyles.outerCard}
              >
                <div className="absolute inset-0">
                  <img
                    src="/images/panel-silver.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center"
                  />
                </div>
                <div className="admin-card-overlay" />
                <div className="admin-card-shine" />

                <div className="admin-card-inner">
                  <div className="admin-card-eyebrow">
                    <span className="admin-dot" />
                    {card.eyebrow}
                  </div>

                  <div
                    className="admin-card-title"
                    style={{ marginTop: 16, color: card.accent }}
                  >
                    {card.title}
                  </div>

                  <p className="admin-card-copy">{card.body}</p>

                  <div className="admin-card-actions">
                    <Link href={card.href} className="admin-card-link">
                      <Button
                        className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={dashboardStyles.primaryButton}
                      >
                        Open
                      </Button>
                    </Link>

                    <Link href={card.href} className="admin-card-link">
                      <Button
                        className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={dashboardStyles.secondaryButton}
                      >
                        Review
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