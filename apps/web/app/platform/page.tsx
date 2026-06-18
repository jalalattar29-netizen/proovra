import type { Metadata } from "next";
import {
  Camera,
  FileBadge,
  ShieldCheck,
  FileText,
  Package,
  Briefcase,
  Users,
  ScrollText,
  Plug,
  Lock,
} from "lucide-react";
import { MarketingPage } from "../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../components/marketing/page-shell/FeatureGrid";
import { WorkflowSteps } from "../../components/marketing/page-shell/WorkflowSteps";
import { PageCTA } from "../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Platform — PROOVRA Evidence Operations",
  description:
    "PROOVRA is an enterprise evidence operations platform: capture, preserve, verify, report, and prove digital evidence end-to-end with cryptographic integrity and tamper-evident custody.",
};

const CAPABILITIES = [
  {
    title: "Capture",
    body: "Collect evidence from files, devices, intake links, and guided capture sessions with structured metadata.",
    Icon: Camera,
    accent: "#F97316",
  },
  {
    title: "Evidence Records",
    body: "Structured records with hashes, custody events, verification signals, and linked reports or packages.",
    Icon: FileBadge,
    accent: "#7C3AED",
  },
  {
    title: "Verification",
    body: "Public and private verification by URL, hash, or sealed package — locally or against the published record.",
    Icon: ShieldCheck,
    accent: "#06B6D4",
  },
  {
    title: "Reports",
    body: "Court-review-ready PDF reports with audit trail, integrity proof, and a clear technical appendix.",
    Icon: FileText,
    accent: "#EC4899",
  },
  {
    title: "Verification Packages",
    body: "Portable signed bundles containing the manifest, hashes, signatures, and chain of custody for independent review.",
    Icon: Package,
    accent: "#2563EB",
  },
  {
    title: "Cases & Matters",
    body: "Group evidence into claims, incidents, or investigations with assignments, decisions, and timelines.",
    Icon: Briefcase,
    accent: "#7C3AED",
  },
  {
    title: "Teams & Workspaces",
    body: "Workspace collaboration with roles, access control, and external reviewer participation.",
    Icon: Users,
    accent: "#F97316",
  },
  {
    title: "Governance",
    body: "Retention policies, legal hold, reviewable destruction, and lifecycle visibility.",
    Icon: ScrollText,
    accent: "#06B6D4",
  },
  {
    title: "Integrations",
    body: "REST API with bearer-token auth and HMAC-signed webhooks for downstream systems.",
    Icon: Plug,
    accent: "#EC4899",
  },
  {
    title: "Security Architecture",
    body: "Identity, access controls, MFA, immutable audit logging, and storage protection at every layer.",
    Icon: Lock,
    accent: "#2563EB",
  },
];

const LIFECYCLE = [
  { title: "Capture", body: "Collect evidence from any device or source.", Icon: Camera },
  { title: "Preserve", body: "Hash, encrypt, and timestamp records.", Icon: ShieldCheck },
  { title: "Verify", body: "Check integrity signals in real time.", Icon: FileBadge },
  { title: "Report", body: "Generate audit-ready evidence reports.", Icon: FileText },
  { title: "Prove", body: "Share verification by URL, hash, or package.", Icon: Package },
];

export default function PlatformOverviewPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Platform"
        title="An evidence operations platform"
        highlight="built for high-trust workflows."
        description="PROOVRA secures the entire evidence lifecycle — capture, preserve, verify, report, and prove — with cryptographic integrity, tamper-evident custody, and court-review-ready outputs."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
      />
      <WorkflowSteps
        eyebrow="Complete evidence lifecycle"
        title="From capture to proof. Every step covered."
        steps={LIFECYCLE}
      />
      <FeatureGrid
        eyebrow="Platform capabilities"
        title="Ten capabilities. One operations platform."
        description="Each capability is engineered for the realities of regulated, review-sensitive workflows — and surfaced honestly, with no hype."
        items={CAPABILITIES}
        surface="soft"
        columns={3}
      />
      <PageCTA
        title="Ready to transform your"
        highlight="evidence operations?"
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
    </MarketingPage>
  );
}
