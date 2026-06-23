/**
 * Production regression test — Trust Center enterprise completion.
 *
 * Companion to production-trust-center-empty-state.test.ts. The
 * empty-state test pins the seed-pipeline plumbing (auto-seed-on-GET,
 * unblocked seed POST, landing button parallel seed, status load-state
 * machine). THIS test pins the CONTENT enterprise completion delivered
 * across four parallel streams:
 *
 *   Stream A — trust-center.service.ts content (15+9+14+23 = 61
 *     SEED_ARTICLES; encryption + MFA + KMS rewrites; new SECURITY
 *     slugs signer-registry / webhook-hmac / rate-limits /
 *     session-revocation / verification-package-signing; new
 *     AI_DISCLOSURE slugs semantic-search-embeddings /
 *     outbound-flag-default; AI_LEGAL_DISCLAIMER imported + surfaced).
 *
 *   Stream B — subprocessor.service.ts content (13 SEED_SUBPROCESSORS:
 *     8 originals + Resend + Twilio + Stripe + PayPal + Grafana Cloud;
 *     Cloudflare R2 scaffold-only disclosure).
 *
 *   Stream C — status-page.service.ts (13-component seed maps 1:1
 *     against the canonical STATUS_COMPONENT_KEYS shared enum;
 *     ensureStatusComponentsSeed lazy-called from projectStatusPage).
 *
 *   Stream D — Trust Center landing 7-tile summary band; methodology
 *     page legal cross-link; 4-phase LoadState machine in the shared
 *     _section-list component; implementation references collapsed
 *     under a <details> summary.
 *
 * Plus bounded GUARDs:
 *   * Sentry-batch repair migration present + allowlisted.
 *   * No fake certifications (SOC / ISO / FedRAMP / PCI / HIPAA).
 *   * No raw env names / stack traces in client-rendered strings.
 *   * No Trust v2 routes / pages.
 *   * No new /v1/trust endpoints beyond the canonical 18.
 *   * Forbidden phrases (the old encryption / MFA overclaims) are
 *     gone (negative pins).
 *   * AI_LEGAL_DISCLAIMER is imported (no copy-paste of the literal).
 *
 * Style: source-contract (file-text via readFileSync). No DB I/O.
 * Mirrors the prior production-trust-center-empty-state.test.ts file.
 */
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readRepo(rel) {
    return readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");
}
function existsRepo(rel) {
    return existsSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)));
}
const TRUST_SERVICE = readRepo("services/api/src/services/trust/trust-center.service.ts");
const SUBPROCESSOR_SERVICE = readRepo("services/api/src/services/trust/subprocessor.service.ts");
const STATUS_SERVICE = readRepo("services/api/src/services/trust/status-page.service.ts");
const ROUTES = readRepo("services/api/src/routes/trust-and-governance.routes.ts");
// Phase E5 rebaseline (see .ts mirror): workspace Trust hub migrated
// to (app)/trust-hub/page.tsx; canonical public Trust Center owns /trust.
const TRUST_PAGE = readRepo("apps/web/app/(app)/trust-hub/page.tsx");
const REDIRECT_LANDING = readRepo("apps/web/app/(app)/trust-center/page.tsx");
const METHODOLOGY_PAGE = readRepo("apps/web/app/(app)/trust-center/methodology/page.tsx");
const SECTION_LIST = readRepo("apps/web/app/(app)/trust-center/_section-list.tsx");
const STATUS_PAGE = readRepo("apps/web/app/(app)/trust-center/status/page.tsx");
const AI_DISCLOSURE_PAGE = readRepo("apps/web/app/(app)/trust-center/ai-disclosure/page.tsx");
const SECURITY_PAGE = readRepo("apps/web/app/(app)/trust-center/security/page.tsx");
const SUBPROCESSORS_PAGE = readRepo("apps/web/app/(app)/trust-center/subprocessors/page.tsx");
const ALLOWLIST_GUARD = readRepo("services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts");
// Tiny helper — count occurrences of `kind: "<KIND>"` in SEED_ARTICLES
// (the only `kind:` property used by SeedArticle rows). Mirrors the
// canonical seed list shape declared at trust-center.service.ts:
// `const SEED_ARTICLES: ReadonlyArray<SeedArticle> = [ ... ]`.
function countKind(source, kind) {
    const re = new RegExp(`kind:\\s*"${kind}"`, "g");
    return (source.match(re) ?? []).length;
}
// ===========================================================================
// (1) Trust landing is not empty after seed — TRUST_CENTER count >= 15
// ===========================================================================
describe("(1) Trust landing seed has >= 15 TRUST_CENTER articles", () => {
    it("SEED_ARTICLES contains at least 15 TRUST_CENTER entries", () => {
        expect(countKind(TRUST_SERVICE, "TRUST_CENTER")).toBeGreaterThanOrEqual(15);
    });
});
// ===========================================================================
// (2) Methodology has published articles after seed — METHODOLOGY count
// ===========================================================================
describe("(2) Methodology seed has >= 9 METHODOLOGY articles", () => {
    it("SEED_ARTICLES contains at least 9 METHODOLOGY entries", () => {
        expect(countKind(TRUST_SERVICE, "METHODOLOGY")).toBeGreaterThanOrEqual(9);
    });
});
// ===========================================================================
// (3) Methodology page links to /legal/verification-methodology
// ===========================================================================
describe("(3) Methodology page links to legal counterpart", () => {
    it("methodology page contains /legal/verification-methodology link", () => {
        expect(METHODOLOGY_PAGE).toMatch(/\/legal\/verification-methodology/);
        expect(METHODOLOGY_PAGE).toMatch(/data-methodology-legal-link/);
    });
});
// ===========================================================================
// (4) AI Disclosure has meaningful articles — count >= 14 (12 + 2)
// ===========================================================================
describe("(4) AI Disclosure seed has >= 14 AI_DISCLOSURE articles", () => {
    it("SEED_ARTICLES contains at least 14 AI_DISCLOSURE entries (12 original + 2 new)", () => {
        expect(countKind(TRUST_SERVICE, "AI_DISCLOSURE")).toBeGreaterThanOrEqual(14);
    });
});
// ===========================================================================
// (5) AI Disclosure includes semantic-search disclosure
// ===========================================================================
describe("(5) AI Disclosure includes semantic-search embeddings disclosure", () => {
    it('SEED_ARTICLES contains an AI_DISCLOSURE slug whose name includes "semantic"', () => {
        // The Phase 16 disclosure slug is `semantic-search-embeddings`,
        // declared inside an AI_DISCLOSURE block. Pin both that the slug
        // appears AND that it belongs to an AI_DISCLOSURE entry.
        expect(TRUST_SERVICE).toMatch(/slug:\s*"semantic-search-embeddings"/);
        // Confirm the slug sits inside an AI_DISCLOSURE article body by
        // scanning the 800-char window around the slug for `kind: "AI_DISCLOSURE"`.
        const idx = TRUST_SERVICE.indexOf('slug: "semantic-search-embeddings"');
        expect(idx).toBeGreaterThan(-1);
        const window = TRUST_SERVICE.slice(Math.max(0, idx - 400), idx + 400);
        expect(window).toMatch(/kind:\s*"AI_DISCLOSURE"/);
    });
});
// ===========================================================================
// (6) AI Disclosure includes advisory-only disclaimer
// ===========================================================================
describe("(6) AI_LEGAL_DISCLAIMER is imported AND surfaced via the constant", () => {
    it("trust-center.service.ts imports AI_LEGAL_DISCLAIMER from ai-policy.js", () => {
        expect(TRUST_SERVICE).toMatch(/import\s*\{[^}]*AI_LEGAL_DISCLAIMER[^}]*\}\s*from\s*"\.\.\/ai\/ai-policy\.js"/);
    });
    it("trust-center.service.ts references AI_LEGAL_DISCLAIMER in an article body (template-literal injection)", () => {
        // The constant must be REFERENCED (not copy-pasted as a string
        // literal). Pinning the template-literal `${AI_LEGAL_DISCLAIMER}`
        // form keeps the seed in lockstep with ai-policy.ts edits.
        expect(TRUST_SERVICE).toMatch(/\$\{AI_LEGAL_DISCLAIMER\}/);
    });
});
// ===========================================================================
// (7) Security has meaningful articles — count >= 23 (18 + 5)
// ===========================================================================
describe("(7) Security seed has >= 23 SECURITY articles", () => {
    it("SEED_ARTICLES contains at least 23 SECURITY entries (18 original + 5 new)", () => {
        expect(countKind(TRUST_SERVICE, "SECURITY")).toBeGreaterThanOrEqual(23);
    });
    it("the 5 new SECURITY slugs are present", () => {
        expect(TRUST_SERVICE).toMatch(/slug:\s*"signer-registry"/);
        expect(TRUST_SERVICE).toMatch(/slug:\s*"webhook-hmac"/);
        expect(TRUST_SERVICE).toMatch(/slug:\s*"rate-limits"/);
        expect(TRUST_SERVICE).toMatch(/slug:\s*"session-revocation"/);
        expect(TRUST_SERVICE).toMatch(/slug:\s*"verification-package-signing"/);
    });
});
// ===========================================================================
// (8) Security does NOT contain forbidden unsupported claims
// ===========================================================================
describe("(8) Security seed contains no fake certifications or unsupported claims", () => {
    it("no SOC 2 / SOC2 claim", () => {
        expect(TRUST_SERVICE).not.toMatch(/\bSOC\s*2\b/i);
        expect(TRUST_SERVICE).not.toMatch(/\bSOC2\b/i);
    });
    it("no ISO 27001 claim", () => {
        expect(TRUST_SERVICE).not.toMatch(/\bISO\s*27001\b/i);
    });
    it("no FedRAMP claim", () => {
        expect(TRUST_SERVICE).not.toMatch(/\bFedRAMP\b/i);
    });
    it("no PCI-DSS claim", () => {
        // PCI is OK only as a passing reference inside the Stripe-related
        // entries where it appears as "PCI scope sits with Stripe" — that
        // pattern lives in subprocessor.service.ts (NOT in this file).
        // Inside trust-center.service.ts, no PCI-DSS / PCI compliance
        // language is permitted.
        expect(TRUST_SERVICE).not.toMatch(/\bPCI[-\s]?DSS\b/i);
        expect(TRUST_SERVICE).not.toMatch(/\bPCI\s+compliant\b/i);
        expect(TRUST_SERVICE).not.toMatch(/\bPCI\s+certified\b/i);
    });
    it("no HIPAA-certified claim", () => {
        expect(TRUST_SERVICE).not.toMatch(/\bHIPAA\b/i);
    });
    it('any "SSE-KMS" mention is bounded to a disclaimer in the encryption slug', () => {
        // The only legitimate use of "SSE-KMS" is the encryption slug
        // which explicitly DISCLAIMS: "PROOVRA does not currently
        // configure ... PROOVRA-managed SSE-KMS headers in the application
        // layer". Pin that every occurrence is preceded (within 200 chars)
        // by "does not" / "not currently" so we never silently claim
        // SSE-KMS as an active control.
        const matches = (() => {
            const out = [];
            let i = 0;
            while (true) {
                const next = TRUST_SERVICE.indexOf("SSE-KMS", i);
                if (next < 0)
                    break;
                out.push(next);
                i = next + 1;
            }
            return out;
        })();
        for (const at of matches) {
            const pre = TRUST_SERVICE.slice(Math.max(0, at - 200), at);
            expect(pre, `SSE-KMS at offset ${at} is not bounded by a disclaimer`).toMatch(/(does not|not currently|never)/i);
        }
    });
    it("Object Lock claim is anchored to S3_OBJECT_LOCK_ENABLED / object-lock-status references", () => {
        // Object Lock is allowed BECAUSE the encryption / immutability
        // articles cite real implementation: object-lock-status.service.ts
        // and bootstrap/object-lock-verification.ts. Pin the references
        // remain present so a future edit cannot strip the evidence while
        // keeping the claim.
        expect(TRUST_SERVICE).toMatch(/services\/api\/src\/services\/operations\/object-lock-status\.service\.ts/);
        expect(TRUST_SERVICE).toMatch(/services\/api\/src\/bootstrap\/object-lock-verification\.ts/);
    });
});
// ===========================================================================
// (9) Subprocessors seed includes configured providers
// ===========================================================================
describe("(9) Subprocessors seed includes Resend / Twilio / Stripe / PayPal / Grafana", () => {
    it("Resend slug present", () => {
        expect(SUBPROCESSOR_SERVICE).toMatch(/slug:\s*"resend"/);
    });
    it("Twilio slug present", () => {
        expect(SUBPROCESSOR_SERVICE).toMatch(/slug:\s*"twilio"/);
    });
    it("Stripe slug present", () => {
        expect(SUBPROCESSOR_SERVICE).toMatch(/slug:\s*"stripe"/);
    });
    it("PayPal slug present", () => {
        expect(SUBPROCESSOR_SERVICE).toMatch(/slug:\s*"paypal"/);
    });
    it("Grafana / OTLP gateway slug present", () => {
        expect(SUBPROCESSOR_SERVICE).toMatch(/slug:\s*"grafana-cloud"/);
    });
});
// ===========================================================================
// (10) Subprocessors page no longer empty when providers exist — upsert idempotent
// ===========================================================================
describe("(10) ensureSubprocessorSeed uses prisma.subprocessor.upsert (idempotent)", () => {
    it("subprocessor.service.ts uses upsert keyed on teamId_slug composite", () => {
        expect(SUBPROCESSOR_SERVICE).toMatch(/prisma\.subprocessor\.upsert/);
        expect(SUBPROCESSOR_SERVICE).toMatch(/teamId_slug:\s*\{\s*teamId[^}]+slug[^}]+\}/);
    });
});
// ===========================================================================
// (11) Status components seed has at least 8 distinct keys
// ===========================================================================
describe("(11) Status seed has >= 8 distinct component keys", () => {
    it("SEED_COMPONENTS contains at least 8 entries", () => {
        // Each entry is `{ key: "<NAME>", label: ..., description: ... }`.
        // Count distinct key literals inside the SEED_COMPONENTS slice.
        const idx = STATUS_SERVICE.indexOf("SEED_COMPONENTS");
        expect(idx).toBeGreaterThan(-1);
        const slice = STATUS_SERVICE.slice(idx);
        const keys = new Set();
        const re = /key:\s*"([A-Z_]+)"/g;
        let m;
        while ((m = re.exec(slice)) !== null) {
            keys.add(m[1]);
            if (keys.size > 50)
                break;
        }
        expect(keys.size).toBeGreaterThanOrEqual(8);
    });
});
// ===========================================================================
// (12) Status page degraded fallback returns bounded SCHEMA_NOT_READY
// ===========================================================================
describe("(12) Status GET returns bounded reason on P2022 path", () => {
    it("trust-and-governance.routes.ts surfaces SCHEMA_NOT_READY on P2022", () => {
        expect(ROUTES).toMatch(/code\s*===\s*"P2022"/);
        expect(ROUTES).toMatch(/reason:\s*"SCHEMA_NOT_READY"/);
        expect(ROUTES).toMatch(/degraded:\s*true/);
    });
});
// ===========================================================================
// (13) Re-seed is idempotent — ensureTrustCenterSeed uses upsert
// ===========================================================================
describe("(13) ensureTrustCenterSeed is upsert-idempotent", () => {
    it("trust-center.service.ts uses prisma.trustCenterArticle.upsert", () => {
        expect(TRUST_SERVICE).toMatch(/prisma\.trustCenterArticle\.upsert/);
        expect(TRUST_SERVICE).toMatch(/teamId_kind_slug/);
    });
    it("ensureTrustCenterSeed iterates SEED_ARTICLES and calls upsertTrustArticle", () => {
        expect(TRUST_SERVICE).toMatch(/for\s*\(const\s+seed\s+of\s+SEED_ARTICLES\)/);
        expect(TRUST_SERVICE).toMatch(/upsertTrustArticle\(/);
    });
});
// ===========================================================================
// (14) No Trust v2 route exists — empty Globs
// ===========================================================================
describe("(14) No Trust v2 route / page exists", () => {
    it("no /trust-center-v2 or trust_center_v2 references in any touched file", () => {
        expect(TRUST_SERVICE).not.toMatch(/trust[-_]center[-_]v2/);
        expect(SUBPROCESSOR_SERVICE).not.toMatch(/trust[-_]center[-_]v2/);
        expect(STATUS_SERVICE).not.toMatch(/trust[-_]center[-_]v2/);
        expect(ROUTES).not.toMatch(/trust[-_]center[-_]v2/);
        expect(TRUST_PAGE).not.toMatch(/trust[-_]center[-_]v2/);
        expect(REDIRECT_LANDING).not.toMatch(/trust[-_]center[-_]v2/);
        expect(STATUS_PAGE).not.toMatch(/trust[-_]center[-_]v2/);
        expect(METHODOLOGY_PAGE).not.toMatch(/trust[-_]center[-_]v2/);
        expect(SECTION_LIST).not.toMatch(/trust[-_]center[-_]v2/);
    });
    it("no /v1/trust/.../v2 endpoint registered", () => {
        expect(ROUTES).not.toMatch(/\/v1\/trust\/[a-z0-9/_:-]*v2/i);
    });
});
// ===========================================================================
// (15) No new Trust routes — canonical whitelist enforced
// ===========================================================================
describe("(15) /v1/trust/* surface matches the canonical whitelist", () => {
    it("every /v1/trust path in routes is in the canonical whitelist", () => {
        // Canonical whitelist mirrors production-trust-center-empty-state.test.ts
        // line 232-254 (the existing 18-route surface) — no entries
        // added by the enterprise-completion streams.
        const canonical = new Set([
            "/v1/trust/articles",
            "/v1/trust/articles/:kind/:slug",
            "/v1/trust/articles/:id/versions",
            "/v1/trust/articles/seed",
            "/v1/trust/articles/:id/review",
            "/v1/trust/subprocessors",
            "/v1/trust/subprocessors/:id/versions",
            "/v1/trust/subprocessors/seed",
            "/v1/trust/status",
            "/v1/trust/status/incidents",
            "/v1/trust/status/incidents/:id/updates",
            "/v1/trust/status/maintenance",
            "/v1/trust/drift/scan",
            "/v1/trust/drift/stale",
            "/v1/trust/security-claims/scan",
            "/v1/trust/security-claims",
            "/v1/trust/verify-references",
            "/v1/trust/verification-package/preview",
        ]);
        const found = ROUTES.match(/"\/v1\/trust\/[a-z0-9/:_-]+"/gi) ?? [];
        const stripped = Array.from(new Set(found.map((s) => s.slice(1, -1))));
        for (const p of stripped) {
            expect(canonical, `unknown /v1/trust endpoint introduced: ${p}`).toContain(p);
        }
    });
});
// ===========================================================================
// (16) No fake certification claims — bounded vocabulary across service
// ===========================================================================
describe("(16) No fake certification claims in trust-center.service.ts", () => {
    it('no "audited by" claim', () => {
        expect(TRUST_SERVICE).not.toMatch(/audited\s+by/i);
    });
    it("no SOC / ISO / FedRAMP / PCI-DSS / HIPAA assertions (already pinned in (8))", () => {
        expect(TRUST_SERVICE).not.toMatch(/\bSOC\s*[12]\b/i);
        expect(TRUST_SERVICE).not.toMatch(/\bISO\s*2700[0-9]\b/i);
        expect(TRUST_SERVICE).not.toMatch(/\bFedRAMP\b/i);
        expect(TRUST_SERVICE).not.toMatch(/\bHIPAA\b/i);
    });
});
// ===========================================================================
// (17) No raw stack traces / internal errors in client-rendered strings
// ===========================================================================
describe("(17) No raw stack traces / env names in Trust pages", () => {
    it("landing page does not surface .stack or process.env.", () => {
        expect(TRUST_PAGE).not.toMatch(/\.stack\b/);
        expect(TRUST_PAGE).not.toMatch(/process\.env\./);
        expect(REDIRECT_LANDING).not.toMatch(/\.stack\b/);
        expect(REDIRECT_LANDING).not.toMatch(/process\.env\./);
    });
    it("status page does not surface .stack or process.env.", () => {
        expect(STATUS_PAGE).not.toMatch(/\.stack\b/);
        expect(STATUS_PAGE).not.toMatch(/process\.env\./);
    });
    it("section list (used by methodology/ai-disclosure/security) does not surface .stack or process.env.", () => {
        expect(SECTION_LIST).not.toMatch(/\.stack\b/);
        expect(SECTION_LIST).not.toMatch(/process\.env\./);
    });
    it("methodology page does not surface .stack or process.env.", () => {
        expect(METHODOLOGY_PAGE).not.toMatch(/\.stack\b/);
        expect(METHODOLOGY_PAGE).not.toMatch(/process\.env\./);
    });
    it("subprocessors page does not surface .stack or process.env.", () => {
        expect(SUBPROCESSORS_PAGE).not.toMatch(/\.stack\b/);
        expect(SUBPROCESSORS_PAGE).not.toMatch(/process\.env\./);
    });
});
// ===========================================================================
// (18) All Trust pages have distinct loading / error / empty / loaded branches
// ===========================================================================
describe("(18) Trust pages render distinct branches per load state", () => {
    it("status page uses a 4-phase LoadState union", () => {
        expect(STATUS_PAGE).toMatch(/type\s+LoadState\b/);
        expect(STATUS_PAGE).toMatch(/phase:\s*"loading"/);
        expect(STATUS_PAGE).toMatch(/phase:\s*"loaded"/);
        expect(STATUS_PAGE).toMatch(/phase:\s*"empty"/);
        expect(STATUS_PAGE).toMatch(/phase:\s*"error"/);
    });
    it("shared section list (methodology / ai-disclosure / security) uses a 4-phase LoadState union", () => {
        // The 3 sub-pages methodology / ai-disclosure / security all
        // render via TrustCenterSectionList from _section-list.tsx. Pin
        // the union + the per-phase DOM markers there.
        expect(SECTION_LIST).toMatch(/type\s+LoadState\b/);
        expect(SECTION_LIST).toMatch(/phase:\s*"loading"/);
        expect(SECTION_LIST).toMatch(/phase:\s*"loaded"/);
        expect(SECTION_LIST).toMatch(/phase:\s*"empty"/);
        expect(SECTION_LIST).toMatch(/phase:\s*"error"/);
        expect(SECTION_LIST).toMatch(/data-trust-center-page-phase="loading"/);
        expect(SECTION_LIST).toMatch(/data-trust-center-page-phase="error"/);
        expect(SECTION_LIST).toMatch(/data-trust-center-page-phase="empty"/);
    });
    it("ai-disclosure + security sub-pages route through the shared TrustCenterSectionList", () => {
        expect(AI_DISCLOSURE_PAGE).toMatch(/TrustCenterSectionList/);
        expect(SECURITY_PAGE).toMatch(/TrustCenterSectionList/);
    });
    it("canonical /trust renders a real card grid and /trust-center redirects there", () => {
        expect(TRUST_PAGE).toMatch(/data-trust-section="cards"/);
        expect(TRUST_PAGE).toMatch(/data-trust-card/);
        expect(REDIRECT_LANDING).toMatch(/redirect\("\/trust"\)/);
    });
});
// ===========================================================================
// BOUNDED GUARD (19) — Migration file exists + allowlisted
// ===========================================================================
describe("(19) Sentry-batch repair migration is present + allowlisted", () => {
    it("migration.sql exists at the canonical path", () => {
        expect(existsRepo("services/api/prisma/migrations/20270802000000_phase_sentry_batch_schema_drift_repair/migration.sql")).toBe(true);
    });
    it("migration is listed in PERMITTED_LATER_MIGRATIONS allowlist", () => {
        expect(ALLOWLIST_GUARD).toMatch(/PERMITTED_LATER_MIGRATIONS/);
        expect(ALLOWLIST_GUARD).toMatch(/"20270802000000_phase_sentry_batch_schema_drift_repair"/);
    });
});
// ===========================================================================
// BOUNDED GUARD (20) — Canonical /trust page exposes the enterprise card grid
// ===========================================================================
describe("(20) Canonical /trust page exposes the enterprise card grid", () => {
    it("/trust stays wrapped in the canonical PageRouteGate", () => {
        expect(TRUST_PAGE).toMatch(/PageRouteGate\s+routeId="workspace\.trust"/);
    });
    it("/trust renders a non-empty set of trust cards", () => {
        const cards = TRUST_PAGE.match(/title:\s*"/g) ?? [];
        expect(cards.length).toBeGreaterThanOrEqual(12);
    });
    it("/trust includes the required enterprise-facing disclosures and operator links", () => {
        expect(TRUST_PAGE).toMatch(/title:\s*"AI transparency"/);
        expect(TRUST_PAGE).toMatch(/title:\s*"Security documentation"/);
        expect(TRUST_PAGE).toMatch(/title:\s*"Subprocessors"/);
        expect(TRUST_PAGE).toMatch(/title:\s*"C2PA readiness and limitations"/);
        expect(TRUST_PAGE).toMatch(/title:\s*"Recovery validation"/);
        expect(TRUST_PAGE).toMatch(/href:\s*"\/trust-center\/ai-disclosure"/);
        expect(TRUST_PAGE).toMatch(/href:\s*"\/trust-center\/security"/);
        expect(TRUST_PAGE).toMatch(/href:\s*"\/operations\/c2pa"/);
    });
});
// ===========================================================================
// BOUNDED GUARD (21) — AI_LEGAL_DISCLAIMER imported, not copy-pasted
// ===========================================================================
describe("(21) AI_LEGAL_DISCLAIMER is imported at the top of trust-center.service.ts", () => {
    it("import sits in the top-of-file import block (before SEED_ARTICLES)", () => {
        const importIdx = TRUST_SERVICE.search(/import\s*\{[^}]*AI_LEGAL_DISCLAIMER[^}]*\}\s*from/);
        const seedIdx = TRUST_SERVICE.indexOf("SEED_ARTICLES");
        expect(importIdx).toBeGreaterThan(-1);
        expect(seedIdx).toBeGreaterThan(-1);
        expect(importIdx).toBeLessThan(seedIdx);
    });
});
// ===========================================================================
// BOUNDED GUARD (22) — encryption body has no forbidden overclaim phrases
// ===========================================================================
describe('(22) encryption article body does not assert "Per-tenant KMS" as an active control', () => {
    it('the legacy phrase "Per-tenant KMS keys" is gone', () => {
        expect(TRUST_SERVICE).not.toMatch(/Per-tenant\s+KMS\s+keys/);
    });
    it('any remaining "Per-tenant KMS" reference is bounded by a "does not" disclaimer', () => {
        // Belt-and-braces: if a future edit re-introduces the phrase, it
        // must be inside a disclaimer. We assert there is either zero
        // occurrence OR every occurrence is preceded (within 100 chars)
        // by "does not" / "not currently".
        let i = 0;
        while (true) {
            const at = TRUST_SERVICE.toLowerCase().indexOf("per-tenant kms", i);
            if (at < 0)
                break;
            const pre = TRUST_SERVICE.slice(Math.max(0, at - 100), at);
            expect(pre).toMatch(/(does not|not currently|never)/i);
            i = at + 1;
        }
    });
});
// ===========================================================================
// BOUNDED GUARD (23) — mfa body does not assert IdP-delegated MFA
// ===========================================================================
describe('(23) mfa article body does not assert "via existing identity provider"', () => {
    it("the legacy phrase is gone", () => {
        expect(TRUST_SERVICE).not.toMatch(/via\s+(?:the\s+)?existing\s+identity\s+provider/i);
    });
    it("the new MFA rewrite cites the in-house RFC 6238 TOTP implementation", () => {
        // Positive pin so the slug doesn't silently regress to the empty
        // body. The rewrite explicitly cites the implementation file.
        expect(TRUST_SERVICE).toMatch(/RFC\s*6238/);
        expect(TRUST_SERVICE).toMatch(/mfa-totp\.ts/);
    });
});
