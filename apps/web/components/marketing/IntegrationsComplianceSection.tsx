import Image from "next/image";
import {
  CalendarClock,
  CheckCircle2,
  Code2,
  Database,
  FileCheck2,
  Fingerprint,
  FolderLock,
  Globe2,
  Headphones,
  Landmark,
  Lock,
  Scale,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";

/* ─── Types ───────────────────────────────────────────────────────────── */

type BaseItem = { name: string; desc: string };
type LogoItem = BaseItem & { kind: "logo"; logo: string };
type IconItem = BaseItem & { kind: "icon"; Icon: LucideIcon; tint?: string };
type TileItem = LogoItem | IconItem;

/* ─── Data ────────────────────────────────────────────────────────────── */

const integrations: TileItem[] = [
  { kind: "logo", name: "Microsoft 365", desc: "SSO & Directory", logo: "/assets/logos/microsoft.svg" },
  { kind: "logo", name: "Google Workspace", desc: "SSO & APIs", logo: "/assets/logos/google.svg" },
  { kind: "logo", name: "AWS", desc: "Infrastructure", logo: "/assets/logos/aws.svg" },
  { kind: "logo", name: "Microsoft Azure", desc: "Infrastructure", logo: "/assets/logos/azure.svg" },
  { kind: "logo", name: "Okta", desc: "SSO & Identity", logo: "/assets/logos/okta.svg" },
  { kind: "logo", name: "OneLogin", desc: "SSO & Identity", logo: "/assets/logos/onelogin.svg" },
  { kind: "icon", name: "SFTP", desc: "Secure Transfer", Icon: FolderLock, tint: "#475569" },
  { kind: "logo", name: "Webhook", desc: "Real-time Events", logo: "/assets/logos/webhooks.svg" },
  { kind: "logo", name: "OpenAI", desc: "AI Assistance", logo: "/assets/logos/openai.svg" },
  { kind: "logo", name: "Sentry", desc: "Error Tracking", logo: "/assets/logos/sentry.svg" },
  { kind: "logo", name: "Grafana", desc: "Monitoring", logo: "/assets/logos/grafana.svg" },
  { kind: "icon", name: "Upstash", desc: "Serverless Data", Icon: Database, tint: "#10B981" },
  { kind: "logo", name: "Resend", desc: "Email Delivery", logo: "/assets/logos/resend.svg" },
  { kind: "logo", name: "Twilio", desc: "Messaging", logo: "/assets/logos/twilio.svg" },
  { kind: "logo", name: "Stripe", desc: "Payments", logo: "/assets/logos/stripe.svg" },
  { kind: "logo", name: "PayPal", desc: "Payments", logo: "/assets/logos/paypal.svg" },
  { kind: "logo", name: "Box", desc: "Content Management", logo: "/assets/logos/box.svg" },
  { kind: "icon", name: "OTS", desc: "Timestamping", Icon: Fingerprint, tint: "#F7931A" },
  { kind: "icon", name: "Custom API", desc: "Build on PROOVRA", Icon: Code2, tint: "#475569" },
];

const compliance: TileItem[] = [
  { kind: "logo", name: "SOC 2 Ready", desc: "Security controls and monitoring", logo: "/assets/logos/soc.svg" },
  { kind: "logo", name: "ISO 27001 Aligned", desc: "Information security management", logo: "/assets/logos/iso.svg" },
  { kind: "icon", name: "GDPR Ready", desc: "Data protection by design", Icon: ShieldCheck, tint: "#2563EB" },
  { kind: "icon", name: "HIPAA Ready", desc: "Protected health information", Icon: FileCheck2, tint: "#BE123C" },
  { kind: "logo", name: "NIST Aligned", desc: "Cybersecurity framework", logo: "/assets/logos/nist.svg" },
  { kind: "logo", name: "SAML SSO Supported", desc: "Enterprise single sign-on", logo: "/assets/logos/saml.svg" },
  { kind: "icon", name: "MFA Enforced", desc: "Multi-factor authentication", Icon: Lock, tint: "#15803D" },
  { kind: "icon", name: "SCIM Supported", desc: "User provisioning and sync", Icon: Users, tint: "#7C3AED" },
  { kind: "icon", name: "Audit Logs Complete", desc: "Full activity transparency", Icon: FileCheck2, tint: "#2563EB" },
  { kind: "icon", name: "Legal Hold Enabled", desc: "Preserve evidence on demand", Icon: Landmark, tint: "#0F766E" },
  { kind: "icon", name: "Retention Controls", desc: "Policy-based retention", Icon: CalendarClock, tint: "#EA580C" },
  { kind: "icon", name: "Tamper-Evident Records", desc: "Integrity verified at every step", Icon: Fingerprint, tint: "#BE123C" },
];

const trustBar: { name: string; desc: string; Icon: LucideIcon; color: string }[] = [
  { name: "Enterprise Security", desc: "Built from the ground up", Icon: ShieldCheck, color: "#0F766E" },
  { name: "Data Integrity", desc: "Cryptographic verification", Icon: Lock, color: "#BE123C" },
  { name: "Operational Trust", desc: "Proven in the field", Icon: CheckCircle2, color: "#15803D" },
  { name: "Court-Ready", desc: "Review-ready evidence", Icon: Scale, color: "#F97316" },
  { name: "Global Scale", desc: "Available worldwide", Icon: Globe2, color: "#2563EB" },
  { name: "Expert Support", desc: "Enterprise support", Icon: Headphones, color: "#0F172A" },
];

/* ─── Tile ────────────────────────────────────────────────────────────── */

function Tile({ item }: { item: TileItem }) {
  const accent = item.kind === "icon" && item.tint ? item.tint : "#0F172A";

  return (
    <div
      className="flex items-center gap-3 rounded-2xl border border-[#E5E7EB] bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-[#CBD5E1]"
      style={{ minHeight: 72, overflowWrap: "normal", wordBreak: "normal" }}
    >
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#E5E7EB] bg-[#F8FAFC]"
        style={item.kind === "logo" ? undefined : { color: accent }}
      >
        {item.kind === "logo" ? (
          <Image
            src={item.logo}
            alt={`${item.name} logo`}
            width={28}
            height={28}
            className="h-7 w-7 object-contain"
          />
        ) : (
          <item.Icon size={18} strokeWidth={1.85} />
        )}
      </div>
      <div
        className="flex min-w-0 flex-col"
        style={{ overflowWrap: "normal", wordBreak: "normal" }}
      >
        <div
          className="text-[13px] font-bold leading-tight text-[#0F172A]"
          style={{ overflowWrap: "normal", wordBreak: "normal" }}
        >
          {item.name}
        </div>
        <div
          className="mt-0.5 text-[11px] font-medium leading-tight text-[#64748B]"
          style={{ overflowWrap: "normal", wordBreak: "normal" }}
        >
          {item.desc}
        </div>
      </div>
    </div>
  );
}

/* ─── Section ─────────────────────────────────────────────────────────── */

export function IntegrationsComplianceSection() {
  return (
    <section
      id="integrations"
      className="bg-white"
      style={{ paddingTop: 96, paddingBottom: 96 }}
    >
      <div className="mx-auto max-w-[1480px] space-y-8 px-5 md:px-8 lg:px-10">
        <div className="grid gap-8 lg:grid-cols-2">
          {/* LEFT — Integrations */}
          <div className="relative overflow-hidden rounded-[28px] border border-cyan-100 bg-white p-6 shadow-[0_24px_70px_rgba(15,23,42,0.06)] md:p-8">
            <span className="inline-flex items-center gap-2 rounded-full bg-cyan-50 px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#0F766E]">
              <ShieldCheck size={12} strokeWidth={2.2} />
              Integrations
            </span>
            <h2 className="mt-5 max-w-[460px] text-[32px] font-extrabold leading-[1.05] tracking-[-0.025em] text-[#0F172A] md:text-[38px]">
              Connect with every layer.
            </h2>
            <p className="mt-3 max-w-[520px] text-[14.5px] leading-[1.6] text-[#475569]">
              PROOVRA integrates with the tools and systems you already rely on
              — securely and seamlessly.
            </p>

            <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {integrations.map((item) => (
                <Tile key={item.name} item={item} />
              ))}
            </div>
          </div>

          {/* RIGHT — Compliance */}
          <div
            id="governance"
            className="relative overflow-hidden rounded-[28px] border border-rose-100 bg-white p-6 shadow-[0_24px_70px_rgba(15,23,42,0.06)] md:p-8"
          >
            <span className="inline-flex items-center gap-2 rounded-full bg-rose-50 px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#BE123C]">
              <ShieldCheck size={12} strokeWidth={2.2} />
              Compliance &amp; Certifications
            </span>
            <h2 className="mt-5 max-w-[460px] text-[32px] font-extrabold leading-[1.05] tracking-[-0.025em] text-[#0F172A] md:text-[38px]">
              Built for regulated industries.
            </h2>
            <p className="mt-3 max-w-[560px] text-[14.5px] leading-[1.6] text-[#475569]">
              Enterprise-grade security, governance, and compliance controls
              built into every layer of PROOVRA.
            </p>

            <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {compliance.map((item) => (
                <Tile key={item.name} item={item} />
              ))}
            </div>
          </div>
        </div>

        {/* Trust bar */}
        <div className="overflow-hidden rounded-[22px] border border-[#E5E7EB] bg-white shadow-[0_16px_50px_rgba(15,23,42,0.05)]">
          <div className="grid grid-cols-1 divide-y divide-[#E5E7EB] sm:grid-cols-2 sm:divide-y-0 md:grid-cols-3 lg:grid-cols-6 lg:divide-x">
            {trustBar.map(({ Icon, name, desc, color }) => (
              <div key={name} className="flex items-start gap-3 px-5 py-5 lg:px-6">
                <span
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#E2E8F0] bg-[#F8FAFC]"
                  style={{ color }}
                >
                  <Icon size={17} strokeWidth={1.85} />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-extrabold leading-[1.25] text-[#0F172A]">
                    {name}
                  </div>
                  <div className="mt-1 text-[11.5px] leading-[1.45] text-[#64748B]">
                    {desc}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
