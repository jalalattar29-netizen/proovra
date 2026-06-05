/**
 * Phase R — Workflow canonicalization regression pins.
 *
 * Phase 0 audit confirmed that seven Phase-22 statuses were advertised
 * by the type system / UI but had ZERO producers:
 *
 *   - REPORT_READY
 *   - PACKAGE_READY
 *   - SHARED_EXTERNALLY
 *   - LEGAL_HOLD
 *   - ARCHIVED
 *   - RETAINED
 *   - ACTIVE
 *
 * Phase R retired them from the canonical enum. The contract is now:
 *
 *   DRAFT, SUBMITTED, NEEDS_REVIEW, CHANGES_REQUESTED, APPROVED,
 *   CANCELLED
 *
 * with the transition allow-list
 *
 *   DRAFT             → SUBMITTED, CANCELLED
 *   SUBMITTED         → NEEDS_REVIEW, CHANGES_REQUESTED, CANCELLED
 *   NEEDS_REVIEW      → APPROVED, CHANGES_REQUESTED, CANCELLED
 *   CHANGES_REQUESTED → SUBMITTED, CANCELLED
 *   APPROVED          → (terminal)
 *   CANCELLED         → (terminal)
 *
 * These regression pins forbid re-adding the dead statuses to the
 * canonical enum, the transition allow-list, the engine service text,
 * or the workflow UI source. A re-add would be a code change that
 * fails this test loudly rather than silently re-introducing dead
 * advertised capability.
 */

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_INSTANCE_STATUSES,
  isAllowedWorkflowInstanceTransition,
  isTerminalWorkflowInstanceStatus,
  listAllowedWorkflowInstanceTransitions,
} from "@proovra/shared";

const DEAD_STATUSES = [
  "REPORT_READY",
  "PACKAGE_READY",
  "SHARED_EXTERNALLY",
  "LEGAL_HOLD",
  "ARCHIVED",
  "RETAINED",
  "ACTIVE",
] as const;

const CANONICAL_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "NEEDS_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
  "CANCELLED",
] as const;

// -----------------------------------------------------------------------------
// Canonical enum pins
// -----------------------------------------------------------------------------

describe("Phase R — canonical WORKFLOW_INSTANCE_STATUSES enum", () => {
  it("contains exactly the six canonical statuses", () => {
    expect([...WORKFLOW_INSTANCE_STATUSES].sort()).toEqual(
      [...CANONICAL_STATUSES].sort(),
    );
  });

  it("does NOT contain any of the seven retired statuses", () => {
    for (const dead of DEAD_STATUSES) {
      expect(
        (WORKFLOW_INSTANCE_STATUSES as readonly string[]).includes(dead),
        `${dead} must not appear in WORKFLOW_INSTANCE_STATUSES`,
      ).toBe(false);
    }
  });

  it("DRAFT is no longer the only starting state — it transitions directly to SUBMITTED", () => {
    expect(isAllowedWorkflowInstanceTransition("DRAFT", "SUBMITTED")).toBe(true);
  });

  it("APPROVED and CANCELLED are terminal", () => {
    expect(isTerminalWorkflowInstanceStatus("APPROVED")).toBe(true);
    expect(isTerminalWorkflowInstanceStatus("CANCELLED")).toBe(true);
    expect(listAllowedWorkflowInstanceTransitions("APPROVED")).toEqual([]);
    expect(listAllowedWorkflowInstanceTransitions("CANCELLED")).toEqual([]);
  });

  it("transition allow-list never lists a dead status as a target", () => {
    for (const from of WORKFLOW_INSTANCE_STATUSES) {
      const allowed = listAllowedWorkflowInstanceTransitions(from);
      for (const target of allowed) {
        expect(
          (DEAD_STATUSES as readonly string[]).includes(target),
          `${from} → ${target} re-introduces a retired status`,
        ).toBe(false);
      }
    }
  });
});

// -----------------------------------------------------------------------------
// Source-text guards — engine service
// -----------------------------------------------------------------------------

describe("Phase R — engine service text never writes dead statuses", () => {
  it("evidence-workflow-engine.service.ts contains no transition handler for dead statuses", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/workflows/evidence-workflow-engine.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // The engine must not branch on `input.targetStatus === "<DEAD>"`
    // — that would mean a producer can still emit it.
    for (const dead of [
      "REPORT_READY",
      "PACKAGE_READY",
      "SHARED_EXTERNALLY",
      "ARCHIVED",
      "RETAINED",
    ]) {
      const re = new RegExp(
        `input\\.targetStatus\\s*===\\s*"${dead}"`,
      );
      expect(src, `engine still branches on input.targetStatus === ${dead}`).not.toMatch(re);
    }
    // ACTIVE / LEGAL_HOLD must not be written as a `status:` literal in
    // any updateData / create-data fixture. The legacy preHoldStatus
    // write path is gone.
    expect(src, "engine must not write preHoldStatus = from").not.toMatch(
      /updateData\.preHoldStatus\s*=\s*from/,
    );
  });
});

// -----------------------------------------------------------------------------
// Source-text guards — web UI
// -----------------------------------------------------------------------------

describe("Phase R — workflow UI never re-introduces dead statuses", () => {
  it("workflows list page redeclares no local InstanceStatus union with dead members", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/workflows/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Phase B reframed this surface as the Workflow Templates Center,
    // which no longer renders instance statuses at all (the misleading
    // Summary tiles + Instances list were removed because Phase 0
    // confirmed they had zero producers in this workspace). The
    // canonical-enum import requirement therefore no longer applies
    // here — but the "no dead status quoted literal" pin still does,
    // so a future regression cannot smuggle one back in via a chip /
    // badge / type union.
    for (const dead of DEAD_STATUSES) {
      const quoted = new RegExp(`"${dead}"`);
      expect(src, `workflows page still references "${dead}"`).not.toMatch(quoted);
    }
  });

  it("workflow detail page redeclares no local InstanceStatus union with dead members", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/workflows/[id]/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/from\s+["']@proovra\/shared["']/);
    for (const dead of DEAD_STATUSES) {
      const quoted = new RegExp(`"${dead}"`);
      expect(src, `workflow detail page still references "${dead}"`).not.toMatch(quoted);
    }
  });

  it("workflow detail page surfaces the Phase C deprecation banner", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/workflows/[id]/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Phase C — the small "Deprecated surface" inline notice has been
    // replaced by a prominent banner with title + body + CTA. The
    // banner data-testid hook + the canonical Phase C copy ("This
    // workflow detail view is being retired." + Reviewer Operations
    // direction + the CTA target) are the regression-pin surface.
    expect(src).toMatch(/workflow-instance-deprecation-banner/);
    expect(src).toMatch(
      /This workflow detail view is being retired\./,
    );
    expect(src).toMatch(
      /Reviewer workflow execution has moved to Reviewer Operations/,
    );
    // CTA target — link to the reviewer console. The /reviewer-ops
    // index redirects to /review, so /review is the canonical href.
    expect(src).toMatch(/href="\/review"/);
    expect(src).toMatch(/workflow-instance-deprecation-banner-cta/);
  });

  it("workflow detail page no longer renders the retired Phase 22 action buttons", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/workflows/[id]/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Phase C — the Submit / Approve / Request changes / Assign
    // reviewer / Cancel mutation buttons have been removed from this
    // page. They are owned by Reviewer Operations. Match button-shaped
    // JSX (>Label<) to avoid colliding with the comment block that
    // documents the removal.
    expect(src).not.toMatch(/>\s*Submit\s*</);
    expect(src).not.toMatch(/>\s*Approve\s*</);
    expect(src).not.toMatch(/>\s*Request changes\s*</);
    expect(src).not.toMatch(/>\s*Assign reviewer\s*</);
    expect(src).not.toMatch(/>\s*Cancel\s*</);
    // The underlying performAction targets must also be gone — no
    // residual handler that still POSTs the retired routes.
    expect(src).not.toMatch(/"\/submit"/);
    expect(src).not.toMatch(/"\/approve"/);
    expect(src).not.toMatch(/"\/request-changes"/);
    expect(src).not.toMatch(/"\/assign-reviewer"/);
    expect(src).not.toMatch(/"\/cancel"/);
  });

  it("workflow detail page keeps step waive behind a legacy-controls toggle", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/workflows/[id]/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // The legacy-controls toggle exists and defaults to false.
    expect(src).toMatch(/showLegacyStepControls/);
    expect(src).toMatch(/useState\(false\)/);
    // The Waive button block is rendered only when the toggle is on:
    // we pin the predicate ordering by asserting the `&&` chain begins
    // with `showLegacyStepControls`, AND that the Waive button text is
    // present in the file (the source-text guarantee that the toggle
    // gates a real surface, not a comment).
    expect(src).toMatch(
      /showLegacyStepControls\s*&&[\s\S]{0,1000}>\s*Waive\s*</,
    );
  });
});

// -----------------------------------------------------------------------------
// Phase C — server-side route file deprecation header
// -----------------------------------------------------------------------------

describe("Phase C — workflow-instances.routes.ts is marked DEPRECATED", () => {
  it("carries the Phase R deprecation note at the top of the file", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/routes/workflow-instances.routes.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // The header comment must declare the deprecation and direct
    // future work to EvidenceReviewWorkflow / reviewer-ops. We match
    // a window from the start of the file to ensure the note is in
    // the file-level docblock (not buried below an export).
    const head = src.slice(0, 1500);
    expect(head).toMatch(/DEPRECATED in Phase R/);
    expect(head).toMatch(/EvidenceReviewWorkflow/);
    expect(head).toMatch(/reviewer-ops/);
    expect(head).toMatch(/in-flight Phase 22 instances/);
  });
});

// -----------------------------------------------------------------------------
// Phase E — dead-artifact sweep guards
// -----------------------------------------------------------------------------

describe("Phase E — dead workflow status literals do NOT reappear in workflows UI or shared module", () => {
  it("apps/web/app/(app)/workflows/* contains no dead status literals", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");

    const workflowsRootUrl = new URL(
      "../../../apps/web/app/(app)/workflows/",
      import.meta.url,
    );
    const workflowsRoot = fileURLToPath(workflowsRootUrl);

    async function walk(dir: string): Promise<string[]> {
      const out: string[] = [];
      const entries = await readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          out.push(...(await walk(full)));
        } else if (
          ent.isFile() &&
          (ent.name.endsWith(".ts") ||
            ent.name.endsWith(".tsx") ||
            ent.name.endsWith(".js") ||
            ent.name.endsWith(".jsx"))
        ) {
          out.push(full);
        }
      }
      return out;
    }

    // Phase E grep guard — these six substrings must NOT reappear as
    // status-literal-shaped tokens anywhere under apps/web/app/(app)/
    // workflows. The dead status canonicalization removed all of them
    // from this surface; the documentation comment block in the
    // workflows pages quotes them as REMOVED, but the case-sensitive
    // double-quoted-literal form (e.g. "REPORT_READY") is forbidden.
    const FORBIDDEN_SUBSTRINGS = [
      'REPORT_READY',
      'PACKAGE_READY',
      'SHARED_EXTERNALLY',
      'LEGAL_HOLD',
      'ARCHIVED',
      'RETAINED',
    ] as const;

    const files = await walk(workflowsRoot);
    expect(
      files.length,
      "workflows directory must contain TS/TSX source files",
    ).toBeGreaterThan(0);

    // We tolerate the substrings inside JS doc comment blocks (the
    // pages document the removal intentionally — e.g. the
    // /workflows/[id] page top comment quotes "REPORT_READY /
    // PACKAGE_READY / SHARED_EXTERNALLY / LEGAL_HOLD / ARCHIVED /
    // RETAINED / ACTIVE") had no producer..." but we forbid them as
    // string literals (double-quoted) and as type-union members
    // (`| "ARCHIVED"`). The grep guard checks the case-sensitive
    // double-quoted form only, since that is what would resurrect the
    // contract.
    //
    // The workflow detail page (page.tsx) renders the API-projected
    // template `archived` boolean as "Archived" UI text, but never
    // quotes the string "ARCHIVED" — the regex below only matches
    // ALL-CAPS double-quoted occurrences.
    for (const file of files) {
      const src = await readFile(file, "utf8");
      const relPath = path.relative(workflowsRoot, file);
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        const quoted = new RegExp(`"${forbidden}"`);
        expect(
          src,
          `apps/web/app/(app)/workflows/${relPath} re-introduces forbidden literal "${forbidden}"`,
        ).not.toMatch(quoted);
      }
    }
  });

  it("packages/shared/src/workflow-instance.ts contains no dead status literals outside comments", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../packages/shared/src/workflow-instance.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    // Strip both single-line (//) and block (/* ... */) comments so the
    // documentation block at the top of the file (which intentionally
    // names the retired statuses) does not produce a false positive.
    // The pin is: outside comments, these literal strings must not
    // appear at all.
    const codeOnly = src
      // remove block comments first (greedy across lines)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // then remove line comments
      .replace(/\/\/[^\n]*/g, "");

    const FORBIDDEN_SUBSTRINGS = [
      "REPORT_READY",
      "PACKAGE_READY",
      "SHARED_EXTERNALLY",
      "LEGAL_HOLD",
      "ARCHIVED",
      "RETAINED",
    ] as const;

    // WORKFLOW_TEMPLATE_STATUSES is the template-status enum (DRAFT /
    // ACTIVE / ARCHIVED) which is unrelated to the retired Phase 22
    // workflow-instance statuses — the template-status enum is
    // legitimate. We only forbid the dead instance-status literals
    // in the workflow-INSTANCE-related identifiers. To make this
    // tractable as a source-text guard, we slice the file from
    // `WORKFLOW_INSTANCE_STATUSES` to `WORKFLOW_STEP_INSTANCE_STATUSES`
    // (the canonical instance-status section) and assert no forbidden
    // status appears in that window. ARCHIVED appearing in the
    // template-status section is allowed.
    const instStart = codeOnly.indexOf("WORKFLOW_INSTANCE_STATUSES");
    expect(
      instStart,
      "workflow-instance.ts must declare WORKFLOW_INSTANCE_STATUSES",
    ).toBeGreaterThan(-1);
    const instEnd = codeOnly.indexOf(
      "WORKFLOW_STEP_INSTANCE_STATUSES",
      instStart,
    );
    expect(
      instEnd,
      "workflow-instance.ts must declare WORKFLOW_STEP_INSTANCE_STATUSES",
    ).toBeGreaterThan(instStart);
    const instanceSection = codeOnly.slice(instStart, instEnd);

    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(
        instanceSection,
        `workflow-instance.ts instance-status section re-introduces "${forbidden}"`,
      ).not.toMatch(new RegExp(`"${forbidden}"`));
    }
  });

  it("apps/web/components/ui/StatusBadge.tsx no longer maps the dead workflow statuses", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/components/ui/StatusBadge.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    // Strip comments — the documentation block names the retired
    // statuses on purpose. The pin is that no MAP ENTRY (a literal
    // `KEY: "tone"` line) for the workflow-exclusive dead statuses
    // remains.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    // These five dead workflow statuses had bespoke tone mappings
    // before Phase E. Removing them is the canonicalization. They
    // must not be re-added as code-level map entries.
    for (const dead of [
      "REPORT_READY",
      "PACKAGE_READY",
      "SHARED_EXTERNALLY",
      "LEGAL_HOLD",
      "RETAINED",
    ]) {
      expect(
        codeOnly,
        `StatusBadge.tsx still has a tone entry for retired ${dead}`,
      ).not.toMatch(new RegExp(`${dead}\\s*:\\s*"[a-z]+"`));
    }

    // ACTIVE and ARCHIVED entries are kept (they serve retention
    // policy + governance), but the workflow-exclusive dead five must
    // not appear as literal strings anywhere in the code-only
    // (comment-stripped) source.
    for (const dead of ["REPORT_READY", "PACKAGE_READY", "SHARED_EXTERNALLY", "RETAINED"]) {
      expect(
        codeOnly,
        `StatusBadge.tsx still references "${dead}" outside comments`,
      ).not.toMatch(new RegExp(`"${dead}"`));
    }
  });
});

// -----------------------------------------------------------------------------
// Phase E — source-text pins for the workflows page surface
// -----------------------------------------------------------------------------

describe("Phase E — /workflows surface does not call the dead instances route", () => {
  it("/workflows page does not import or call /v1/workflows/instances", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/workflows/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Phase B reframed /workflows as the Workflow Templates Center. It
    // must NOT touch the instances surface — that traffic now belongs
    // to Reviewer Operations. We pin BOTH the absence of any apiFetch
    // call against `/v1/workflows/instances` AND the absence of a raw
    // literal string referencing that path.
    expect(src).not.toMatch(/\/v1\/workflows\/instances/);
    // Verify the /workflows page still uses the templates surface as
    // its sole API call (regression pin — confirms the page is wired
    // to templates, not to a future "instances" rename).
    expect(src).toMatch(/\/v1\/workflows\/templates/);
  });
});

describe("Phase E — /workflows/[id] page carries the deprecation banner", () => {
  it("contains the Phase C deprecation banner copy and testid", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/workflows/[id]/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Source-text pin: deprecation banner is present (testid + the
    // canonical Phase C copy + the reviewer-ops link target).
    expect(src).toMatch(/workflow-instance-deprecation-banner/);
    expect(src).toMatch(
      /This workflow detail view is being retired\./,
    );
    expect(src).toMatch(
      /Reviewer workflow execution has moved to Reviewer Operations/,
    );
    expect(src).toMatch(/href="\/review"/);
  });
});

// -----------------------------------------------------------------------------
// Phase C — navigation registry no longer surfaces /workflows under
// operations / capture
// -----------------------------------------------------------------------------

describe("Phase C — navigation registry repositions workspace.workflows", () => {
  it("routeRegistry relabels workspace.workflows to 'Workflow Templates' and gates on INTEGRATIONS_MANAGE", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/lib/navigation/routeRegistry.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Locate the workspace.workflows block and inspect its label /
    // capabilities. The Phase C pin: label is "Workflow Templates"
    // (not the misleading "Workflows" operations framing) and the
    // required capability is INTEGRATIONS_MANAGE (workspace
    // administration), not EVIDENCE_VIEW.
    const block = src.match(
      /id:\s*"workspace\.workflows"[\s\S]*?sidebarEligible:\s*(?:true|false)\s*,/,
    );
    expect(block, "workspace.workflows route definition is present").not.toBeNull();
    const text = block?.[0] ?? "";
    expect(text).toMatch(/label:\s*"Workflow Templates"/);
    expect(text).toMatch(/requiredCapabilities:\s*\["INTEGRATIONS_MANAGE"\]/);
    // The old "EVIDENCE_VIEW" gate (which made this surface read-only
    // visible to every reviewer) must not still be wired.
    expect(text).not.toMatch(/requiredCapabilities:\s*\["EVIDENCE_VIEW"\]/);
    // Workflow tags must NOT advertise REVIEW_OPERATIONS / LEGAL_CASEWORK
    // anymore — that framing is what made Phase B's misleading
    // "operations" surface promote into reviewer workflows. Templates
    // are an administration surface.
    expect(text).toMatch(/workflowTags:\s*\["OPERATIONAL_ADMINISTRATION"\]/);
    expect(text).not.toMatch(/"REVIEW_OPERATIONS"/);
    expect(text).not.toMatch(/"LEGAL_CASEWORK"/);
  });

  it("phaseBOperationalGroups no longer lists workspace.workflows under WORKSPACE", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/lib/navigation/phaseBOperationalGroups.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Slice the WORKSPACE group block (id: "WORKSPACE", up to the
    // start of the next group entry) and assert workspace.workflows
    // is absent.
    const wsStart = src.indexOf('id: "WORKSPACE"');
    expect(wsStart).toBeGreaterThan(-1);
    const wsEnd = src.indexOf('id: "GOVERNANCE"', wsStart);
    const workspaceBlock = src.slice(wsStart, wsEnd);
    expect(workspaceBlock).not.toMatch(/"workspace\.workflows"/);

    // And it must appear in the SYSTEM block (Administration cluster).
    const sysStart = src.indexOf('id: "SYSTEM"');
    expect(sysStart).toBeGreaterThan(-1);
    const sysEnd = src.indexOf("];", sysStart);
    const systemBlock = src.slice(sysStart, sysEnd);
    expect(systemBlock).toMatch(/"workspace\.workflows"/);
  });

  it("pillarRegistry routes workspace.workflows to ADMIN, not CAPTURE", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/lib/navigation/pillarRegistry.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Exactly one mapping for workspace.workflows should be active —
    // ["workspace.workflows", "ADMIN"]. The previous
    // ["workspace.workflows", "CAPTURE"] entry must be gone.
    expect(src).toMatch(/\["workspace\.workflows",\s*"ADMIN"\]/);
    expect(src).not.toMatch(/\["workspace\.workflows",\s*"CAPTURE"\]/);
  });
});
