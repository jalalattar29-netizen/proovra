/**
 * PRO-R3-10 (RG-18), closure 2026-11-21 — Public Verify never states operator-
 * typed video provenance ("Video frames reviewed", "Regions approved for
 * masking"). Drives the REAL projectVerifyRedaction with an explicit client
 * double whose video tables hold rows an administrator registered by hand.
 */
import { describe, expect, it } from "vitest";
import { projectVerifyRedaction } from "../src/services/redaction/verify-redaction-projection.service.js";

type Published = { versionOrdinal: number; publishedAtUtc: Date; approvals: Array<{ id: string }> } | null;

function client(opts: { project: boolean; published: Published; frames: number; acceptedTracks: number }) {
  const reads: string[] = [];
  const c = {
    redactionProject: {
      findFirst: async () => {
        reads.push("redactionProject");
        if (!opts.project) return null;
        return { id: "p1", versions: opts.published ? [opts.published] : [] };
      },
    },
    videoFrame: {
      count: async () => {
        reads.push("videoFrame");
        return opts.frames;
      },
    },
    videoTrack: {
      count: async () => {
        reads.push("videoTrack");
        return opts.acceptedTracks;
      },
    },
  };
  return { c: c as never, reads };
}

describe("PRO-R3-10 — operator-entered video provenance never reaches Public Verify", () => {
  it("a published project with 120 hand-registered frames and 3 accepted tracks projects videoProvenance null", async () => {
    const { c, reads } = client({
      project: true,
      published: { versionOrdinal: 2, publishedAtUtc: new Date("2026-11-20T10:00:00Z"), approvals: [{ id: "a1" }, { id: "a2" }] },
      frames: 120,
      acceptedTracks: 3,
    });
    const out = await projectVerifyRedaction({ teamId: "t1", evidenceId: "e1" }, c);
    expect(out).not.toBeNull();
    expect(out!.videoProvenance).toBeNull();
    // The system facts still project.
    expect(out!.hasPublishedDerivative).toBe(true);
    expect(out!.publishedVersionOrdinal).toBe(2);
    expect(out!.approvalCount).toBe(2);
    // The operator-typed tables are not even read.
    expect(reads).not.toContain("videoFrame");
    expect(reads).not.toContain("videoTrack");
  });

  it("hand-registered frames without a redaction project produce no redaction section at all", async () => {
    const { c } = client({ project: false, published: null, frames: 60, acceptedTracks: 1 });
    expect(await projectVerifyRedaction({ teamId: "t1", evidenceId: "e1" }, c)).toBeNull();
  });

  it("no workspace: nothing is projected", async () => {
    const { c, reads } = client({ project: true, published: null, frames: 5, acceptedTracks: 0 });
    expect(await projectVerifyRedaction({ teamId: null, evidenceId: "e1" }, c)).toBeNull();
    expect(reads).toHaveLength(0);
  });
});
