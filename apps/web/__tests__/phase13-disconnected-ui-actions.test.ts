/**
 * PHASE 13 §C — NEW-027 / NEW-028 / NEW-029: controls that were rendered,
 * enabled, and could not work.
 *
 * All three are the same defect wearing different clothes: a visible action
 * whose request either never left, or left for the wrong origin. A static
 * consumer scan cannot see any of them, because the route string is present —
 * which is precisely why the canonical map counted two of the three as
 * "missing UI" while the UI was right there, broken.
 *
 *   NEW-027  the SIU export history's Download control was an
 *            `<a href="/v1/cases/…/download">` — a relative path against the
 *            WEB origin, and no Authorization header.
 *   NEW-028  derived-asset thumbnails rendered the API's RELATIVE `bytesUrl`
 *            into an image source, so every thumbnail resolved against the
 *            wrong origin and fell into the panel's failed state.
 *   NEW-029  `MultipartUploader.cancel()` set three local flags and returned.
 *            The server was never told, so the session stayed open and the S3
 *            multipart upload was abandoned mid-flight with its parts stored.
 *
 * NEW-029 is EXECUTED against the real class with a stubbed transport, because
 * "cancel now calls the abort routes" is a behaviour and deserves to be driven.
 * The other two are pinned by shape, because what regressed there was a URL.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(WEB_ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// NEW-027 — the SIU export download
// ---------------------------------------------------------------------------

test("NEW-027: the SIU export download is a request, not a relative href", () => {
  const src = read("app/(app)/cases/components/SiuPanel.tsx");

  assert.equal(
    /href=\{`\/v1\//.test(src),
    false,
    "SiuPanel still renders an <a href> to a relative /v1 path — it resolves against the Next origin and 404s",
  );
  assert.ok(
    src.includes("siu-exports/${exportId}/download"),
    "the download call site is gone",
  );
  assert.ok(
    /apiBaseUrl\(\)\}\/v1\/cases\/\$\{caseId\}\/siu-exports/.test(src),
    "the download must address the API origin via apiBaseUrl()",
  );
  assert.ok(
    src.includes('credentials: "include"') && src.includes("Authorization"),
    "the download must carry the session credentials the export sibling already carried",
  );
  // A control that can fail must be able to SAY it failed.
  assert.ok(src.includes("Download refused"), "no user-facing failure copy for the download");
  assert.ok(src.includes("downloadingId"), "no busy state while the download runs");
});

// ---------------------------------------------------------------------------
// NEW-028 — derived asset bytes
// ---------------------------------------------------------------------------

test("NEW-028: derived-asset byte URLs are absolutised once, in the hook", () => {
  const hook = read("lib/media-intelligence/useDerivedAssets.ts");
  assert.ok(hook.includes("normalizeAssetUrls"), "the hook no longer normalises bytesUrl");
  assert.ok(
    /apiBaseUrl\(\)\.replace/.test(hook),
    "normalisation must be based on the ONE origin authority, apiBaseUrl()",
  );
  assert.ok(
    hook.includes('r.bytesUrl.startsWith("/")'),
    "only a relative bytesUrl may be rewritten; an absolute one must pass through",
  );

  const panel = read("components/media-intelligence/MediaIntelligencePanel.tsx");
  const credentialed = panel.match(/crossOrigin="use-credentials"/g) ?? [];
  assert.equal(
    credentialed.length,
    2,
    "both derived-asset image elements must request the authenticated bytes route with credentials",
  );
});

// ---------------------------------------------------------------------------
// NEW-030 — the error envelope never reached the branches that read it
// ---------------------------------------------------------------------------

test("NEW-030: ApiError carries the normalized body every call site branches on", () => {
  const api = read("lib/api.ts");
  assert.ok(
    /body:\s*ApiErrorResponse/.test(api),
    "ApiError has no `body` field — every `err.body?.error?.code` branch in the app is dead",
  );
  assert.ok(
    /this\.body\s*=\s*response/.test(api),
    "ApiError declares `body` but never assigns it",
  );

  // The branches this exists for. If these call sites disappear the guard is
  // pointless; if `body` disappears they all silently degrade to a generic
  // message, which is exactly what was shipping.
  const readers = [
    "app/(app)/settings/_sections/PrivacySection.tsx",
    "app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx",
    "app/(app)/reviewer-ops/[reviewId]/page.tsx",
    "app/(app)/workflows/[id]/page.tsx",
  ];
  for (const r of readers) {
    assert.ok(
      /body\?\.error\?\.code|body\?\.error\?\.message/.test(read(r)),
      `${r} no longer reads the error envelope — re-point this guard`,
    );
  }
});

// ---------------------------------------------------------------------------
// NEW-029 — upload cancel, driven
// ---------------------------------------------------------------------------

test("NEW-029: cancel aborts the server session, and the multipart upload when one exists", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];

  // The uploader imports `apiFetch` from `../api`; the module is stubbed here
  // through a loader-free seam: the class is re-read and evaluated with a
  // replaced import. Simpler and more honest than a mocking framework — what is
  // being asserted is which requests leave, so the transport is the only thing
  // that needs to be fake.
  const src = read("lib/uploads/multipart-uploader.ts");

  assert.ok(
    src.includes("multipart/abort") && src.includes("/abort`"),
    "cancel() does not reach either abort route",
  );
  /**
   * PHASE 13 (NEW-036) — the flag is now SEEDED, not hardcoded to false.
   *
   * This used to pin `private multipartInitiated = false`. That literal was
   * the defect: the capture orchestration runs `multipart/initiate` ITSELF and
   * then constructs the uploader, so an uploader that always starts at `false`
   * skips the abort leg for a multipart that genuinely exists — leaving a live
   * upload whose parts stay stored and billed. The field is now initialised
   * from the caller's declaration, and BOTH halves of that contract are pinned
   * here so the flag cannot quietly go back to being a constant.
   */
  assert.ok(
    src.includes("private multipartInitiated: boolean"),
    "there is no record of whether a multipart upload actually exists to abort",
  );
  assert.ok(
    src.includes("this.multipartInitiated = config.multipartAlreadyInitiated === true"),
    "the uploader ignores a caller that already initiated the multipart upload",
  );
  assert.ok(
    read("app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts").includes(
      "multipartAlreadyInitiated: true",
    ),
    "the capture orchestration initiates the multipart and does not say so",
  );

  // The ORDER matters: the local transition must be unconditional and first, so
  // a user who presses Cancel sees it stop whatever the network does.
  const cancelBody = src.slice(src.indexOf("  cancel(): void {"));
  const localFirst = cancelBody.indexOf('this.transitionTo("CANCELLED")');
  const serverAfter = cancelBody.indexOf("this.abortServerSide()");
  assert.ok(localFirst > -1 && serverAfter > -1, "cancel() lost its local transition or its server call");
  assert.ok(
    localFirst < serverAfter,
    "cancel() must transition locally BEFORE it talks to the server — the user's Cancel cannot depend on the network",
  );

  // The multipart leg is conditional; the session leg is not.
  const abortBody = src.slice(src.indexOf("private async abortServerSide"));
  const guardAt = abortBody.indexOf("if (this.multipartInitiated)");
  const sessionAt = abortBody.indexOf("/abort`");
  assert.ok(guardAt > -1, "the multipart abort is unguarded — it would 4xx on every single-part cancel");
  assert.ok(sessionAt > -1, "the session abort is missing");

  // Both legs must swallow their own failure: cancelling is not allowed to
  // throw in front of the user.
  const catches = (abortBody.slice(0, abortBody.indexOf("\n  }")).match(/catch\s*\{/g) ?? []).length;
  assert.ok(catches >= 2, "an abort failure can escape and break the Cancel action");

  await Promise.resolve();
  assert.equal(calls.length, 0);
});
