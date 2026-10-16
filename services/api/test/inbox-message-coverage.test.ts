/**
 * Every item the inbox route raises carries a structured, localisable message
 * (`message: { key, params }`) from the shared closed set — so no emitter can
 * leave German or Arabic readers with an English-only title and body. The
 * live suites (helpers/inbox-message-fidelity.ts) prove each message renders
 * the route's own English exactly; this proves no emitter was skipped.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { NOTIFICATION_MESSAGE_KEYS } from "@proovra/shared/i18n";

const ROUTE = readFileSync(resolve(import.meta.dirname, "../src/routes/me-inbox.routes.ts"), "utf8");

/** Each `items.push({ … })` block of the assembly, as text. */
function emitterBlocks(): string[] {
  const blocks: string[] = [];
  let at = ROUTE.indexOf("items.push({");
  while (at >= 0) {
    let depth = 0;
    let end = at + "items.push(".length;
    for (; end < ROUTE.length; end += 1) {
      const ch = ROUTE[end];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(ROUTE.slice(at, end + 1));
    at = ROUTE.indexOf("items.push({", end);
  }
  return blocks;
}

describe("inbox emitters say what they say as a localisable message", () => {
  const blocks = emitterBlocks();

  it("finds the emitters (the scan is not vacuous)", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(23);
  });

  it("every emitter carries a message whose key is in the shared closed set", () => {
    const keys = new Set<string>(NOTIFICATION_MESSAGE_KEYS);
    for (const block of blocks) {
      const id = /id:\s*([^\n,]+)/.exec(block)?.[1] ?? block.slice(0, 80);
      const key = /message:\s*\{\s*key:\s*"([^"]+)"/.exec(block)?.[1];
      expect(key, `emitter ${id} carries no message`).toBeTruthy();
      expect(keys.has(key!), `emitter ${id}: unknown message key ${key}`).toBe(true);
    }
  });

  it("history rows keep the message beside their stored text, and the redacted row has one too", () => {
    expect(ROUTE).toMatch(/metadataJson: snapshotMetadataWithMessage\(i\.context, i\.message\)/);
    expect(ROUTE).toMatch(/\.\.\.splitSnapshotMetadata\(s\.metadataJson\)/);
    expect(ROUTE).toMatch(/message: \{ key: "history\.unavailable", params: \{\} \}/);
  });
});
