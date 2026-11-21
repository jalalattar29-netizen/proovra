/**
 * PRO-R3-10 (WS-OUT RG-18) — Public Verify stated "video frames reviewed" and
 * "regions approved for masking" from rows an administrator TYPES into a form
 * (no worker extracts frames from the sealed object). Behavioural:
 * projectVerifyRedaction runs against a workspace that holds operator-entered
 * video frames and accepted tracks, and the public projection is read back.
 *
 *   * allowed: a published redaction derivative is still stated (version,
 *     approvals, limitations);
 *   * refused: operator-entered frame/track counts never reach the public
 *     projection (videoProvenance null), and frames alone (no redaction
 *     project) surface nothing at all.
 */
import { describe, expect, it } from "vitest";

import { projectVerifyRedaction } from "../src/services/redaction/verify-redaction-projection.service.js";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVIDENCE = "11111111-1111-4111-8111-111111111111";
const published = new Date("2026-11-01T10:00:00.000Z");

function client(opts: { project: boolean; frames: number; acceptedTracks: number }) {
  return {
    redactionProject: {
      findFirst: async () =>
        opts.project
          ? {
              id: "proj-1",
              versions: [{ versionOrdinal: 2, publishedAtUtc: published, approvals: [{ id: "a1" }, { id: "a2" }] }],
            }
          : null,
    },
    videoFrame: { count: async () => opts.frames },
    videoTrack: { count: async () => opts.acceptedTracks },
  } as never;
}

describe("PRO-R3-10 — operator-entered video provenance never reaches Public Verify", () => {
  it("allowed: a published derivative is stated; the typed frame and track counts are not", async () => {
    const out = await projectVerifyRedaction(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client({ project: true, frames: 120, acceptedTracks: 4 }),
    );
    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      hasPublishedDerivative: true,
      publishedVersionOrdinal: 2,
      publishedAtUtc: published.toISOString(),
      approvalCount: 2,
      videoProvenance: null,
    });
    expect(out!.limitations.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toMatch(/"totalFrames"|"acceptedTracks"/);
  });

  it("refused: operator-entered frames with no redaction project surface nothing", async () => {
    const out = await projectVerifyRedaction(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client({ project: false, frames: 500, acceptedTracks: 9 }),
    );
    expect(out).toBeNull();
  });

  it("control: no workspace -> nothing", async () => {
    expect(
      await projectVerifyRedaction({ teamId: null, evidenceId: EVIDENCE }, client({ project: true, frames: 1, acceptedTracks: 1 })),
    ).toBeNull();
  });
});
