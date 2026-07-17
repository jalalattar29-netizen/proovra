/**
 * Cross-family lifecycle invariants (lifecycle Phase 8, 2026-07-17).
 *
 * Pins the rules that must hold ACROSS all five capability families
 * (login methods, activity, data export, account closure, org/workspace
 * lifecycle) — the per-family contracts live in their own test files.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");
const STEP_UP = read(
  "../src/services/identity-security/account-step-up.service.ts",
);
const SCHEDULER = read("../src/services/notifications/digest-scheduler.ts");
const ACCOUNT_CLOSURE = read(
  "../src/services/identity/account-closure.service.ts",
);
const ORG_CLOSURE = read("../src/services/organization/org-closure.service.ts");
const WS_CLOSURE = read(
  "../src/services/workspace/workspace-closure.service.ts",
);
const PREFLIGHT = read(
  "../src/services/identity/account-lifecycle-preflight.service.ts",
);
const IDENTITY_LINKS = read("../src/routes/identity-links.routes.ts");
const DATA_EXPORT = read("../src/routes/account-data-export.routes.ts");
const ACCOUNT_CLOSURE_ROUTES = read("../src/routes/account-closure.routes.ts");
const ORG_ROUTES = read("../src/routes/organizations.routes.ts");
const TEAM_ROUTES = read("../src/routes/teams.routes.ts");
const LABELS = readFileSync(
  resolve(HERE, "../../../apps/web/lib/security/securityEventLabels.ts"),
  "utf8",
);

describe("one canonical step-up union covers every sensitive lifecycle action", () => {
  it("all lifecycle actions are registered in AccountStepUpAction", () => {
    for (const action of [
      "login_method_link",
      "login_method_unlink",
      "password_add",
      "data_export_request",
      "data_export_download",
      "account_closure_request",
      "org_ownership_transfer",
      "org_closure_request",
      "workspace_closure_request",
    ]) {
      expect(STEP_UP).toMatch(new RegExp(`"${action}"`));
    }
  });

  it("every lifecycle route verifies through verifyAccountStepUp (no parallel verifier)", () => {
    for (const src of [
      IDENTITY_LINKS,
      DATA_EXPORT,
      ACCOUNT_CLOSURE_ROUTES,
      ORG_ROUTES,
      TEAM_ROUTES,
    ]) {
      expect(src).toMatch(/verifyAccountStepUp\(/);
    }
  });
});

describe("one worker host: every async lifecycle processor rides the digest cron", () => {
  it("all four processors are wired, each in its own isolation guard", () => {
    expect(SCHEDULER).toMatch(/processAccountDataExports\(now\)/);
    expect(SCHEDULER).toMatch(/processAccountClosures\(now\)/);
    expect(SCHEDULER).toMatch(/processOrganizationClosures\(now\)/);
    expect(SCHEDULER).toMatch(/processWorkspaceClosures\(now\)/);
  });
});

describe("shared closure state-machine shape", () => {
  it("all three closure workers re-preflight then claim atomically", () => {
    for (const src of [ACCOUNT_CLOSURE, ORG_CLOSURE, WS_CLOSURE]) {
      expect(src).toMatch(/status:\s*"BLOCKED"/);
      expect(src).toMatch(/if \(claimed\.count === 0\) continue;/);
      expect(src).toMatch(/"COOLING_OFF"/);
      expect(src).toMatch(/CANCELLABLE_/);
    }
  });

  it("no closure path ever hard-deletes evidence", () => {
    for (const src of [ACCOUNT_CLOSURE, ORG_CLOSURE, WS_CLOSURE]) {
      expect(src).not.toMatch(/evidence\.delete/i);
    }
  });

  it("machine credentials never outlive their org/workspace", () => {
    for (const src of [ORG_CLOSURE, WS_CLOSURE]) {
      expect(src).toMatch(/apiCredential\.updateMany/);
      expect(src).toMatch(/webhookEndpoint\.updateMany/);
    }
  });
});

describe("universality: privacy-rights families are never plan-gated", () => {
  it("no plan/entitlement read exists in any account-tier lifecycle route", () => {
    for (const src of [IDENTITY_LINKS, DATA_EXPORT, ACCOUNT_CLOSURE_ROUTES]) {
      expect(src).not.toMatch(/getPlanCapabilities\(|prisma\.entitlement\b/);
    }
  });

  it("preflight blockers protect people and legal duties, never revenue", () => {
    expect(PREFLIGHT).not.toMatch(/getPlanCapabilities\(/);
  });
});

describe("typed confirmations are server-side phrases, never booleans", () => {
  it("each closure family pins its distinct phrase", () => {
    expect(ACCOUNT_CLOSURE_ROUTES).toMatch(/"close my account"/);
    expect(ORG_ROUTES).toMatch(/"close this organization"/);
    expect(TEAM_ROUTES).toMatch(/"close this workspace"/);
  });

  it("no closure route reads a `confirmed` boolean", () => {
    for (const src of [ACCOUNT_CLOSURE_ROUTES, ORG_ROUTES, TEAM_ROUTES]) {
      expect(src).not.toMatch(/confirmed\s*[:=]\s*true/);
    }
  });
});

describe("audit coverage: every lifecycle event has a curated human label", () => {
  it("web securityEventLabels covers all lifecycle identity.* actions", () => {
    for (const key of [
      "identity.login_method_linked",
      "identity.login_method_unlinked",
      "identity.password_added",
      "identity.organization_left",
      "identity.data_export_requested",
      "identity.data_export_ready",
      "identity.data_export_downloaded",
      "identity.account_closure_requested",
      "identity.account_closure_cancelled",
      "identity.account_closure_completed",
      "identity.organization_ownership_transferred",
      "identity.organization_closure_requested",
      "identity.organization_closure_completed",
      "identity.workspace_closure_requested",
      "identity.workspace_closure_completed",
    ]) {
      expect(LABELS).toMatch(new RegExp(`"${key.replace(/\./g, "\\.")}"`));
    }
  });
});
