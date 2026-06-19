"use client";

import {
  AlertTriangle,
  Bell,
  Camera,
  ChevronDown,
  FileText,
  Folder,
  GitBranch,
  Layers,
  MoreHorizontal,
  Plus,
  ScrollText,
  Search,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";

export function PlatformDashboardShowcase() {
  const sidebar: { label: string; icon: LucideIcon; active?: boolean; badge?: string }[] = [
    { label: "Overview", icon: Layers, active: true },
    { label: "Evidence", icon: FileText },
    { label: "Cases", icon: Folder },
    { label: "Devices", icon: Camera },
    { label: "Chain of Custody", icon: GitBranch },
    { label: "Audit Trail", icon: ScrollText },
    { label: "Reports", icon: FileText },
    { label: "Alerts", icon: Bell, badge: "14" },
    { label: "Settings", icon: Settings },
  ];

  const kpis: { label: string; value: string; helper: string; tone: "good" | "warn" | "neutral"; chart: string }[] = [
    { label: "Total Evidence", value: "123", helper: "↑ 12 in the last 7 days", tone: "good", chart: "#0891B2" },
    { label: "Active Matters", value: "2", helper: "All matters on track", tone: "neutral", chart: "#6D28D9" },
    { label: "End-to-End Ready", value: "81%", helper: "18 need attention", tone: "warn", chart: "#16A34A" },
    { label: "Reports & Packages", value: "110 / 100", helper: "10 pending", tone: "warn", chart: "#F97316" },
  ];

  const priorityAlerts: { count: string; label: string; color: string; bg: string }[] = [
    { count: "14", label: "Records Need Integrity Review", color: "#EF4444", bg: "#FEF2F2" },
    { count: "33", label: "TSA Failures Detected", color: "#F97316", bg: "#FFF7ED" },
    { count: "11", label: "OTS Pending Review", color: "#6D28D9", bg: "#F5F3FF" },
    { count: "10", label: "Packages Missing", color: "#0891B2", bg: "#ECFEFF" },
  ];

  return (
    <div className="relative w-full overflow-hidden rounded-[28px] border border-[#E5E7EB] bg-white shadow-[0_30px_90px_rgba(15,23,42,0.12)]">
      <div className="grid grid-cols-[200px_1fr]">
        {/* Sidebar — light */}
        <aside className="border-r border-[#E5E7EB] bg-[#F8FAFC] p-3.5 text-[12.5px] text-[#334155]">
          <div className="flex items-center gap-2 pb-1">
            <img
              src="/assets/branding/proovra-mark.png"
              alt=""
              width={26}
              height={26}
              className="object-contain"
            />
            <div className="min-w-0">
              <div className="text-[12.5px] font-bold text-[#0F172A]">PROOVRA</div>
              <div className="whitespace-nowrap text-[8px] uppercase tracking-[0.10em] text-[#64748B]">
                Evidence • Trust • Integrity
              </div>
            </div>
          </div>
          <ul className="mt-3 space-y-0.5 pl-0">
            {sidebar.map((it) => {
              const Icon = it.icon;
              return (
                <li key={it.label} className="list-none">
                  <div
                    className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 ${
                      it.active
                        ? "border border-[#DBEAFE] bg-white text-[#2563EB]"
                        : "text-[#334155]"
                    }`}
                  >
                    <span className="flex items-center gap-2 whitespace-nowrap">
                      <Icon size={13} strokeWidth={1.85} />
                      {it.label}
                    </span>
                    {it.badge && (
                      <span className="rounded bg-[#EEF4FF] px-1 text-[9.5px] font-bold text-[#2563EB]">
                        {it.badge}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 rounded-lg border border-[#E5E7EB] bg-white p-2.5">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[#16A34A]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#16A34A]" />
              System Status
            </div>
            <div className="mt-0.5 text-[9px] text-[#64748B]">All Systems Operational</div>
          </div>
        </aside>

        {/* Main content */}
        <div className="bg-white p-4">
          {/* Top bar */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 whitespace-nowrap text-[15px] font-bold text-[#0F172A]">
                Good morning, Sara <span aria-hidden="true">👋</span>
              </div>
              <div className="mt-0.5 text-[10.5px] text-[#64748B]">
                Here&apos;s what&apos;s happening in your evidence ecosystem today.
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="hidden h-8 w-[200px] items-center gap-1.5 rounded-lg border border-[#E5E7EB] bg-white px-2.5 text-[10px] text-[#94A3B8] xl:flex">
                <Search size={11} strokeWidth={1.85} />
                Search evidence, cases…
                <span className="ml-auto rounded bg-[#F1F5F9] px-1 text-[8px] font-semibold text-[#64748B]">⌘K</span>
              </div>
              <div className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#E5E7EB] bg-white text-[#0F172A]">
                <Bell size={12} strokeWidth={1.85} />
                <span className="absolute -right-1 -top-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#EF4444] text-[7.5px] font-bold text-white">
                  3
                </span>
              </div>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-[#0F172A] px-2.5 text-[10.5px] font-semibold text-white"
              >
                <Plus size={11} strokeWidth={2.2} />
                New Case
                <ChevronDown size={9} strokeWidth={2} />
              </button>
              <div className="flex items-center gap-1.5 rounded-lg border border-[#E5E7EB] bg-white px-1.5 py-1">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#FED7AA] text-[8.5px] font-bold text-[#9A3412]">
                  SA
                </span>
                <div className="hidden text-[9px] leading-tight md:block">
                  <div className="font-bold text-[#0F172A]">Sara Al-Khatib</div>
                  <div className="text-[8px] text-[#64748B]">Administrator</div>
                </div>
                <ChevronDown size={9} className="text-[#64748B]" />
              </div>
            </div>
          </div>

          {/* Alert banner */}
          <div className="mt-3 flex items-start justify-between gap-2 rounded-xl border border-[#FECACA] bg-[#FEF2F2] p-2.5">
            <div className="flex items-start gap-2">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#FEE2E2] text-[#EF4444]">
                <AlertTriangle size={16} strokeWidth={2.2} />
              </span>
              <div>
                <div className="text-[11px] font-bold text-[#0F172A]">
                  33 TSA timestamps failed
                </div>
                <div className="mt-0.5 text-[9.5px] text-[#475569]">
                  Failed timestamping weakens time-based evidence confidence for these records.
                </div>
                <div className="text-[9px] text-[#64748B]">
                  Also: 14 records need integrity review · 10 packages are missing
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="rounded text-[10px] font-semibold text-[#EF4444]"
              >
                Open affected records
              </button>
              <X size={11} className="text-[#94A3B8]" strokeWidth={1.85} />
            </div>
          </div>

          {/* KPI cards */}
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {kpis.map((k) => (
              <div
                key={k.label}
                className="rounded-lg border border-[#E5E7EB] bg-white p-3"
              >
                <div className="flex items-center justify-between text-[10px] font-semibold text-[#64748B]">
                  <div className="flex items-center gap-1.5 whitespace-nowrap">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-[#F1F5F9]">
                      <Layers size={10} strokeWidth={1.85} className="text-[#475569]" />
                    </span>
                    {k.label}
                  </div>
                  <MoreHorizontal size={11} className="text-[#94A3B8]" />
                </div>
                <div className="mt-2 text-[1.3rem] font-bold leading-none tracking-[-0.02em] text-[#0F172A]">
                  {k.value}
                </div>
                <div
                  className={`mt-1 text-[9.5px] font-semibold ${
                    k.tone === "good"
                      ? "text-[#16A34A]"
                      : k.tone === "warn"
                        ? "text-[#F97316]"
                        : "text-[#64748B]"
                  }`}
                >
                  {k.helper}
                </div>
                <svg viewBox="0 0 100 14" className="mt-1 h-3 w-full">
                  <path
                    d="M 0 10 Q 12 6 22 8 T 42 5 T 62 9 T 82 4 T 100 7"
                    fill="none"
                    stroke={k.chart}
                    strokeWidth="1.4"
                  />
                </svg>
              </div>
            ))}
          </div>

          {/* Priority Alerts */}
          <div className="mt-3 rounded-lg border border-[#E5E7EB] bg-white p-2.5">
            <div className="flex items-center justify-between">
              <div className="text-[10.5px] font-bold text-[#0F172A]">Priority Alerts</div>
              <div className="text-[9px] font-semibold text-[#2563EB]">View all alerts →</div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {priorityAlerts.map((a) => (
                <div
                  key={a.label}
                  className="flex items-center gap-1.5 rounded-lg border border-[#E5E7EB] p-1.5"
                >
                  <span
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                    style={{ background: a.bg, color: a.color }}
                  >
                    <AlertTriangle size={11} strokeWidth={2} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[12px] font-bold leading-none text-[#0F172A]">
                      {a.count}
                    </div>
                    <div className="mt-0.5 text-[8px] leading-tight text-[#64748B]">
                      {a.label}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
