/**
 * PRO-K2-03 — the in-memory presence store is bounded ACROSS keys.
 *
 * Before the fix a bucket was evicted only when the SAME key was read again
 * after its entries expired, so a caller posting heartbeats for distinct
 * resource ids grew the process heap without bound until restart.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as presence from "../src/services/presence/presence.service.js";

const TEAM = "00000000-0000-4000-8000-000000000001";

function id(i: number): string {
  return `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
}

describe("PRO-K2-03 presence store key bound", () => {
  afterEach(() => {
    vi.useRealTimers();
    presence._resetPresenceStoreForTests();
  });

  it("expired keys nobody reads again are swept on a later write", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
    for (let i = 0; i < 500; i++) {
      presence.recordHeartbeat({ teamId: TEAM, resourceKind: "evidence", resourceId: id(i), userId: "u1", displayName: "U" });
    }
    expect(presence._presenceKeyCountForTests()).toBe(500);
    vi.setSystemTime(new Date(Date.now() + presence.PRESENCE_HEARTBEAT_TTL_MS + 5_000));
    presence.recordHeartbeat({ teamId: TEAM, resourceKind: "evidence", resourceId: id(10_000), userId: "u1", displayName: "U" });
    expect(presence._presenceKeyCountForTests()).toBe(1);
  });

  it("a flood of distinct live keys never exceeds the cap, and the newest key survives", () => {
    const flood = presence.PRESENCE_MAX_KEYS + 5_000;
    for (let i = 0; i < flood; i++) {
      presence.recordHeartbeat({ teamId: TEAM, resourceKind: "evidence", resourceId: id(i), userId: "u1", displayName: "U" });
    }
    expect(presence._presenceKeyCountForTests()).toBeLessThanOrEqual(presence.PRESENCE_MAX_KEYS);
    const last = id(flood - 1);
    expect(
      presence.listViewers({ teamId: TEAM, resourceKind: "evidence", resourceId: last, excludeUserId: "other" }),
    ).toHaveLength(1);
  });
});
