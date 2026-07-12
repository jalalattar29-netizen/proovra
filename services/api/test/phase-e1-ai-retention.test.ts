/** Phase E1 — AI advisory-record retention (behavioral). */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AI_RETENTION_DAYS,
  cleanupExpiredCopilotRuns,
  retentionCutoff,
} from "../src/services/ai/ai-retention.service.js";

describe("E1 — retention window", () => {
  it("cutoff math is exact days back", () => {
    const now = new Date("2026-07-12T00:00:00Z");
    expect(retentionCutoff(30, now).toISOString()).toBe("2026-06-12T00:00:00.000Z");
    expect(DEFAULT_AI_RETENTION_DAYS).toBe(365);
  });
  it("cleanup never throws when DB is unavailable (returns 0)", async () => {
    const n = await cleanupExpiredCopilotRuns("00000000-0000-0000-0000-000000000000");
    expect(n).toBe(0);
  });
});
