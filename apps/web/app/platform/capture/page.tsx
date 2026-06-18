import type { Metadata } from "next";
import { Camera, FileBadge, Smartphone, Link2, ListChecks, Sparkles } from "lucide-react";
import { MarketingPage } from "../../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../../components/marketing/page-shell/PageHero";
import { FeatureGrid } from "../../../components/marketing/page-shell/FeatureGrid";
import { LegalClarification } from "../../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "Capture — PROOVRA Platform",
  description:
    "Collect digital evidence from files, devices, intake links, and guided capture sessions. Structured metadata, integrity hashing, and AI-assisted advisory review where applicable.",
};

const CAPABILITIES = [
  { title: "File uploads", body: "Drag-and-drop or programmatic upload of documents, images, audio, and video.", Icon: FileBadge, accent: "#2563EB" },
  { title: "Device capture", body: "Camera and microphone capture in supported workflows, with structured metadata.", Icon: Smartphone, accent: "#F97316" },
  { title: "Intake links", body: "Token-based public links let external participants submit evidence without an account.", Icon: Link2, accent: "#7C3AED" },
  { title: "Guided capture sessions", body: "Workflow-driven capture with readiness checklists and draft persistence.", Icon: ListChecks, accent: "#06B6D4" },
  { title: "Structured metadata", body: "Time, source, workflow, and user attribution are recorded alongside the file.", Icon: Camera, accent: "#EC4899" },
  { title: "AI-assisted advisory review", body: "Where enabled, advisory suggestions help reviewers spot issues. Human review is always required.", Icon: Sparkles, accent: "#2563EB" },
];

export default function CapturePage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="Platform · Capture"
        title="Collect evidence the right way,"
        highlight="from the start."
        description="From the first file or device capture, PROOVRA records integrity signals, time context, and source attribution — so later review starts on a defensible footing."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "See verification demo", href: MARKETING_LINKS.verifyDemo }}
      />
      <FeatureGrid
        eyebrow="What you can capture"
        title="Multiple intake paths. One consistent record."
        description="Each capture path produces the same structured Evidence Record, so downstream review, reporting, and verification stay consistent."
        items={CAPABILITIES}
        surface="soft"
        columns={3}
      />
      <LegalClarification />
      <PageCTA
        title="Start capturing"
        highlight="defensible evidence."
        primary={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
      />
    </MarketingPage>
  );
}
