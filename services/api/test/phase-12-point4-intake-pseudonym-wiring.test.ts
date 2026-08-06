/**
 * PHASE 12 POINT 4 — Intake pseudonym: disconnected capability WIRED.
 *
 * BEFORE this pass, `openIntakeSession` accepted `pseudonym`,
 * `submitterDisplayName` and `submitterEmail`; the reviewer-side summary
 * projected them; and the ONLY public entry point was
 * `GET /v1/external-intake/:token`, which has no body and passed none of
 * them. Every EXTERNAL_PSEUDONYMOUS session therefore persisted a null
 * pseudonym while the workspace UI advertised the mode as "Display name —
 * contributor chooses a name shown with the submission".
 *
 * AFTER: `recordIntakeSubmitterIdentity` is the ONE writer of those three
 * columns, reached from a token-bound POST
 * (`/v1/external-intake/:token/sessions/:sid/identity`), and the public
 * intake page collects the display name for that mode.
 *
 * This suite proves the chain end to end at the layer each claim belongs to:
 * the service behaviour (mode policy, normalization, session binding), the
 * route wiring (POST, not a query string; token-bound; no PII echoed), and
 * the two client surfaces (public collection + reviewer projection).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  INTAKE_DISPLAY_NAME_MAX_LENGTH,
  INTAKE_EMAIL_MAX_LENGTH,
  INTAKE_PSEUDONYM_MAX_LENGTH,
  WorkflowIntakeSessionError,
  openIntakeSession,
  recordIntakeSubmitterIdentity,
} from "../src/services/workflow-intake-session.service.js";
import { buildSummary } from "../src/services/external-intake-source-summary.service.js";
import {
  asPrismaDouble,
  rec,
  type DelegateArgs,
} from "./support/prisma-double.js";

import type { PrismaClient } from "@prisma/client";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, "..", "src");
const WEB_APP = join(HERE, "..", "..", "..", "apps", "web", "app");

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

type LinkFixture = Parameters<typeof recordIntakeSubmitterIdentity>[0]["link"];

function fakeLink(intakeMode: string): LinkFixture {
  return {
    id: "link-1",
    teamId: "team-1",
    intakeMode,
    expiresAtUtc: new Date("2026-12-31T00:00:00Z"),
  } as unknown as LinkFixture;
}

/**
 * Minimal WorkflowIntakeSession delegate. `update` records the data it was
 * handed so the tests can assert exactly which columns the service wrote.
 */
function fakeDb(sessionOverrides: Record<string, unknown> = {}) {
  const session = {
    id: "session-1",
    intakeLinkId: "link-1",
    status: "OPENED",
    pseudonym: null,
    submitterDisplayName: null,
    submitterEmail: null,
    ...sessionOverrides,
  };
  const updates: Array<Record<string, unknown>> = [];
  const creates: Array<Record<string, unknown>> = [];
  const world = {
    workflowIntakeSession: {
      findUnique: vi.fn(async () => session),
      update: vi.fn(async ({ data }: DelegateArgs) => {
        updates.push(rec(data));
        return { ...session, ...rec(data) };
      }),
      create: vi.fn(async ({ data }: DelegateArgs) => {
        creates.push(rec(data));
        return { ...session, ...rec(data) };
      }),
    },
  };
  return {
    client: asPrismaDouble<PrismaClient>(world),
    updates,
    creates,
  };
}

async function expectRefusal(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(WorkflowIntakeSessionError);
  await promise.catch((err: unknown) => {
    expect((err as WorkflowIntakeSessionError).code).toBe(code);
  });
}

// -----------------------------------------------------------------------------
// 1. The session opener no longer accepts identity at all
// -----------------------------------------------------------------------------

describe("Intake pseudonym §1 — the opener is not an identity writer", () => {
  it("openIntakeSession always persists NULL identity columns", async () => {
    const { client, creates } = fakeDb();
    await openIntakeSession(
      {
        link: fakeLink("EXTERNAL_PSEUDONYMOUS"),
        submitterIp: "203.0.113.7",
        submitterUserAgent: "Mozilla/5.0",
      },
      client,
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]!.pseudonym).toBeNull();
    expect(creates[0]!.submitterDisplayName).toBeNull();
    expect(creates[0]!.submitterEmail).toBeNull();
  });

  it("its input type carries no identity field — a caller cannot pass one", () => {
    const src = readFileSync(
      join(API_SRC, "services", "workflow-intake-session.service.ts"),
      "utf8",
    );
    const typeStart = src.indexOf("export type OpenIntakeSessionInput");
    // The declaration body only — the doc comment that FOLLOWS it explains why
    // identity is not accepted here and legitimately names the columns.
    const openInput = src.slice(typeStart, src.indexOf("};", typeStart));
    expect(openInput).not.toMatch(/pseudonym/);
    expect(openInput).not.toMatch(/submitterDisplayName/);
    expect(openInput).not.toMatch(/submitterEmail/);
  });

  it("exactly ONE module writes the identity columns", () => {
    const src = readFileSync(
      join(API_SRC, "services", "workflow-intake-session.service.ts"),
      "utf8",
    );
    // The only place `pseudonym:` appears as a write is the opener's explicit
    // null and the recorder's `data` object.
    const writerFns = src
      .split("export async function ")
      .filter((chunk) => /pseudonym\s*[,:}]/.test(chunk))
      .map((chunk) => chunk.slice(0, chunk.indexOf("(")));
    expect(writerFns.sort()).toEqual(
      ["openIntakeSession", "recordIntakeSubmitterIdentity"].sort(),
    );
  });
});

// -----------------------------------------------------------------------------
// 2. Mode policy is server-side and fail-closed
// -----------------------------------------------------------------------------

describe("Intake pseudonym §2 — the link's mode decides what may be stored", () => {
  it("PSEUDONYMOUS stores the pseudonym and NOTHING else", async () => {
    const { client, updates } = fakeDb();
    await recordIntakeSubmitterIdentity(
      { sessionId: "session-1", link: fakeLink("EXTERNAL_PSEUDONYMOUS"), pseudonym: "concerned-source" },
      client,
    );
    expect(updates).toEqual([{ pseudonym: "concerned-source" }]);
  });

  it("PSEUDONYMOUS refuses a real name or email attached by a modified client", async () => {
    const { client, updates } = fakeDb();
    await expectRefusal(
      recordIntakeSubmitterIdentity(
        {
          sessionId: "session-1",
          link: fakeLink("EXTERNAL_PSEUDONYMOUS"),
          pseudonym: "source",
          submitterEmail: "jane@example.com",
        },
        client,
      ),
      "intake_mode_mismatch",
    );
    // Refused, not silently narrowed — no write happened at all.
    expect(updates).toEqual([]);
  });

  it("ANONYMOUS collects nothing — every field is refused", async () => {
    const { client, updates } = fakeDb();
    await expectRefusal(
      recordIntakeSubmitterIdentity(
        { sessionId: "session-1", link: fakeLink("EXTERNAL_ANONYMOUS"), pseudonym: "not-allowed" },
        client,
      ),
      "intake_mode_mismatch",
    );
    expect(updates).toEqual([]);
  });

  it("ONE_TIME / REUSABLE accept an opt-in display name + email but never a pseudonym", async () => {
    const a = fakeDb();
    await recordIntakeSubmitterIdentity(
      {
        sessionId: "session-1",
        link: fakeLink("EXTERNAL_ONE_TIME"),
        submitterDisplayName: "Jane Doe",
        submitterEmail: "jane@example.com",
      },
      a.client,
    );
    expect(a.updates).toEqual([
      { submitterDisplayName: "Jane Doe", submitterEmail: "jane@example.com" },
    ]);

    const b = fakeDb();
    await expectRefusal(
      recordIntakeSubmitterIdentity(
        { sessionId: "session-1", link: fakeLink("EXTERNAL_REUSABLE"), pseudonym: "alias" },
        b.client,
      ),
      "intake_mode_mismatch",
    );
    expect(b.updates).toEqual([]);
  });

  it("authenticated / field-team modes collect nothing", async () => {
    for (const mode of ["AUTHENTICATED_STANDARD", "FIELD_TEAM", "REVIEWER_REQUEST"]) {
      const { client, updates } = fakeDb();
      await expectRefusal(
        recordIntakeSubmitterIdentity(
          { sessionId: "session-1", link: fakeLink(mode), submitterDisplayName: "X" },
          client,
        ),
        "intake_mode_mismatch",
      );
      expect(updates).toEqual([]);
    }
  });
});

// -----------------------------------------------------------------------------
// 3. Normalization + bounds
// -----------------------------------------------------------------------------

describe("Intake pseudonym §3 — normalization is bounded and fail-closed", () => {
  it("trims, collapses whitespace and strips control/invisible characters", async () => {
    const { client, updates } = fakeDb();
    await recordIntakeSubmitterIdentity(
      {
        sessionId: "session-1",
        link: fakeLink("EXTERNAL_PSEUDONYMOUS"),
        pseudonym: "  concerned​   source  ",
      },
      client,
    );
    expect(updates[0]!.pseudonym).toBe("concerned source");
  });

  it("bounds the pseudonym to its declared maximum", async () => {
    const { client, updates } = fakeDb();
    await recordIntakeSubmitterIdentity(
      {
        sessionId: "session-1",
        link: fakeLink("EXTERNAL_PSEUDONYMOUS"),
        pseudonym: "a".repeat(INTAKE_PSEUDONYM_MAX_LENGTH + 50),
      },
      client,
    );
    expect(String(updates[0]!.pseudonym)).toHaveLength(
      INTAKE_PSEUDONYM_MAX_LENGTH,
    );
  });

  it("a whitespace-only pseudonym is 'not provided', never a blank identity", async () => {
    const { client, updates } = fakeDb();
    await expectRefusal(
      recordIntakeSubmitterIdentity(
        { sessionId: "session-1", link: fakeLink("EXTERNAL_PSEUDONYMOUS"), pseudonym: "   ​ " },
        client,
      ),
      "submitter_identity_invalid",
    );
    expect(updates).toEqual([]);
  });

  it("declares bounds for all three columns", () => {
    expect(INTAKE_PSEUDONYM_MAX_LENGTH).toBeGreaterThan(0);
    expect(INTAKE_DISPLAY_NAME_MAX_LENGTH).toBeGreaterThan(0);
    expect(INTAKE_EMAIL_MAX_LENGTH).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// 4. Session binding — cross-link and terminal-session denial
// -----------------------------------------------------------------------------

describe("Intake pseudonym §4 — the session must belong to THIS link", () => {
  it("a session bound to another link is refused (no cross-link write)", async () => {
    const { client, updates } = fakeDb({ intakeLinkId: "link-OTHER" });
    await expectRefusal(
      recordIntakeSubmitterIdentity(
        { sessionId: "session-1", link: fakeLink("EXTERNAL_PSEUDONYMOUS"), pseudonym: "alias" },
        client,
      ),
      "session_link_mismatch",
    );
    expect(updates).toEqual([]);
  });

  it("a terminal session cannot have its identity rewritten", async () => {
    const { client, updates } = fakeDb({ status: "SUBMITTED" });
    await expectRefusal(
      recordIntakeSubmitterIdentity(
        { sessionId: "session-1", link: fakeLink("EXTERNAL_PSEUDONYMOUS"), pseudonym: "alias" },
        client,
      ),
      "session_terminal",
    );
    expect(updates).toEqual([]);
  });

  it("a missing session is refused", async () => {
    const world = {
      workflowIntakeSession: {
        findUnique: vi.fn(async () => null),
        update: vi.fn(async () => {
          throw new Error("must not be reached");
        }),
      },
    };
    await expectRefusal(
      recordIntakeSubmitterIdentity(
        {
          sessionId: "missing",
          link: fakeLink("EXTERNAL_PSEUDONYMOUS"),
          pseudonym: "alias",
        },
        asPrismaDouble<PrismaClient>(world),
      ),
      "session_not_found",
    );
  });
});

// -----------------------------------------------------------------------------
// 5. Route wiring — POST with a body, token-bound, no identity echoed
// -----------------------------------------------------------------------------

describe("Intake pseudonym §5 — the public entry point is a token-bound POST", () => {
  const routes = readFileSync(
    join(API_SRC, "routes", "external-intake.routes.ts"),
    "utf8",
  );

  it("registers POST /v1/external-intake/:token/sessions/:sid/identity", () => {
    expect(routes).toMatch(
      /app\.post\(\s*"\/v1\/external-intake\/:token\/sessions\/:sid\/identity"/,
    );
  });

  it("resolves the link from the validated token, never from the request body", () => {
    const handler = routes.slice(
      routes.indexOf('"/v1/external-intake/:token/sessions/:sid/identity"'),
      routes.indexOf('"/v1/external-intake/:token/sessions/:sid/consent"'),
    );
    expect(handler).toMatch(/validateIntakeToken\(params\.token\)/);
    expect(handler).toMatch(/recordIntakeSubmitterIdentity\(/);
    // The workspace/link identity is never read off the body.
    expect(handler).not.toMatch(/body\.(teamId|workspaceId|organizationId|linkId)/);
  });

  it("applies the same rate limits + feature gate as every other public route", () => {
    const handler = routes.slice(
      routes.indexOf('"/v1/external-intake/:token/sessions/:sid/identity"'),
      routes.indexOf('"/v1/external-intake/:token/sessions/:sid/consent"'),
    );
    expect(handler).toMatch(/workflowIntakeFeatureDisabledReason\(\)/);
    expect(handler).toMatch(/applyRateLimits\(req, reply, params\.token\)/);
  });

  it("the GET validation route still passes NO identity to the opener", () => {
    const callStart = routes.indexOf("await openIntakeSession({");
    expect(callStart).toBeGreaterThan(-1);
    // The argument object of the ONLY openIntakeSession call site.
    const call = routes.slice(callStart, routes.indexOf("});", callStart));
    expect(call).toMatch(/link,/);
    expect(call).not.toMatch(/pseudonym/);
    expect(call).not.toMatch(/submitterDisplayName/);
    expect(call).not.toMatch(/submitterEmail/);
  });

  it("the response cannot echo the submitted identity", () => {
    // The public session projection has no identity field at all, so the
    // 200 body is structurally incapable of returning it.
    const service = readFileSync(
      join(API_SRC, "services", "workflow-intake-session.service.ts"),
      "utf8",
    );
    const projection = service.slice(
      service.indexOf("export function projectIntakeSessionForExternalView"),
    );
    const body = projection.slice(0, projection.indexOf("\n}\n"));
    expect(body).not.toMatch(/pseudonym/);
    expect(body).not.toMatch(/submitterEmail/);
    expect(body).not.toMatch(/submitterDisplayName/);
  });

  it("the failure message describes the requirement, never the submitted value", () => {
    expect(routes).toMatch(/SUBMITTER_IDENTITY_INVALID/);
    const friendly = routes.slice(
      routes.indexOf('case "SUBMITTER_IDENTITY_INVALID":'),
    );
    const line = friendly.slice(0, friendly.indexOf(";"));
    expect(line).toMatch(/display name/i);
    expect(line).not.toMatch(/\$\{/);
  });
});

// -----------------------------------------------------------------------------
// 6. The two client surfaces
// -----------------------------------------------------------------------------

describe("Intake pseudonym §6 — collected publicly, shown to the reviewer", () => {
  const publicPage = readFileSync(
    join(WEB_APP, "intake", "[token]", "page.tsx"),
    "utf8",
  );

  it("the public page collects a display name for EXTERNAL_PSEUDONYMOUS only", () => {
    expect(publicPage).toMatch(
      /requiresPseudonym\s*=\s*link\?\.intakeMode === "EXTERNAL_PSEUDONYMOUS"/,
    );
    expect(publicPage).toMatch(/\{requiresPseudonym \? \(/);
  });

  it("it sends the value in a POST body, never in the URL", () => {
    expect(publicPage).toMatch(
      /sessions\/\$\{session\.id\}\/identity`[\s\S]{0,200}method: "POST"/,
    );
    expect(publicPage).toMatch(/JSON\.stringify\(\{ pseudonym: chosen \}\)/);
    // No query-string identity anywhere on the page.
    expect(publicPage).not.toMatch(/[?&]pseudonym=/);
  });

  it("it blocks continuation until a name is entered, and does not proceed on denial", () => {
    expect(publicPage).toMatch(
      /requiresPseudonym && pseudonym\.trim\(\)\.length === 0/,
    );
    // The catch returns BEFORE consent is recorded — a refused identity must
    // not leave a session that silently proceeds anonymously.
    const accept = publicPage.slice(
      publicPage.indexOf("async function acceptConsent()"),
    );
    const identityBlock = accept.slice(0, accept.indexOf("const policyVersion"));
    expect(identityBlock).toMatch(/friendlyIntakeError[\s\S]{0,120}return;/);
  });

  it("the reviewer projection surfaces the pseudonym for PSEUDONYMOUS and nothing else", () => {
    const link = {
      id: "link-1",
      intakeMode: "EXTERNAL_PSEUDONYMOUS",
      workflowTemplateSnapshot: { name: "T" },
      recipientLabel: "R",
      status: "ACTIVE",
      expiresAtUtc: new Date("2026-12-31T00:00:00Z"),
      createdAt: new Date("2026-05-16T10:00:00Z"),
      updatedAt: new Date("2026-05-16T10:00:00Z"),
    } as unknown as Parameters<typeof buildSummary>[0];
    const session = {
      id: "session-1",
      intakeLinkId: "link-1",
      status: "SUBMITTED",
      pseudonym: "concerned-source",
      submitterDisplayName: "Jane Doe",
      submitterEmail: "jane@example.com",
      expiresAtUtc: new Date("2026-12-31T00:00:00Z"),
      createdAt: new Date("2026-05-16T10:30:00Z"),
      updatedAt: new Date("2026-05-16T10:45:00Z"),
    } as unknown as Parameters<typeof buildSummary>[1];

    const summary = buildSummary(link, session);
    expect(summary.session.pseudonym).toBe("concerned-source");
    // Even if the row erroneously held them, identity stays scrubbed.
    expect(JSON.stringify(summary)).not.toContain("jane@example.com");
  });
});
