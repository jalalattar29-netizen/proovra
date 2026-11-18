/**
 * PRO-O1-15 (RG-18) — the artifact download gate passes a declared 4xx from
 * the read-access resolver through, and rethrows anything else to the central
 * handler instead of answering 500 with the raw internal message.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  prisma: new Proxy(
    {},
    {
      get() {
        throw new Error("the gate must not read the database after a read-access failure");
      },
    },
  ),
}));

const { evaluateArtifactDownload } = await import("../src/services/evidence/artifact-download-gate.service.js");

const base = {
  evidenceId: "44444444-4444-4444-8444-444444444444",
  actorUserId: "11111111-1111-4111-8111-111111111111",
  kind: "report" as const,
  recordDenial: false,
};

describe("artifact download gate — unexpected read-access failure (PRO-O1-15)", () => {
  it("a declared 404 keeps its status and message", async () => {
    const decision = await evaluateArtifactDownload({
      ...base,
      readAccess: async () => {
        throw Object.assign(new Error("Evidence not found"), { statusCode: 404 });
      },
    } as never);
    expect(decision).toMatchObject({ allowed: false, statusCode: 404, body: { message: "Evidence not found" } });
  });

  it("an internal failure is rethrown, never answered with its raw message", async () => {
    const internal = new Error('prisma: Can\'t reach database server at "db.internal:5432"');
    await expect(
      evaluateArtifactDownload({
        ...base,
        readAccess: async () => {
          throw internal;
        },
      } as never),
    ).rejects.toBe(internal);
  });
});
