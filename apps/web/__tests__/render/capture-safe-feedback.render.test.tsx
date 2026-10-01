import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as captureErrors from "../../app/(app)/capture/_lib/capture-errors";

/**
 * UC-WEB-006 — a drag-and-drop failure (or an audio add failure) must never
 * put the raw browser exception text on screen; it goes through the
 * sanctioned safe-feedback path (toSafeUserError) with fixed copy.
 */
const CAPTURE = resolve(__dirname, "../../app/(app)/capture");
const read = (rel: string) => readFileSync(resolve(CAPTURE, rel), "utf8");

describe("capture safe feedback", () => {
  it("the drop handler and audio add never render err.message", () => {
    expect(read("page.tsx")).not.toMatch(/\?\s*err\.message/);
    expect(read("_hooks/useCaptureAudioRecorder.ts")).not.toMatch(/\?\s*err\.message/);
  });

  it("a raw DOMException from a folder read becomes fixed copy", () => {
    const describeDropFailure = (captureErrors as Record<string, unknown>).describeDropFailure as
      | ((e: unknown) => string)
      | undefined;
    expect(typeof describeDropFailure).toBe("function");
    const raw = new Error(
      "NotFoundError: A requested file or directory could not be found at the time an operation was processed.",
    );
    raw.name = "NotFoundError";
    const text = describeDropFailure!(raw);
    expect(text).toBe("Dropped files or folder could not be added.");
    expect(text).not.toMatch(/NotFoundError|operation was processed/);
  });
});
