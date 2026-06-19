import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Briefcase,
  Camera,
  ChevronDown,
  FileText,
  Folder,
  GitBranch,
  HelpCircle,
  Layers,
  MoreHorizontal,
  Plus,
  ScrollText,
  Search,
  Settings,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

/**
 * Real-product dashboard preview. Single source of truth used by:
 *   - /platform "Real product. Real visibility." section
 *   - / (homepage) "Live Operations Visibility" section
 * Keep visual changes in this file so both surfaces stay in sync.
 */
export function PlatformDashboardPreview({
  className = "",
}: {
  className?: string;
}) {
  const sidebarItems: { label: string; icon: LucideIcon; active?: boolean; badge?: string }[] = [
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

  const kpis: { label: string; value: string; helper: string; helperTone: "good" | "warn" | "neutral"; chartColor: string }[] = [
    { label: "Total Evidence", value: "123", helper: "↑ 12 in the last 7 days", helperTone: "good", chartColor: "#0891B2" },
    { label: "Active Matters", value: "2", helper: "All matters on track", helperTone: "neutral", chartColor: "#6D28D9" },
    { label: "End-to-End Ready", value: "81%", helper: "18 need attention", helperTone: "warn", chartColor: "#16A34A" },
    { label: "Reports & Packages", value: "110 / 100", helper: "10 pending", helperTone: "warn", chartColor: "#F97316" },
    { label: "Intake & Submissions", value: "0 / 0", helper: "No active intake links", helperTone: "neutral", chartColor: "#94A3B8" },
  ];

  const priorityAlerts: { count: string; label: string; icon: LucideIcon; color: string; bg: string }[] = [
    { count: "14", label: "Records Need Integrity Review", icon: AlertTriangle, color: "#EF4444", bg: "#FEF2F2" },
    { count: "33", label: "TSA Failures Detected", icon: AlertTriangle, color: "#F97316", bg: "#FFF7ED" },
    { count: "11", label: "OTS Pending Review", icon: AlertTriangle, color: "#6D28D9", bg: "#F5F3FF" },
    { count: "10", label: "Packages Missing", icon: Users, color: "#0891B2", bg: "#ECFEFF" },
    { count: "5", label: "Unsigned Reports", icon: AlertTriangle, color: "#64748B", bg: "#F8FAFC" },
  ];

  const recentEvidence: { name: string; meta: string; status: "Verified" | "Processing" }[] = [
    { name: "Interview_Audio.mp4", meta: "Case #2024-00115 · iPhone 14 Pro", status: "Verified" },
    { name: "Document_Contract.pdf", meta: "Case #2024-00114 · MacBook Pro", status: "Verified" },
    { name: "Video_Footage.mov", meta: "Case #2024-00113 · DJI_001", status: "Verified" },
    { name: "IMG_2024_1053.JPG", meta: "Case #2024-00112 · iPhone 14 Pro", status: "Verified" },
    { name: "Call_Recording.wav", meta: "Case #2024-00111 · Pixel 8 Pro", status: "Processing" },
  ];

  const evidenceTypes: { label: string; count: number; pct: string; color: string }[] = [
    { label: "Images", count: 92, pct: "75.0%", color: "#2563EB" },
    { label: "Documents", count: 25, pct: "20.0%", color: "#6D28D9" },
    { label: "Videos", count: 3, pct: "2.4%", color: "#0891B2" },
    { label: "Audio", count: 2, pct: "1.6%", color: "#F97316" },
    { label: "Archives", count: 1, pct: "0.8%", color: "#64748B" },
  ];

  const total = 123;
  const totalPct = 90;
  const donut = `conic-gradient(#2563EB 0% ${totalPct * 0.6}%, #6D28D9 ${totalPct * 0.6}% ${totalPct * 0.78}%, #0891B2 ${totalPct * 0.78}% ${totalPct * 0.88}%, #F97316 ${totalPct * 0.88}% ${totalPct * 0.96}%, #64748B ${totalPct * 0.96}% 100%)`;

  return (
    <div
      className={`mx-auto max-w-[1500px] overflow-hidden rounded-[24px] border border-[#E5E7EB] bg-white shadow-[0_28px_80px_rgba(15,23,42,0.10)] ${className}`}
    >
      <div className="grid grid-cols-[220px_1fr]">
        {/* Left sidebar */}
        <aside className="border-r border-[#E5E7EB] bg-[#F8FAFC] p-4 text-[12px] text-[#334155]">
          <div className="flex items-center gap-2 pb-1">
            {/* eslint-disable-next-line */}
            <img src="/assets/branding/proovra-mark.png" alt="" width={28} height={28} className="object-contain" />
            <div>
              <div className="text-[12.5px] font-bold text-[#0F172A]">PROOVRA</div>
              <div className="text-[8.5px] uppercase tracking-[0.12em] text-[#64748B]">
                Evidence • Trust • Integrity
              </div>
            </div>
          </div>

          <ul className="mt-4 space-y-0.5 pl-0">
            {sidebarItems.map((it) => {
              const Icon = it.icon;
              return (
                <li key={it.label} className="list-none">
                  <div
                    className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 ${
                      it.active
                        ? "border border-[#DBEAFE] bg-white text-[#2563EB]"
                        : "text-[#334155]"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Icon size={13} strokeWidth={1.85} />
                      {it.label}
                    </span>
                    {it.badge && (
                      <span className="rounded-md bg-[#EEF4FF] px-1.5 text-[9.5px] font-bold text-[#2563EB]">
                        {it.badge}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 rounded-xl border border-[#E5E7EB] bg-white p-2.5">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[#16A34A]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#16A34A]" /> System Status
            </div>
            <div className="mt-1 text-[9.5px] text-[#64748B]">All Systems Operational</div>
            <div className="text-[9px] text-[#94A3B8]">Last checked: 2 min ago</div>
          </div>

          <div className="mt-3 rounded-xl border border-[#E5E7EB] bg-white p-2.5">
            <div className="flex items-center gap-1.5">
              <Briefcase size={11} className="text-[#2563EB]" strokeWidth={1.85} />
              <span className="text-[10px] font-semibold text-[#0F172A]">Plan</span>
            </div>
            <div className="mt-0.5 text-[11px] font-bold text-[#0F172A]">Enterprise</div>
            <div className="text-[10px] font-semibold text-[#2563EB]">Manage</div>
          </div>

          <div className="mt-3 rounded-xl border border-[#E5E7EB] bg-white p-2.5">
            <div className="flex items-center gap-1.5">
              <HelpCircle size={11} className="text-[#64748B]" strokeWidth={1.85} />
              <span className="text-[10px] font-semibold text-[#0F172A]">Need Help?</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[9.5px] text-[#64748B]">
              Contact support or
              <ArrowRight size={9} className="text-[#64748B]" />
            </div>
            <div className="text-[9.5px] text-[#64748B]">view documentation</div>
          </div>
        </aside>

        {/* Main content */}
        <div className="bg-white p-5">
          {/* Top bar */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[16px] font-bold text-[#0F172A]">
                Good morning, Sara <span aria-hidden="true">👋</span>
              </div>
              <div className="mt-0.5 text-[11.5px] text-[#64748B]">
                Here&apos;s what&apos;s happening in your evidence ecosystem today.
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex h-9 w-[280px] items-center gap-2 rounded-[10px] border border-[#E5E7EB] bg-white px-3 text-[11px] text-[#94A3B8]">
                <Search size={13} strokeWidth={1.85} />
                Search evidence, cases, devices, hashes...
                <span className="ml-auto rounded-md bg-[#F1F5F9] px-1.5 text-[9px] font-semibold text-[#64748B]">⌘K</span>
              </div>
              <div className="relative inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#E5E7EB] bg-white text-[#0F172A]">
                <Bell size={14} strokeWidth={1.85} />
                <span className="absolute -right-1 -top-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#EF4444] text-[8px] font-bold text-white">
                  3
                </span>
              </div>
              <button
                type="button"
                className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-[#0F172A] px-3 text-[11.5px] font-semibold text-white"
              >
                <Plus size={13} strokeWidth={2.2} />
                New Case
                <ChevronDown size={11} strokeWidth={2} />
              </button>
              <div className="flex items-center gap-2 rounded-[10px] border border-[#E5E7EB] bg-white px-2 py-1">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#FED7AA] text-[10px] font-bold text-[#9A3412]">
                  SA
                </span>
                <div className="text-[10px] leading-tight">
                  <div className="font-bold text-[#0F172A]">Sara Al-Khatib</div>
                  <div className="text-[9px] text-[#64748B]">Administrator</div>
                </div>
                <ChevronDown size={10} className="text-[#64748B]" />
              </div>
            </div>
          </div>

          {/* Alert banner */}
          <div className="mt-4 flex items-start justify-between gap-3 rounded-[14px] border border-[#FECACA] bg-[#FEF2F2] p-3.5">
            <div className="flex items-start gap-2.5">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#FEE2E2] text-[#EF4444]">
                <AlertTriangle size={18} strokeWidth={2.2} />
              </span>
              <div>
                <div className="text-[12.5px] font-bold text-[#0F172A]">
                  33 TSA timestamps failed
                </div>
                <div className="mt-0.5 text-[11px] text-[#475569]">
                  Failed timestamping weakens time-based evidence confidence for these records.
                </div>
                <div className="text-[10px] text-[#64748B]">
                  Also: 14 records need integrity review · 10 packages are missing
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" className="rounded-md text-[11px] font-semibold text-[#EF4444]">
                Open affected records
              </button>
              <span className="text-[#94A3B8]"><X size={13} strokeWidth={1.85} /></span>
              <div className="ml-2 rounded-[10px] border border-[#E5E7EB] bg-white px-2 py-1 text-[9px]">
                <div className="uppercase tracking-[0.12em] text-[#64748B]">Workspace</div>
                <div className="mt-0.5 flex items-center gap-1 text-[10.5px] font-bold text-[#0F172A]">
                  Proovra Enterprise
                  <ChevronDown size={9} />
                </div>
              </div>
            </div>
          </div>

          {/* KPI cards */}
          <div className="mt-4 grid grid-cols-5 gap-2.5">
            {kpis.map((k) => (
              <div key={k.label} className="rounded-[12px] border border-[#E5E7EB] bg-white p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[9.5px] font-semibold text-[#64748B]">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-[#F1F5F9]">
                      <Layers size={10} strokeWidth={1.85} className="text-[#475569]" />
                    </span>
                    {k.label}
                  </div>
                  <MoreHorizontal size={12} className="text-[#94A3B8]" />
                </div>
                <div className="mt-2 text-[1.45rem] font-bold leading-none tracking-[-0.02em] text-[#0F172A]">
                  {k.value}
                </div>
                <div
                  className={`mt-1 text-[9.5px] font-semibold ${
                    k.helperTone === "good"
                      ? "text-[#16A34A]"
                      : k.helperTone === "warn"
                        ? "text-[#F97316]"
                        : "text-[#64748B]"
                  }`}
                >
                  {k.helper}
                </div>
                <svg viewBox="0 0 100 18" className="mt-1.5 h-4 w-full">
                  <path
                    d="M 0 12 Q 12 8 22 10 T 42 7 T 62 11 T 82 6 T 100 9"
                    fill="none"
                    stroke={k.chartColor}
                    strokeWidth="1.4"
                  />
                </svg>
              </div>
            ))}
          </div>

          {/* Priority Alerts row */}
          <div className="mt-4 rounded-[12px] border border-[#E5E7EB] bg-white p-3">
            <div className="flex items-center justify-between">
              <div className="text-[11.5px] font-bold text-[#0F172A]">Priority Alerts</div>
              <div className="text-[10px] font-semibold text-[#2563EB]">View all alerts →</div>
            </div>
            <div className="mt-2 grid grid-cols-5 gap-2">
              {priorityAlerts.map((a) => {
                const Icon = a.icon;
                return (
                  <div key={a.label} className="flex items-center gap-2 rounded-[10px] border border-[#E5E7EB] p-2">
                    <span
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                      style={{ background: a.bg, color: a.color }}
                    >
                      <Icon size={13} strokeWidth={2} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[14px] font-bold leading-none text-[#0F172A]">{a.count}</div>
                      <div className="mt-0.5 text-[9px] leading-tight text-[#64748B]">{a.label}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Lower grid */}
          <div className="mt-4 grid grid-cols-12 gap-2.5">
            {/* Evidence Activity */}
            <div className="col-span-5 rounded-[12px] border border-[#E5E7EB] bg-white p-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-bold text-[#0F172A]">Evidence Activity</div>
                <span className="rounded-md border border-[#E5E7EB] bg-white px-1.5 text-[9px] text-[#64748B]">
                  This Week
                </span>
              </div>
              <div className="mt-1 flex items-center gap-3 text-[9px] text-[#64748B]">
                <span className="flex items-center gap-1"><span className="h-1 w-3 rounded bg-[#0891B2]" /> This Week</span>
                <span className="flex items-center gap-1"><span className="h-1 w-3 rounded bg-[#94A3B8]" /> Last Week</span>
              </div>
              <svg viewBox="0 0 300 90" className="mt-2 h-[90px] w-full">
                <defs>
                  <linearGradient id="evf" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0891B2" stopOpacity="0.18" />
                    <stop offset="100%" stopColor="#0891B2" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M 0 60 L 50 50 L 100 45 L 150 25 L 200 40 L 250 55 L 300 35 L 300 90 L 0 90 Z" fill="url(#evf)" />
                <path d="M 0 60 L 50 50 L 100 45 L 150 25 L 200 40 L 250 55 L 300 35" fill="none" stroke="#0891B2" strokeWidth="1.6" />
                <path d="M 0 75 L 50 70 L 100 65 L 150 60 L 200 70 L 250 65 L 300 60" fill="none" stroke="#CBD5E1" strokeDasharray="3 3" strokeWidth="1.2" />
              </svg>
              <div className="mt-1 grid grid-cols-7 text-center text-[8px] text-[#94A3B8]">
                {["Mon 12","Tue 13","Wed 14","Thu 15","Fri 16","Sat 17","Sun 18"].map((d) => (<div key={d}>{d}</div>))}
              </div>
            </div>

            {/* Recent Evidence */}
            <div className="col-span-4 rounded-[12px] border border-[#E5E7EB] bg-white p-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-bold text-[#0F172A]">Recent Evidence</div>
                <span className="text-[9.5px] font-semibold text-[#2563EB]">View all</span>
              </div>
              <ul className="mt-2 space-y-1 pl-0">
                {recentEvidence.map((r) => (
                  <li key={r.name} className="flex items-center justify-between gap-2 list-none">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[#EEF4FF] text-[8.5px] font-bold text-[#2563EB]">
                        06
                      </span>
                      <div>
                        <div className="text-[9.5px] font-semibold text-[#0F172A]">{r.name}</div>
                        <div className="text-[8px] text-[#64748B]">{r.meta}</div>
                      </div>
                    </div>
                    <span
                      className={`rounded-md px-1.5 py-0.5 text-[8.5px] font-bold ${
                        r.status === "Verified"
                          ? "bg-[#ECFDF5] text-[#16A34A]"
                          : "bg-[#FEF3C7] text-[#92400E]"
                      }`}
                    >
                      {r.status}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 flex items-center justify-between text-[8.5px] text-[#64748B]">
                <span>Showing 5 of 245 items</span>
                <span className="font-semibold text-[#2563EB]">View full list →</span>
              </div>
            </div>

            {/* Evidence by Type */}
            <div className="col-span-3 rounded-[12px] border border-[#E5E7EB] bg-white p-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-bold text-[#0F172A]">Evidence by Type</div>
                <span className="rounded-md border border-[#E5E7EB] bg-white px-1.5 text-[9px] text-[#64748B]">
                  This Week
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2.5">
                <div className="relative flex h-[72px] w-[72px] items-center justify-center rounded-full" style={{ background: donut }}>
                  <div className="flex h-[50px] w-[50px] flex-col items-center justify-center rounded-full bg-white">
                    <div className="text-[12px] font-bold text-[#0F172A]">{total}</div>
                    <div className="text-[7.5px] uppercase tracking-[0.14em] text-[#94A3B8]">Total</div>
                  </div>
                </div>
                <ul className="flex-1 space-y-0.5 pl-0 text-[8.5px]">
                  {evidenceTypes.map((e) => (
                    <li key={e.label} className="flex list-none items-center justify-between text-[#475569]">
                      <span className="flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-sm" style={{ background: e.color }} />
                        {e.label}
                      </span>
                      <span>
                        <span className="font-semibold text-[#0F172A]">{e.count}</span>{" "}
                        <span className="text-[#94A3B8]">{e.pct}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* Verification Summary band */}
          <div className="mt-3 rounded-[12px] border border-[#E5E7EB] bg-white p-3">
            <div className="text-[11px] font-bold text-[#0F172A]">Verification Summary</div>
            <div className="mt-2 grid grid-cols-3 gap-2.5">
              <div>
                <div className="text-[9px] uppercase tracking-[0.10em] text-[#64748B]">Time-stamp proof (TSA)</div>
                <div className="mt-1 grid grid-cols-3 gap-1.5">
                  {[
                    { v: "85", l: "Stamped", c: "#0F172A" },
                    { v: "33", l: "Failed", c: "#EF4444" },
                    { v: "5", l: "Not stamped", c: "#94A3B8" },
                  ].map((s) => (
                    <div key={s.l} className="rounded-md border border-[#E5E7EB] p-1.5">
                      <div className="text-[13px] font-bold" style={{ color: s.c }}>{s.v}</div>
                      <div className="text-[8.5px] text-[#64748B]">{s.l}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-[0.10em] text-[#64748B]">OpenTimestamps (OTS)</div>
                <div className="mt-1 grid grid-cols-3 gap-1.5">
                  {[
                    { v: "94", l: "Anchored", c: "#0F172A" },
                    { v: "10", l: "Pending", c: "#F97316" },
                    { v: "19", l: "Not anchored", c: "#94A3B8" },
                  ].map((s) => (
                    <div key={s.l} className="rounded-md border border-[#E5E7EB] p-1.5">
                      <div className="text-[13px] font-bold" style={{ color: s.c }}>{s.v}</div>
                      <div className="text-[8.5px] text-[#64748B]">{s.l}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-[0.10em] text-[#64748B]">Signed records</div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="text-[14px] font-bold text-[#0F172A]">118 of 123</div>
                  <div className="text-[10px] font-semibold text-[#16A34A]">96%</div>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-[#E5E7EB]">
                  <div className="h-full rounded-full bg-[#16A34A]" style={{ width: "96%" }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
