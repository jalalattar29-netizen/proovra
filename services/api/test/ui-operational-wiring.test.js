/**
 * Phase 28-G — UI operational wiring source-contract tests.
 *
 * Proves the four new apps/web components consume the right
 * endpoints, fail closed on API failure, never expose forbidden
 * fields, and use bounded safe wording.
 *
 * Also asserts the proof-point wiring (reviewer-ops escalations page
 * now imports + renders the empty-state preset + runtime banner).
 *
 * Pure source-contract assertions. No DOM, no React renderer.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
// =============================================================================
// GovernanceSnapshotPanel
// =============================================================================
describe("GovernanceSnapshotPanel", () => {
    const src = readSource("../../../apps/web/components/operational/GovernanceSnapshotPanel.tsx");
    it("consumes the snapshot endpoint", () => {
        expect(src).toMatch(/\/v1\/evidence\/\$\{[^}]+\}\/governance-snapshot\?teamId=/);
    });
    it("fails closed on API error (renders GovernanceSnapshotUnavailableNotice)", () => {
        expect(src).toContain("GovernanceSnapshotUnavailableNotice");
        expect(src).toMatch(/error \|\| !snapshot/);
    });
    it("never invents 'allowed' state when snapshot is unknown", () => {
        // `eligibilityBadge(null)` must return "Unknown — treat as blocked".
        expect(src).toContain("Unknown — treat as blocked");
    });
    it("uses bounded safe wording for storage governance (no tamper / forged / altered)", () => {
        // Scope to STRING LITERALS only — comments may legitimately
        // reference the banned wording while documenting the rule.
        const stringLiterals = src.match(/"[^"\n]+"/g) ?? [];
        const all = stringLiterals.join(" ");
        expect(all).not.toMatch(/\btamper(ed|ing)?\b/i);
        expect(all).not.toMatch(/\bforged\b|\bforgery\b/i);
        expect(all).not.toMatch(/\baltered content\b/i);
    });
    it("never selects forbidden fields from the snapshot", () => {
        // The snapshot endpoint never returns these. We additionally
        // assert the component doesn't reference them by accident.
        for (const forbidden of [
            "internalNotes",
            "privateReviewerNote",
            "decisionNote",
            "signatureBase64",
            "publicKeyPem",
            "otsProofBase64",
            "storageKey",
        ]) {
            expect(src).not.toContain(forbidden);
        }
    });
    it("displays operator-readable warning labels from the snapshot, not codes alone", () => {
        expect(src).toContain("snapshot.warnings");
        expect(src).toMatch(/w\.label/);
    });
});
// =============================================================================
// OperationalTimelinePanel
// =============================================================================
describe("OperationalTimelinePanel", () => {
    const src = readSource("../../../apps/web/components/operational/OperationalTimelinePanel.tsx");
    it("consumes the operational-timeline endpoint", () => {
        expect(src).toMatch(/\/v1\/evidence\/\$\{[^}]+\}\/operational-timeline\?teamId=/);
    });
    it("fails closed when timeline API fails", () => {
        expect(src).toMatch(/data-timeline-state="unavailable"/);
        expect(src).toMatch(/failing closed/i);
    });
    it("uses the bounded empty-state preset when there are 0 entries", () => {
        expect(src).toContain("NoOperationalTimelineEmptyState");
    });
    it("does not render note bodies / private review content", () => {
        // No field that hints at private content is referenced.
        expect(src).not.toContain("privateReviewerNote");
        expect(src).not.toContain("decisionNote");
        expect(src).not.toMatch(/\bnote\.body\b/);
    });
    it("never invents events — every row from a real backend stream", () => {
        // The endpoint payload type defines `entries` from lifecycle /
        // review / incident. Phase 28-J groups entries by UTC date bucket,
        // so the iteration walks `timeline.entries` once to build buckets
        // and then `bucket.entries.map(...)` to render rows. Either pattern
        // proves the component does not fabricate events.
        expect(src).toMatch(/for\s*\(\s*const\s+entry\s+of\s+timeline\.entries/);
        expect(src).toContain("bucket.entries.map");
        expect(src).not.toMatch(/synthetic|fake|invented/i);
    });
});
// =============================================================================
// RuntimeStatusBanner
// =============================================================================
describe("RuntimeStatusBanner", () => {
    const src = readSource("../../../apps/web/components/operational/RuntimeStatusBanner.tsx");
    it("consumes /admin/runtime/readiness", () => {
        expect(src).toMatch(/\/admin\/runtime\/readiness\?teamId=/);
    });
    it("HEALTHY renders nothing (operational pages stay clean)", () => {
        expect(src).toMatch(/report\.status === "HEALTHY"[\s\S]*?return null/);
    });
    it("API failure renders UNKNOWN, never silently HEALTHY", () => {
        expect(src).toMatch(/data-runtime-status="UNKNOWN"/);
        expect(src).toMatch(/error/);
    });
    it("CRITICAL severity gets stronger styling than DEGRADED", () => {
        expect(src).toContain('role="alert"');
        expect(src).toMatch(/CRITICAL[\s\S]*?operational paths may fail/);
    });
    it("never exposes env values or secret content", () => {
        expect(src).not.toContain("process.env");
        expect(src).not.toMatch(/SECRET|TOKEN|API_KEY/);
    });
    it("polls on a bounded interval (default 60s, opt-out via pollMs=0)", () => {
        expect(src).toMatch(/pollMs\s*=\s*60_000/);
        expect(src).toMatch(/pollMs > 0/);
    });
});
// =============================================================================
// ExportPackageEligibilityBadge
// =============================================================================
describe("ExportPackageEligibilityBadge", () => {
    const src = readSource("../../../apps/web/components/operational/ExportPackageEligibilityBadge.tsx");
    it("consumes the snapshot endpoint", () => {
        expect(src).toMatch(/\/v1\/evidence\/\$\{[^}]+\}\/governance-snapshot/);
    });
    it("snapshot failure → UNKNOWN, callback eligible=false (fail-closed)", () => {
        expect(src).toMatch(/unknown:\s*true[\s\S]*?eligible:\s*false/);
        // The badge tells the operator the action is blocked.
        expect(src).toContain("Unknown — blocked");
    });
    it("loading state disables the action", () => {
        expect(src).toMatch(/loading:\s*true/);
        expect(src).toContain('data-eligibility-state=');
    });
    it("supports both export and package kinds", () => {
        expect(src).toMatch(/kind\s*===\s*"export"/);
        expect(src).toContain('"package"');
    });
    it("exposes a callback so parent disables the underlying button", () => {
        expect(src).toContain("onEligibilityChange");
        expect(src).toMatch(/onEligibilityChange\?\.\(\{/);
    });
    it("never claims the action is ready when state is unknown", () => {
        // Pill labels must use distinct vocabulary per state.
        expect(src).toMatch(/"Export allowed"|"Package allowed"/);
        expect(src).toMatch(/"Export blocked"|"Package blocked"/);
        expect(src).toContain('"Unknown — blocked"');
    });
});
// =============================================================================
// Barrel
// =============================================================================
describe("operational/index barrel", () => {
    const src = readSource("../../../apps/web/components/operational/index.ts");
    it("re-exports the four new panels", () => {
        expect(src).toContain("GovernanceSnapshotPanel");
        expect(src).toContain("OperationalTimelinePanel");
        expect(src).toContain("RuntimeStatusBanner");
        expect(src).toContain("ExportPackageEligibilityBadge");
    });
    it("re-exports every empty-state preset + variant", () => {
        expect(src).toContain("NoEscalationsEmptyState");
        expect(src).toContain("NoWorkloadSnapshotsEmptyState");
        expect(src).toContain("NoGovernanceIncidentsEmptyState");
        expect(src).toContain("NoSlaBreachesEmptyState");
        expect(src).toContain("NoOperationalTimelineEmptyState");
        expect(src).toContain("RuntimeDegradedNotice");
        expect(src).toContain("GovernanceSnapshotUnavailableNotice");
    });
    it("file-level comment documents the fail-closed contract", () => {
        expect(src).toMatch(/fail-closed/i);
        expect(src).toMatch(/UNKNOWN \/ DEGRADED state/i);
    });
});
// =============================================================================
// Proof-point wiring — reviewer-ops escalations page
// =============================================================================
describe("Escalations page (proof-point wiring)", () => {
    const src = readSource("../../../apps/web/app/(app)/reviewer-ops/escalations/page.tsx");
    it("imports the new empty-state preset + runtime banner from the operational barrel", () => {
        expect(src).toMatch(/import \{[\s\S]*?NoEscalationsEmptyState,[\s\S]*?RuntimeStatusBanner,[\s\S]*?\} from "[\.\/]+components\/operational"/);
    });
    it("renders NoEscalationsEmptyState when rows array is empty", () => {
        expect(src).toMatch(/rows\.length === 0[\s\S]*?NoEscalationsEmptyState/);
    });
    it("removed the old static 'No escalations match these filters' text", () => {
        expect(src).not.toContain("No escalations match these filters.");
    });
    it("renders the runtime banner above the main escalations table", () => {
        const bannerIdx = src.indexOf("RuntimeStatusBanner teamId");
        const sectionIdx = src.indexOf("<section style={{ ...cardStyle, marginTop: 16, padding: 0 }}>");
        expect(bannerIdx).toBeGreaterThan(0);
        expect(sectionIdx).toBeGreaterThan(0);
        expect(bannerIdx).toBeLessThan(sectionIdx);
    });
    it("only renders the banner when teamId is known (avoids null render)", () => {
        // Phase 32.7 — banner usage may now wrap the JSX in `(...)` to
        // accommodate the `forDomains` prop on a separate line. Both
        // shapes are valid.
        expect(src).toMatch(/teamId\s*\?\s*\(?\s*<RuntimeStatusBanner/);
    });
});
// =============================================================================
// Wording invariants across the operational component family
// =============================================================================
describe("Phase 28-G [wording invariants]", () => {
    const files = [
        "../../../apps/web/components/operational/GovernanceSnapshotPanel.tsx",
        "../../../apps/web/components/operational/OperationalTimelinePanel.tsx",
        "../../../apps/web/components/operational/RuntimeStatusBanner.tsx",
        "../../../apps/web/components/operational/ExportPackageEligibilityBadge.tsx",
        "../../../apps/web/components/operational/OperationalEmptyState.tsx",
    ];
    it("no file contains tamper / forged / altered-content in its visible string literals", () => {
        for (const file of files) {
            const src = readSource(file);
            const stringLiterals = src.match(/"[^"\n]+"/g) ?? [];
            const all = stringLiterals.join(" ");
            expect(all, `wording check failed in ${file}`).not.toMatch(/\btamper(ed|ing)?\b|\bforged\b|\baltered content\b/i);
        }
    });
    it("no file references env values directly in rendered text", () => {
        for (const file of files) {
            const src = readSource(file);
            // We allow process.env in client code only for non-secret
            // public env (NEXT_PUBLIC_*). We forbid it entirely in these
            // components since they should not surface env state.
            expect(src, `env reference in ${file}`).not.toContain("process.env");
        }
    });
    it("no fake counter / hardcoded operational number renders anywhere", () => {
        for (const file of files) {
            const src = readSource(file);
            // Hardcoded "count" / numeric badges would smell of fake data.
            // We don't ban all numerics (style values are fine); we ban
            // literal hardcoded count-shaped patterns.
            expect(src).not.toMatch(/escalations:\s*\d+,/);
            expect(src).not.toMatch(/overdue:\s*\d+,/);
            expect(src).not.toMatch(/incidents:\s*\d+,/);
        }
    });
});
