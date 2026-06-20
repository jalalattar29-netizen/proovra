"use client";

import { useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  Copy,
  Download,
  Share2,
  Archive as PArchive,
  BadgeCheck as PSealCheck,
  FileText as PFilePdf,
  FileText as PFileText,
  History as PClock,
  Package as PPackage,
} from "lucide-react";
import {
  DEMO_RECORD,
  SectionEyebrow,
  SectionTitle,
  StatusPill,
  TABS,
  type StatusTone,
  type TabId,
} from "./_shared";

function OverviewPanel(_props: { onCopyLink: () => void }) {
  const summary: { label: string; value: string }[] = [
    { label: "File Name", value: DEMO_RECORD.fileName },
    { label: "File Size", value: DEMO_RECORD.fileSize },
    { label: "Created", value: DEMO_RECORD.createdAt },
    { label: "Verification ID", value: DEMO_RECORD.verificationId },
    { label: "Verified On", value: DEMO_RECORD.verifiedAt },
  ];
  const signals: { label: string; tone: StatusTone; value: string }[] = [
    { label: "Integrity State", tone: "valid", value: "Valid" },
    { label: "Signatures", tone: "valid", value: "Valid" },
    { label: "TSA Timestamp", tone: "verified", value: "Verified" },
    { label: "OpenTimestamp", tone: "published", value: "Published" },
    { label: "Custody", tone: "consistent", value: "Consistent" },
    { label: "Storage Protection", tone: "protected", value: "Protected" },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
        <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
          Verification Summary
        </h4>
        <dl className="mt-3 divide-y divide-[#E2E8F0]">
          {summary.map((r) => (
            <div
              key={r.label}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <dt className="text-[12.5px] text-[#475569]">{r.label}</dt>
              <dd className="text-right text-[12.5px] font-medium text-[#0F172A]">
                {r.value}
              </dd>
            </div>
          ))}
          <div className="flex items-center justify-between py-2.5">
            <dt className="text-[12.5px] text-[#475569]">Status</dt>
            <dd>
              <StatusPill tone="verified" label="Verified" />
            </dd>
          </div>
        </dl>
      </div>

      <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
        <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
          Key Signals
        </h4>
        <dl className="mt-3 divide-y divide-[#E2E8F0]">
          {signals.map((s) => (
            <div
              key={s.label}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <dt className="text-[12.5px] text-[#475569]">{s.label}</dt>
              <dd className="flex items-center gap-1.5">
                <StatusPill tone={s.tone} label={s.value} />
                <ChevronRight size={12} className="text-[#94A3B8]" />
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div
        className="rounded-2xl border border-[#E2E8F0] bg-white p-5"
        aria-label="Quick actions — demo only, not interactive"
      >
        <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
          Quick Actions
        </h4>
        <div className="mt-3 grid gap-2.5">
          <div
            role="presentation"
            className="inline-flex h-10 cursor-default items-center justify-center gap-2 rounded-lg bg-[#081A3D] text-[12.5px] font-semibold text-white select-none"
          >
            <Download size={13} />
            Download sample report
          </div>
          <div
            role="presentation"
            className="inline-flex h-10 cursor-default items-center justify-center gap-2 rounded-lg border border-[#E2E8F0] bg-white text-[12.5px] font-semibold text-[#0F172A] select-none"
          >
            <Download size={13} />
            Download evidence package
          </div>
          <div
            role="presentation"
            className="inline-flex h-10 cursor-default items-center justify-center gap-2 rounded-lg border border-[#E2E8F0] bg-white text-[12.5px] font-semibold text-[#0F172A] select-none"
          >
            <Copy size={13} />
            Copy verification link
          </div>
          <div
            role="presentation"
            className="inline-flex h-10 cursor-default items-center justify-center gap-2 rounded-lg border border-[#E2E8F0] bg-white text-[12.5px] font-semibold text-[#0F172A] select-none"
          >
            <Share2 size={13} />
            Share with reviewer
          </div>
        </div>
      </div>
    </div>
  );
}

function IntegrityPanel() {
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        Recorded Integrity State
      </h4>
      <p className="mt-1 text-[12.5px] text-[#475569]">
        Cryptographic fingerprint captured at evidence intake. Compared on each
        verification request.
      </p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          { label: "Algorithm", value: "SHA-256" },
          { label: "Digest", value: DEMO_RECORD.hash, mono: true },
          { label: "File Size", value: DEMO_RECORD.fileSize },
          { label: "Captured At", value: DEMO_RECORD.createdAt },
          { label: "Status", value: "Valid" },
          { label: "Last Check", value: DEMO_RECORD.verifiedAt },
        ].map((r) => (
          <div key={r.label} className="rounded-xl bg-[#F8FAFC] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
              {r.label}
            </div>
            <div
              className={`mt-1 text-[12.5px] text-[#0F172A] ${
                r.mono ? "font-mono break-all" : "font-medium"
              }`}
            >
              {r.label === "Status" ? (
                <StatusPill tone="valid" label="Valid" />
              ) : (
                r.value
              )}
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SignaturesPanel() {
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        Digital Signature Review
      </h4>
      <p className="mt-1 text-[12.5px] text-[#475569]">
        Signature materials, signer identity, and trust chain associated with
        the record.
      </p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          { label: "Signer", value: DEMO_RECORD.signer },
          { label: "Algorithm", value: "RSA-PSS / SHA-256" },
          { label: "Signed At", value: DEMO_RECORD.tsaTime },
          { label: "Certificate Authority", value: "Demo CA · Org Trust" },
          { label: "Chain Status", value: "Trusted" },
          { label: "Verification Result", value: "Valid" },
        ].map((r) => (
          <div key={r.label} className="rounded-xl bg-[#F8FAFC] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
              {r.label}
            </div>
            <div className="mt-1 text-[12.5px] font-medium text-[#0F172A]">
              {r.label === "Verification Result" ? (
                <StatusPill tone="valid" label={r.value} />
              ) : (
                r.value
              )}
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TimestampsPanel() {
  const events = [
    { source: "TSA · trusted-time-1.example", time: "May 17, 2026 09:15:22 UTC", status: "verified" as const },
    { source: "TSA · trusted-time-2.example", time: "May 17, 2026 09:15:24 UTC", status: "verified" as const },
    { source: "Internal sealing record", time: "May 17, 2026 09:15:28 UTC", status: "verified" as const },
  ];
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        TSA Timestamp Evidence
      </h4>
      <p className="mt-1 text-[12.5px] text-[#475569]">
        Timestamps issued by trusted RFC 3161 time authorities and matched at
        verification time.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-[#E2E8F0]">
        <table className="w-full border-collapse text-left">
          <thead className="bg-[#F8FAFC]">
            <tr>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Source
              </th>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Time
              </th>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.source} className="border-t border-[#E2E8F0]">
                <td className="px-4 py-2.5 text-[12.5px] text-[#0F172A]">
                  {e.source}
                </td>
                <td className="px-4 py-2.5 text-[12.5px] text-[#475569]">
                  {e.time}
                </td>
                <td className="px-4 py-2.5">
                  <StatusPill tone={e.status} label="Verified" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OpenTimestampPanel() {
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        OpenTimestamps Anchoring
      </h4>
      <p className="mt-1 text-[12.5px] text-[#475569]">
        Public blockchain anchoring snapshot for independent timing context.
      </p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          { label: "Status", value: "Published" },
          { label: "Calendars", value: "alice.btc.calendar.opentimestamps.org · finney.calendar.eternitywall.com" },
          { label: "Submitted", value: "May 17, 2026 09:16 UTC" },
          { label: "Confirmed Block Height", value: "841,927" },
          { label: "Network", value: "Bitcoin" },
          { label: "Result", value: "Anchored" },
        ].map((r) => (
          <div key={r.label} className="rounded-xl bg-[#F8FAFC] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
              {r.label}
            </div>
            <div className="mt-1 text-[12.5px] font-medium text-[#0F172A]">
              {r.label === "Status" ? (
                <StatusPill tone="published" label={r.value} />
              ) : (
                r.value
              )}
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CustodyPanel() {
  const events = [
    { event: "Captured", actor: "intake.service", time: "May 17, 09:14 UTC" },
    { event: "Hash Generated", actor: "fingerprint.engine", time: "May 17, 09:15 UTC" },
    { event: "TSA Recorded", actor: "tsa.publisher", time: "May 17, 09:15 UTC" },
    { event: "Signature Applied", actor: DEMO_RECORD.signer, time: "May 17, 09:16 UTC" },
    { event: "Sealed", actor: "storage.attestation", time: "May 17, 09:16 UTC" },
    { event: "Reviewer Accessed", actor: DEMO_RECORD.reviewer, time: "May 18, 11:02 UTC" },
    { event: "Report Generated", actor: "reports.service", time: "May 18, 14:36 UTC" },
  ];
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">
        Custody Trail (sample of {DEMO_RECORD.custodyEvents} events)
      </h4>
      <div className="mt-4 overflow-hidden rounded-xl border border-[#E2E8F0]">
        <table className="w-full border-collapse text-left">
          <thead className="bg-[#F8FAFC]">
            <tr>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">Event</th>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">Actor</th>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">Time</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.event} className="border-t border-[#E2E8F0]">
                <td className="px-4 py-2.5 text-[12.5px] font-medium text-[#0F172A]">{e.event}</td>
                <td className="px-4 py-2.5 text-[12.5px] text-[#475569]">{e.actor}</td>
                <td className="px-4 py-2.5 text-[12.5px] text-[#475569]">{e.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AccessPanel() {
  const rows = [
    { reviewer: "alex@company.com", action: "Viewed Overview", time: "May 18, 11:02 UTC" },
    { reviewer: "alex@company.com", action: "Opened Signatures tab", time: "May 18, 11:04 UTC" },
    { reviewer: "alex@company.com", action: "Downloaded sample report", time: "May 18, 11:08 UTC" },
    { reviewer: "review@firm.example", action: "Viewed Overview", time: "May 18, 13:21 UTC" },
  ];
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">Reviewer Access Log</h4>
      <p className="mt-1 text-[12.5px] text-[#475569]">
        Access activity is recorded separately from forensic custody events.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-[#E2E8F0]">
        <table className="w-full border-collapse text-left">
          <thead className="bg-[#F8FAFC]">
            <tr>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">Reviewer</th>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">Action</th>
              <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-[#E2E8F0]">
                <td className="px-4 py-2.5 text-[12.5px] text-[#0F172A]">{r.reviewer}</td>
                <td className="px-4 py-2.5 text-[12.5px] text-[#475569]">{r.action}</td>
                <td className="px-4 py-2.5 text-[12.5px] text-[#475569]">{r.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResourcesPanel() {
  const files: { name: string; type: string; size: string; role: string; icon: typeof PFilePdf }[] = [
    { name: "Document_Contract.pdf", type: "PDF", size: "2.4 MB", role: "Original file", icon: PFilePdf },
    { name: "verification-package.zip", type: "ZIP", size: "3.1 MB", role: "Disclosure package", icon: PArchive },
    { name: "signature.p7s", type: "PKCS#7", size: "8 KB", role: "Signature blob", icon: PSealCheck },
    { name: "tsa-response.tsr", type: "TSR", size: "5 KB", role: "TSA response", icon: PClock },
  ];
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">Supporting Materials</h4>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {files.map((f) => {
          const Icon = f.icon;
          return (
            <div key={f.name} className="flex items-start gap-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#BFDBFE] bg-[#EFF6FF] text-[#2563EB]">
                <Icon size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-semibold text-[#0F172A]">{f.name}</div>
                <div className="text-[11.5px] text-[#475569]">{f.role} · {f.type} · {f.size}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReportsPanel() {
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
      <h4 className="text-[13.5px] font-semibold text-[#0F172A]">Generated Reports</h4>
      <p className="mt-1 text-[12.5px] text-[#475569]">Reviewer-facing report outputs for {DEMO_RECORD.fileName}.</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {[
          { title: "Verification Report", body: "Reviewer-ready PDF summarizing integrity state, timestamps, custody, and access.", icon: PFileText, cta: "View PDF" },
          { title: "Verification Package", body: "Disclosure ZIP containing the original file, signature blob, TSA response, and audit trail.", icon: PPackage, cta: "View package" },
        ].map((r) => {
          const Icon = r.icon;
          return (
            <div key={r.title} role="presentation" aria-label="Sample record — not interactive" className="rounded-xl border border-[#E2E8F0] bg-white p-4 select-none">
              <div className="flex items-center gap-2.5">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#EFF6FF] text-[#2563EB]">
                  <Icon size={16} />
                </span>
                <span className="text-[13px] font-semibold text-[#0F172A]">{r.title}</span>
              </div>
              <p className="mt-2 text-[12px] leading-[1.55] text-[#475569]">{r.body}</p>
              <span className="mt-3 inline-flex cursor-default items-center gap-1 text-[12.5px] font-semibold text-[#2563EB]">
                {r.cta}
                <ArrowRight size={12} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Walkthrough({ onCopyLink }: { onCopyLink: () => void }) {
  const [active, setActive] = useState<TabId>("overview");

  return (
    <section id="interactive-walkthrough" className="bg-[#F8FAFC] py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6 md:px-8">
        <SectionEyebrow>Interactive record walkthrough</SectionEyebrow>
        <SectionTitle>Explore a verification record step by step.</SectionTitle>

        <div className="mt-10 grid gap-4 lg:grid-cols-[220px_1fr]">
          <nav className="h-fit rounded-2xl border border-[#E2E8F0] bg-white p-2">
            <ul className="space-y-1">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const isActive = tab.id === active;
                return (
                  <li key={tab.id}>
                    <button
                      type="button"
                      onClick={() => setActive(tab.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition ${
                        isActive
                          ? "bg-[#EFF6FF] font-semibold text-[#2563EB]"
                          : "text-[#475569] hover:bg-[#F8FAFC]"
                      }`}
                    >
                      <Icon size={14} strokeWidth={isActive ? 2.6 : 2.2} />
                      {tab.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[13.5px] font-semibold text-[#0F172A]">
                {TABS.find((t) => t.id === active)?.label}
              </div>
              <div className="text-[11.5px] text-[#64748B]">
                Demo record · {DEMO_RECORD.verificationId}
              </div>
            </div>

            {active === "overview" && <OverviewPanel onCopyLink={onCopyLink} />}
            {active === "integrity" && <IntegrityPanel />}
            {active === "signatures" && <SignaturesPanel />}
            {active === "timestamps" && <TimestampsPanel />}
            {active === "opentimestamp" && <OpenTimestampPanel />}
            {active === "custody" && <CustodyPanel />}
            {active === "access" && <AccessPanel />}
            {active === "resources" && <ResourcesPanel />}
            {active === "reports" && <ReportsPanel />}
          </div>
        </div>
      </div>
    </section>
  );
}
