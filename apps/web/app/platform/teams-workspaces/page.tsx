import type { Metadata } from "next";
import { Users, ShieldCheck, Globe2, KeyRound, Link2, Building } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Teams & Workspaces — PROOVRA Platform",
  description:
    "Workspace collaboration with roles, access control, external reviewers, and identity integration.",
};

const FEATURES = [
  { title: "Workspaces", body: "Scope evidence and access to a team, department, or organization.", Icon: Building, accent: "#2563EB" },
  { title: "Roles & access control", body: "Role-based access for reviewers, investigators, admins, and observers.", Icon: KeyRound, accent: "#7C3AED" },
  { title: "Team collaboration", body: "Assign, discuss, escalate, and resolve on evidence records and cases.", Icon: Users, accent: "#06B6D4" },
  { title: "External reviewer portals", body: "Token-based portals let outside counsel or auditors review without an account.", Icon: Globe2, accent: "#F97316" },
  { title: "Public intake links", body: "External participants submit evidence through guarded token links.", Icon: Link2, accent: "#EC4899" },
  { title: "Identity integration", body: "SAML 2.0 SSO and SCIM 2.0 provisioning where available.", Icon: ShieldCheck, accent: "#2563EB" },
];

export default function TeamsWorkspacesPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Platform · Teams & Workspaces"
        title="Built for collaboration,"
        highlight="not just storage."
        description="Evidence work is rarely a one-person job. PROOVRA workspaces support teams, external reviewers, and enterprise identity from day one."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
      <FeatureGrid
        eyebrow="Collaboration capabilities"
        title="Work together, securely."
        items={FEATURES}
        surface="soft"
        columns={3}
      />
      <PageCTA
        title="Collaborate on evidence,"
        highlight="without losing control."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
    </MarketingPage>
  );
}
