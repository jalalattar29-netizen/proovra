/**
 * UC-4 — DERIVED reconstruction core (pure, deterministic).
 *
 * These cover the ABSOLUTE product laws of the reconstruction algorithm, with
 * the two fixtures the directive names explicitly:
 *   * conservative dedup — two distinct "OK" messages stay distinct (§29);
 *   * scroll overlap — A/B/C/D then C/D/E/F reconstructs A..F while preserving
 *     that C/D were observed twice (§30);
 * plus orientation-change safety (§31), coverage separation (§22/§33), and
 * keyframe-selection bounds.
 */
import { describe, it, expect } from "vitest";
import {
  reconstructScreenConversation,
  reconstructionCoverageLabel,
  scrollOverlap,
  selectKeyframes,
  keyframeVariantKey,
  KEYFRAME_SELECTION_BOUNDS,
  type ScreenObservation,
} from "@proovra/shared";

/** Build one observation with sensible lineage defaults. */
function obs(
  frameOrder: number,
  rowOrder: number,
  text: string,
  extra: Partial<ScreenObservation> = {},
): ScreenObservation {
  return {
    id: `f${frameOrder}-r${rowOrder}`,
    keyframeId: `kf-${frameOrder}`,
    sourcePartIndex: extra.sourcePartIndex ?? 0,
    sourceOffsetMs: extra.sourceOffsetMs ?? frameOrder * 1000,
    frameOrder,
    rowOrder,
    text,
    kind: extra.kind ?? "TEXT",
    fingerprint: extra.fingerprint ?? null,
  };
}

describe("UC-4 reconstruction — conservative dedup (§29)", () => {
  it("keeps two distinct 'OK' messages distinct (no text-equality merge)", () => {
    // Two frames that do NOT scroll-overlap; each shows a lone "OK".
    const observations = [obs(0, 0, "OK"), obs(1, 0, "OK", { sourceOffsetMs: 5000 })];
    const r = reconstructScreenConversation(observations);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks.map((b) => b.text)).toEqual(["OK", "OK"]);
    // No overlap across the boundary ⇒ continuity cannot be proven ⇒ PARTIAL.
    expect(r.coverage).toBe("PARTIAL");
    expect(r.limitations).toContain("RECONSTRUCTION_POSSIBLE_GAP");
  });

  it("merges the SAME row only across a proven scroll-overlap run", () => {
    // Frame 0: [A,B]; Frame 1: [B,C] — B is the overlap, so B is ONE block.
    const observations = [
      obs(0, 0, "A"),
      obs(0, 1, "B"),
      obs(1, 0, "B"),
      obs(1, 1, "C"),
    ];
    const r = reconstructScreenConversation(observations);
    expect(r.blocks.map((b) => b.text)).toEqual(["A", "B", "C"]);
    const bBlock = r.blocks.find((b) => b.text === "B")!;
    expect(bBlock.observedInFrames).toBe(2); // corroborated across two frames
    expect(bBlock.confidence).toBe("HIGH_OVERLAP");
    expect(r.coverage).toBe("COMPLETE");
  });
});

describe("UC-4 reconstruction — scroll overlap (§30)", () => {
  it("reconstructs A..F from A/B/C/D then C/D/E/F, preserving double-observation", () => {
    const observations = [
      obs(0, 0, "A"),
      obs(0, 1, "B"),
      obs(0, 2, "C"),
      obs(0, 3, "D"),
      obs(1, 0, "C"),
      obs(1, 1, "D"),
      obs(1, 2, "E"),
      obs(1, 3, "F"),
    ];
    const r = reconstructScreenConversation(observations);
    expect(r.blocks.map((b) => b.text)).toEqual(["A", "B", "C", "D", "E", "F"]);
    // C and D were observed in BOTH frames — lineage preserves it.
    const c = r.blocks.find((b) => b.text === "C")!;
    const d = r.blocks.find((b) => b.text === "D")!;
    expect(c.observedInFrames).toBe(2);
    expect(d.observedInFrames).toBe(2);
    expect(c.observationIds.length).toBe(2);
    // No source observation is deleted — every one of the 8 is accounted for.
    const totalObs = r.blocks.reduce((n, b) => n + b.observationIds.length, 0);
    expect(totalObs).toBe(8);
    expect(r.coverage).toBe("COMPLETE");
  });

  it("scrollOverlap finds the longest contiguous suffix/prefix run", () => {
    const prev = [obs(0, 0, "A"), obs(0, 1, "B"), obs(0, 2, "C")];
    const next = [obs(1, 0, "B"), obs(1, 1, "C"), obs(1, 2, "D")];
    expect(scrollOverlap(prev, next)).toBe(2); // B,C
    // A jump / new screen ⇒ 0 (cannot prove continuity).
    expect(scrollOverlap(prev, [obs(1, 0, "X")])).toBe(0);
  });
});

describe("UC-4 reconstruction — fingerprint & orientation (§28/§31)", () => {
  it("does NOT merge equal text when fingerprints disagree (geometry-aware guard)", () => {
    // Same text, adjacent frames, but different fingerprints ⇒ not the same row.
    const observations = [
      obs(0, 0, "Message", { fingerprint: "fp-a" }),
      obs(1, 0, "Message", { fingerprint: "fp-b" }),
    ];
    const r = reconstructScreenConversation(observations);
    expect(r.blocks).toHaveLength(2);
  });

  it("merges equal text when fingerprints agree across the overlap", () => {
    const observations = [
      obs(0, 0, "Top"),
      obs(0, 1, "Shared", { fingerprint: "fp-x" }),
      obs(1, 0, "Shared", { fingerprint: "fp-x" }),
      obs(1, 1, "Bottom"),
    ];
    const r = reconstructScreenConversation(observations);
    expect(r.blocks.map((b) => b.text)).toEqual(["Top", "Shared", "Bottom"]);
  });
});

describe("UC-4 reconstruction — coverage separation (§22/§33)", () => {
  it("an INTERRUPTED acquisition never yields a COMPLETE reconstruction", () => {
    // Even a perfectly contiguous reconstruction is PARTIAL when acquisition
    // was interrupted — the derived layer never upgrades acquisition truth.
    expect(reconstructionCoverageLabel(false, "COMPLETE")).toBe("PARTIAL");
    expect(reconstructionCoverageLabel(true, "COMPLETE")).toBe("COMPLETE");
    expect(reconstructionCoverageLabel(true, "PARTIAL")).toBe("PARTIAL");
  });

  it("emits no fabricated authenticity score — only structural confidence bands", () => {
    const r = reconstructScreenConversation([obs(0, 0, "A"), obs(0, 1, "B")]);
    for (const b of r.blocks) {
      expect(["HIGH_OVERLAP", "PARTIAL_OVERLAP", "AMBIGUOUS", "UNRESOLVED"]).toContain(
        b.confidence,
      );
    }
  });
});

describe("UC-4 keyframe selection — bounded & deterministic", () => {
  it("keeps first, then by interval or material change, capped at maxKeyframes", () => {
    const candidates = Array.from({ length: 500 }, (_, i) => ({
      offsetMs: i * 100,
      changeScore: i % 50 === 0 ? 0.9 : 0.0,
    }));
    const sel = selectKeyframes(candidates, KEYFRAME_SELECTION_BOUNDS);
    expect(sel.keyframes.length).toBeLessThanOrEqual(KEYFRAME_SELECTION_BOUNDS.maxKeyframes);
    expect(sel.keyframes[0]!.reason).toBe("first");
    expect(keyframeVariantKey(0)).toBe("kf-0000");
    expect(keyframeVariantKey(12)).toBe("kf-0012");
  });

  it("degrades to PARTIAL (boundsReached) instead of growing unbounded", () => {
    const candidates = Array.from({ length: 5000 }, (_, i) => ({
      offsetMs: i * 2000, // every one is far enough apart to be kept
      changeScore: 0,
    }));
    const sel = selectKeyframes(candidates);
    expect(sel.boundsReached).toBe(true);
    expect(sel.keyframes.length).toBe(KEYFRAME_SELECTION_BOUNDS.maxKeyframes);
  });
});
