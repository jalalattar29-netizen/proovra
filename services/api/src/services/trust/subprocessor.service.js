/**
 * PROOVRA Phase 4A — Subprocessor registry service.
 *
 * Versioned subprocessor list. Each entry carries purpose / region
 * / data categories / state / effective date / contract ref. Every
 * change writes a SubprocessorVersion row for the audit trail.
 *
 * Bounded providers (seeded by default):
 *   AWS, Azure, Deepgram, OpenAI, AWS Rekognition, Better Stack,
 *   Sentry, Cloudflare, Resend, Twilio, Stripe, PayPal, Grafana Cloud.
 */
import { SUBPROCESSOR_DATA_CATEGORIES, SUBPROCESSOR_STATES, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { emitSubprocessorEvent } from "./trust-and-governance-audit.service.js";
export async function upsertSubprocessor(input) {
    const state = input.state ?? "ACTIVE";
    if (!SUBPROCESSOR_STATES.includes(state)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    for (const c of input.dataCategories) {
        if (!SUBPROCESSOR_DATA_CATEGORIES.includes(c)) {
            return { ok: false, denial: "POLICY_REJECTED" };
        }
    }
    const prisma = input.prisma ?? defaultPrisma;
    const effective = input.effectiveAtUtc ?? new Date();
    const sp = await prisma.subprocessor.upsert({
        where: { teamId_slug: { teamId: input.teamId, slug: input.slug } },
        create: {
            teamId: input.teamId,
            slug: input.slug,
            name: input.name.slice(0, 120),
            vendor: input.vendor.slice(0, 120),
            purpose: input.purpose.slice(0, 600),
            region: input.region.slice(0, 80),
            state,
            version: 1,
            dataCategories: input.dataCategories,
            documentationUrl: input.documentationUrl ?? null,
            contractRef: input.contractRef ?? null,
            changeHistorySummary: input.changeSummary.slice(0, 600),
            effectiveAtUtc: effective,
        },
        update: {
            name: input.name.slice(0, 120),
            vendor: input.vendor.slice(0, 120),
            purpose: input.purpose.slice(0, 600),
            region: input.region.slice(0, 80),
            state,
            version: { increment: 1 },
            dataCategories: input.dataCategories,
            documentationUrl: input.documentationUrl ?? null,
            contractRef: input.contractRef ?? null,
            changeHistorySummary: input.changeSummary.slice(0, 600),
            effectiveAtUtc: effective,
        },
        select: { id: true, version: true },
    });
    await prisma.subprocessorVersion.create({
        data: {
            teamId: input.teamId,
            subprocessorId: sp.id,
            version: sp.version,
            changeSummary: input.changeSummary.slice(0, 600),
            snapshot: {
                name: input.name,
                vendor: input.vendor,
                purpose: input.purpose,
                region: input.region,
                state,
                dataCategories: input.dataCategories,
                documentationUrl: input.documentationUrl ?? null,
                contractRef: input.contractRef ?? null,
                effectiveAtUtc: effective.toISOString(),
            },
            authoredByUserId: input.authoredByUserId,
        },
    });
    // Emit audit lifecycle event — best-effort.
    const isFirstVersion = sp.version === 1;
    void emitSubprocessorEvent({
        prisma,
        teamId: input.teamId,
        subprocessorId: sp.id,
        code: isFirstVersion ? "SUBPROCESSOR_CREATED" : "SUBPROCESSOR_UPDATED",
        actorUserId: input.authoredByUserId,
    }).catch(() => { });
    if (!isFirstVersion && state === "DEPRECATED") {
        void emitSubprocessorEvent({
            prisma,
            teamId: input.teamId,
            subprocessorId: sp.id,
            code: "SUBPROCESSOR_DEPRECATED",
            actorUserId: input.authoredByUserId,
        }).catch(() => { });
    }
    return { ok: true, subprocessorId: sp.id, version: sp.version };
}
export async function listSubprocessors(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.subprocessor.findMany({
        where: {
            teamId: input.teamId,
            ...(input.state ? { state: input.state } : {}),
        },
        orderBy: { name: "asc" },
    });
    return rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug ?? "",
        vendor: r.vendor ?? "",
        purpose: r.purpose ?? "",
        region: r.region ?? "",
        dataCategories: Array.isArray(r.dataCategories)
            ? r.dataCategories
            : [],
        state: r.state,
        effectiveAtUtc: r.effectiveAtUtc.toISOString(),
        documentationUrl: r.documentationUrl,
        contractRef: r.contractRef,
        version: r.version,
        changeHistorySummary: r.changeHistorySummary ?? "",
    }));
}
export async function listSubprocessorVersions(input) {
    const prisma = input.prisma ?? defaultPrisma;
    return prisma.subprocessorVersion.findMany({
        where: { teamId: input.teamId, subprocessorId: input.subprocessorId },
        orderBy: { version: "asc" },
    });
}
/**
 * Idempotent seed of the canonical thirteen subprocessors PROOVRA
 * uses today. ensureSubprocessorSeed calls upsertSubprocessor for
 * each row, which performs prisma.subprocessor.upsert keyed on
 * (teamId, slug) — safe to re-run, additive across releases.
 */
export async function ensureSubprocessorSeed(input) {
    let created = 0;
    let updated = 0;
    for (const seed of SEED_SUBPROCESSORS) {
        const existing = await (input.prisma ?? defaultPrisma).subprocessor.findFirst({
            where: { teamId: input.teamId, slug: seed.slug },
            select: { id: true },
        });
        const res = await upsertSubprocessor({
            prisma: input.prisma,
            teamId: input.teamId,
            slug: seed.slug,
            name: seed.name,
            vendor: seed.vendor,
            purpose: seed.purpose,
            region: seed.region,
            state: "ACTIVE",
            dataCategories: seed.dataCategories,
            documentationUrl: seed.documentationUrl,
            contractRef: null,
            changeSummary: existing ? "seed re-applied" : "initial registration",
            authoredByUserId: input.systemUserId,
        });
        if (!res.ok)
            continue;
        if (existing)
            updated += 1;
        else
            created += 1;
    }
    return { created, updated };
}
const SEED_SUBPROCESSORS = [
    {
        slug: "aws",
        name: "Amazon Web Services",
        vendor: "Amazon Web Services, Inc.",
        purpose: "Compute (Lambda / Fargate), storage (S3 with Object Lock), KMS, queue infrastructure.",
        region: "US / EU regions, customer-selectable",
        dataCategories: ["EVIDENCE_BYTES", "METADATA", "AUDIT_LOGS"],
        documentationUrl: "https://aws.amazon.com/compliance/",
    },
    {
        slug: "azure",
        name: "Azure Document Intelligence",
        vendor: "Microsoft Corporation",
        purpose: "Document OCR, layout, tables, forms, entity extraction.",
        region: "Region selectable per workspace",
        dataCategories: ["EVIDENCE_BYTES", "OCR_TEXT"],
        documentationUrl: "https://learn.microsoft.com/azure/ai-services/document-intelligence/",
    },
    {
        slug: "deepgram",
        name: "Deepgram",
        vendor: "Deepgram, Inc.",
        purpose: "Speech-to-text, speaker diarisation.",
        region: "US (primary), EU when selected",
        dataCategories: ["EVIDENCE_BYTES", "TRANSCRIPT_TEXT"],
        documentationUrl: "https://deepgram.com/security",
    },
    {
        slug: "openai",
        name: "OpenAI",
        vendor: "OpenAI, L.L.C.",
        purpose: "Bounded entity extraction + document summary (REGEX_PII fallback runs locally when not bound).",
        region: "US",
        dataCategories: ["OCR_TEXT", "METADATA"],
        documentationUrl: "https://openai.com/policies",
    },
    {
        slug: "aws-rekognition",
        name: "AWS Rekognition",
        vendor: "Amazon Web Services, Inc.",
        purpose: "Image face detection, text detection, label detection (used for redaction tier).",
        region: "Region selectable per workspace",
        dataCategories: ["IMAGE_PIXELS", "METADATA"],
        documentationUrl: "https://aws.amazon.com/rekognition/faqs/",
    },
    {
        slug: "better-stack",
        name: "Better Stack",
        vendor: "Better Stack",
        purpose: "Uptime monitoring, status page upstream signals.",
        region: "EU",
        dataCategories: ["STATUS_PROBES"],
        documentationUrl: "https://betterstack.com/legal",
    },
    {
        slug: "sentry",
        name: "Sentry",
        vendor: "Functional Software, Inc. (Sentry)",
        purpose: "Application error telemetry.",
        region: "US / EU (configurable)",
        dataCategories: ["ERROR_TELEMETRY"],
        documentationUrl: "https://sentry.io/security/",
    },
    {
        slug: "cloudflare",
        name: "Cloudflare",
        vendor: "Cloudflare, Inc.",
        purpose: "Edge network, DDoS mitigation, TLS termination. R2 object storage scaffold present in env (R2_ENDPOINT / R2_BUCKET) but not yet wired into the evidence storage path.",
        region: "Global",
        dataCategories: ["METADATA"],
        documentationUrl: "https://www.cloudflare.com/trust-hub/",
    },
    {
        slug: "resend",
        name: "Resend",
        vendor: "Resend, Inc.",
        purpose: "Transactional email delivery for invitations, reviewer assignments, and operational notifications.",
        region: "US (primary), EU (configurable)",
        dataCategories: ["USER_IDENTIFIERS", "METADATA"],
        documentationUrl: "https://resend.com/legal/privacy-policy",
    },
    {
        slug: "twilio",
        name: "Twilio",
        vendor: "Twilio Inc.",
        purpose: "SMS / WhatsApp delivery and MFA Verify code transport for reviewer and portal authentication.",
        region: "US (primary), EU / regional pop selectable",
        dataCategories: ["USER_IDENTIFIERS", "METADATA"],
        documentationUrl: "https://www.twilio.com/legal/privacy",
    },
    {
        slug: "stripe",
        name: "Stripe",
        vendor: "Stripe, Inc.",
        purpose: "Subscription billing, checkout, webhook-driven entitlement updates. No card data is stored by PROOVRA; PCI scope sits with Stripe.",
        region: "US / EU / UK (regional processing)",
        dataCategories: ["USER_IDENTIFIERS", "METADATA"],
        documentationUrl: "https://stripe.com/privacy",
    },
    {
        slug: "paypal",
        name: "PayPal",
        vendor: "PayPal Holdings, Inc.",
        purpose: "Alternative subscription billing rail and webhook-driven entitlement updates. PROOVRA stores no payment instrument data.",
        region: "US / EU / UK (regional processing)",
        dataCategories: ["USER_IDENTIFIERS", "METADATA"],
        documentationUrl: "https://www.paypal.com/us/legalhub/privacy-full",
    },
    {
        slug: "grafana-cloud",
        name: "Grafana Cloud (OTLP)",
        vendor: "Grafana Labs",
        purpose: "OpenTelemetry traces and metrics gateway (OTEL_EXPORTER_OTLP_ENDPOINT). Carries bounded operational telemetry only — never evidence bytes, OCR text, transcripts, or PII.",
        region: "US / EU (configurable per OTLP endpoint)",
        dataCategories: ["METADATA", "ERROR_TELEMETRY"],
        documentationUrl: "https://grafana.com/legal/privacy-policy/",
    },
];
