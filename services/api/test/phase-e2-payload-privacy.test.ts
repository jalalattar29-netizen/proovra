/** Phase E2 — outbound payload privacy (behavioral snapshot). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sanitizeUntrustedField } from "../src/services/ai/prompt-context-sanitizer.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
const CAPTURE = readSource("../../../services/api/src/services/ai/ai-capture.service.ts");
const CHAT = readSource("../../../services/api/src/services/ai/ai-chat.service.ts");
const SEMANTIC = readSource("../../../services/api/src/services/intelligence/semantic.service.ts");

describe("E2 — free-text fields are sanitized before the provider", () => {
  it("capture role/sourceLabel pass through sanitizeUntrustedField", () => {
    expect(CAPTURE).toMatch(/sanitizeUntrustedField\(item\.role/);
    expect(CAPTURE).toMatch(/sanitizeUntrustedField\(item\.sourceLabel/);
  });
  it("chat messages pass through sanitizeUntrustedField", () => {
    expect(CHAT).toMatch(/sanitizeUntrustedField\(m\.content/);
  });
  it("semantic enqueue is gated by workspace AI policy", () => {
    expect(SEMANTIC).toMatch(/evaluateWorkspaceAiPolicy/);
    expect(SEMANTIC).toMatch(/SEMANTIC_SEARCH/);
  });
  it("sanitizer removes secrets/signed URLs/GPS from a hostile sourceLabel", () => {
    const out = sanitizeUntrustedField(
      "John Doe sk-abcdefghijklmnop https://s3/x?X-Amz-Signature=aa 37.42199,-122.08421",
      120,
    );
    expect(out).not.toMatch(/sk-abcdefghijklmnop|X-Amz-Signature|37\.42199/);
  });
});
