/**
 * Request seeds for routes whose valid shape the Zod repair cannot reach alone.
 * `$Model` stands for a fresh row of that model on the side making the request.
 */
import type { RequestShape } from "./write-sweep-engine.js";

export const WRITE_SWEEP_HINTS: Record<string, Partial<RequestShape>> = {
  // An empty list passes validation and writes nothing, which would hide a missing guard.
  "POST /v1/redaction/videos/:p/frames/batch": {
    body: { extractor: "OPERATOR_INLINE", frames: [{ frameIndex: 0, timestampMs: 0 }] },
  },
  "POST /v1/lifecycle/destruction/requests": {
    body: {
      teamId: "$Team",
      evidenceIds: ["$EvidenceTrashed"],
      reason: "sweep destruction request",
      requiredApproverUserIds: ["$Approver"],
    },
  },
};
