/**
 * THE PUBLIC INTAKE FAILURE, PINNED.
 *
 * A contributor opened a Personal PRO intake link, chose a photo, and the page
 * answered "We hit a problem on our side. Please try again in a moment." Every
 * retry produced the identical message, because the input was identical, so
 * the intake simply could not be completed.
 *
 * It was not a fault on our side in any useful sense. It was a file NAME.
 *
 *   route validation      originalFileName  max 512     mimeType  max 160
 *   the normaliser        truncated to      256
 *   the column            VARCHAR(255)                  VARCHAR(128)
 *
 * A name of 256 characters or more — which is what phones and messaging apps
 * produce all the time — passed validation, was truncated to exactly one
 * character past the column, and Postgres answered P2000. The route's
 * catch-all turned that into a 500 with a generic code, and it logged nothing
 * at all, so the operator could not see it either.
 *
 * Fixing the length then exposed the next one: the object KEY embeds the file
 * name, and its last path segment must fit in 255 bytes too, so a 255-char
 * name produced a 259-byte segment and S3 refused the upload with
 * `XMinioInvalidObjectName` — "Upload failed (400)" instead of the 500.
 *
 * Three bounds, one rule: what the contributor sends is bounded to what the
 * thing receiving it can hold, and it is TRUNCATED rather than refused,
 * because a long file name must never cost somebody their evidence.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const SCHEMA = read("services/api/prisma/schema.prisma");
const ORCHESTRATION = read(
  "services/api/src/services/external-intake-orchestration.service.ts",
);
const ROUTES = read("services/api/src/routes/external-intake.routes.ts");

/** The declared width of one column on `evidence_parts`. */
function columnWidth(field: string): number {
  const model = SCHEMA.slice(
    SCHEMA.indexOf("model EvidencePart {"),
    SCHEMA.indexOf("\n}", SCHEMA.indexOf("model EvidencePart {")),
  );
  const line = model
    .split("\n")
    .find((l) => l.trim().startsWith(`${field} `));
  const match = line?.match(/@db\.VarChar\((\d+)\)/);
  if (!match) throw new Error(`no VarChar width for ${field}`);
  return Number(match[1]);
}

describe("what the contributor sends fits what stores it", () => {
  it("the file-name bound IS the column width — not one past it", () => {
    /*
     * The original bound was 256 against a VARCHAR(255). Off by one, and
     * therefore wrong for every name long enough to reach it and right for
     * every name that never did — which is exactly the shape of a bug that
     * survives a long time.
     */
    expect(columnWidth("originalFileName")).toBe(255);
    expect(ORCHESTRATION).toContain("const PART_ORIGINAL_FILE_NAME_MAX = 255;");
    expect(ORCHESTRATION).not.toContain("trimmed.slice(0, 256)");
  });

  it("the mime bound is the column width too", () => {
    expect(columnWidth("mimeType")).toBe(128);
    expect(ORCHESTRATION).toContain("const PART_MIME_TYPE_MAX = 128;");
    expect(ORCHESTRATION).toContain(
      "mimeType: input.mimeType.slice(0, PART_MIME_TYPE_MAX)",
    );
  });

  it("route validation never accepts a mime the column cannot hold", () => {
    // 160 vs VARCHAR(128) was the second way to reach the same 500.
    const parts = ROUTES.slice(
      ROUTES.indexOf('"/v1/external-intake/:token/sessions/:sid/parts"'),
    );
    expect(parts).toContain("mimeType: z.string().min(1).max(128)");
    expect(parts).not.toContain("mimeType: z.string().min(1).max(160)");
  });

  it("a long name is truncated, never refused — and keeps its extension", () => {
    /*
     * The name is presentation metadata. Refusing the upload over it would
     * trade a 500 for a 400 and leave the contributor equally stuck; and
     * truncating past the dot would leave a reviewer looking at a file whose
     * name no longer says what it is.
     */
    const fn = ORCHESTRATION.slice(
      ORCHESTRATION.indexOf("function safeOriginalFileName("),
      ORCHESTRATION.indexOf("function evidenceTypeFromMime("),
    );
    expect(fn).toContain("PART_ORIGINAL_FILE_NAME_MAX - ext.length");
    expect(fn).toContain("lastIndexOf(\".\")");
    expect(fn).not.toContain("throw");
  });

  it("the storage key is bounded independently of the display name", () => {
    /*
     * Object stores bound each path SEGMENT to 255 bytes, and the segment is
     * `000-<name>`. Tying the key to the full display name is what turned the
     * fixed 500 into a 400 from the object store.
     */
    expect(ORCHESTRATION).toContain("const PART_KEY_FILE_NAME_MAX = 120;");
    expect(ORCHESTRATION).toContain(
      "storageKeyFileNameFragment(fileName) ?? `part-${partIndex + 1}`",
    );
    expect(ORCHESTRATION).not.toMatch(
      /parts\/\$\{String\(partIndex\)\.padStart\(3, "0"\)\}-\$\{\s*fileName /,
    );
  });
});

describe("a failure the contributor cannot fix is at least recorded", () => {
  it("every public-intake catch-all logs before it answers", () => {
    /*
     * Five handlers ended in `return reply.code(500).send({ code:
     * "INTERNAL_ERROR" })` and recorded NOTHING. The contributor was told the
     * server had a problem; the operator was told nothing at all. The
     * incident could not be diagnosed from either end, which is why it lasted.
     */
    /*
     * THE GUARANTEE IS THE SAME; THE SHAPE IS NOT.
     *
     * This counted five `intakeErrorUnhandled: true` sites because there were
     * five copies of the same catch-all. They now delegate to ONE
     * `intakeUnhandled`, which logs before it answers and re-throws a schema
     * rejection so the caller gets a bounded 400 instead of being told the
     * fault was ours. Counting copies would now measure the duplication that
     * was removed rather than the property that matters.
     *
     * So the property is asserted directly: every catch-all reaches the one
     * handler, and that handler always records before it answers.
     */
    const delegations = ROUTES.match(/intakeUnhandled\(\s*err,\s*req,\s*reply,\s*"/g) ?? [];
    expect(
      delegations.length,
      "every generic catch-all must go through the one handler",
    ).toBe(5);

    const handler = ROUTES.slice(
      ROUTES.indexOf("function intakeUnhandled("),
      ROUTES.indexOf("export async function externalIntakeRoutes("),
    );
    // Logs, and logs BEFORE it answers.
    const logAt = handler.indexOf("intakeErrorUnhandled: true");
    const answerAt = handler.indexOf('code: "INTERNAL_ERROR"');
    expect(logAt).toBeGreaterThanOrEqual(0);
    expect(answerAt).toBeGreaterThan(logAt);

    // And the answer carries the id that finds that log line.
    expect(handler).toContain('code: "INTERNAL_ERROR", requestId');

    // No INTERNAL_ERROR answer anywhere without a record of why.
    const answers = [...ROUTES.matchAll(/code: "INTERNAL_ERROR"/g)];
    for (const m of answers) {
      const before = ROUTES.slice(Math.max(0, m.index! - 400), m.index!);
      const logged =
        before.includes("intakeErrorUnhandled") ||
        // The orchestration mapper's `default:` is a deliberate, named branch.
        before.includes("default:") ||
        // The public page's friendly-copy map names the code; it is copy, not
        // an answer.
        before.includes("friendlyPublicIntakeMessage");
      expect(logged, "an INTERNAL_ERROR answer with no record of why").toBe(true);
    }
  });

  it("the log carries the error and the route, and no contributor content", () => {
    const block = ROUTES.slice(
      ROUTES.indexOf("intakeErrorUnhandled: true"),
    ).slice(0, 400);
    expect(block).toContain("external intake: unhandled error");
    expect(block).not.toContain("originalFileName");
    expect(block).not.toContain("body");
  });
});
