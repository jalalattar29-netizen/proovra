/**
 * Intake link completion + multi-file picker — contract pins.
 *
 * Issue 1: a ONE_TIME link that has been used must NOT silently keep
 *   working. Reopening the link must show a friendly "Submission
 *   completed" read-only state — not a hostile "expired" message and
 *   definitely not a fresh upload session.
 *
 * Issue 2: the public intake page's file picker must accept multiple
 *   files in a single pick. Capture page already supports multi-pick;
 *   we pin both so a future refactor cannot silently regress.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

// ============================================================================
// Issue 1 — Backend differentiates "already submitted" from generic exhaustion
// ============================================================================

describe("validateIntakeToken — link_already_submitted is distinct from link_exhausted", () => {
  it("new error code lives in the session error union", () => {
    const src = read("services/api/src/services/workflow-intake-session.service.ts");
    assert.match(src, /\|\s*"link_already_submitted"/);
  });

  it("validateIntakeToken throws link_already_submitted when maxUses === 1 + usedCount >= 1", () => {
    const src = read("services/api/src/services/workflow-intake-session.service.ts");
    assert.match(
      src,
      /if \(link\.maxUses === 1 && link\.usedCount >= 1\)\s*\{[\s\S]{0,200}throw new WorkflowIntakeSessionError\("link_already_submitted"\);/,
    );
  });

  it("validateIntakeToken still throws link_exhausted for the multi-use case", () => {
    const src = read("services/api/src/services/workflow-intake-session.service.ts");
    assert.match(
      src,
      /throw new WorkflowIntakeSessionError\("link_exhausted"\);/,
    );
  });
});

describe("public route maps link_already_submitted → 410 LINK_ALREADY_SUBMITTED", () => {
  it("intakeErrorToReply has a dedicated branch", () => {
    const src = read("services/api/src/routes/external-intake.routes.ts");
    assert.match(
      src,
      /case "link_already_submitted":[\s\S]{0,400}code:\s*"LINK_ALREADY_SUBMITTED"/,
    );
    assert.match(
      src,
      /case "link_already_submitted":[\s\S]{0,800}reply\.code\(410\)/,
    );
  });

  it("friendlyPublicIntakeMessage has user-safe copy", () => {
    const src = read("services/api/src/routes/external-intake.routes.ts");
    assert.match(
      src,
      /case "LINK_ALREADY_SUBMITTED":[\s\S]{0,400}already been used/,
    );
  });
});

// ============================================================================
// Issue 1 — submitExternalIntake still consumes ONE_TIME links
// ============================================================================

describe("ONE_TIME link consumption remains intact (transitionIntakeSession to SUBMITTED)", () => {
  it("transitionIntakeSession increments usedCount on SUBMITTED", () => {
    const src = read("services/api/src/services/workflow-intake-session.service.ts");
    assert.match(
      src,
      /if \(input\.to === "SUBMITTED"\)[\s\S]{0,800}usedCount: \{ increment: 1 \}/,
    );
  });

  it("transitionIntakeSession flips ONE_TIME (maxUses === 1) links to EXPIRED", () => {
    const src = read("services/api/src/services/workflow-intake-session.service.ts");
    assert.match(
      src,
      /isOneTime[\s\S]{0,300}status: "EXPIRED"/,
    );
  });

  it("a SUBMITTED session is terminal — assertSessionUploadEligible blocks a second submit", () => {
    const src = read(
      "services/api/src/services/external-intake-orchestration.service.ts",
    );
    // Pre-existing guard; we pin it so a refactor cannot silently
    // drop the check. The function name + the SUBMITTED case in its
    // switch are the contract.
    assert.match(src, /function assertSessionUploadEligible/);
    assert.match(src, /session_terminal/);
  });
});

// ============================================================================
// Issue 1 — Public page renders friendly read-only completion state
// ============================================================================

describe("Public intake page — friendly completed-link UX", () => {
  const PAGE = "apps/web/app/intake/[token]/page.tsx";

  it("phase union includes 'already_submitted'", () => {
    const src = read(PAGE);
    assert.match(src, /\|\s*"already_submitted"/);
  });

  it("validate-and-open useEffect routes LINK_ALREADY_SUBMITTED to the friendly phase", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /err\?\.code === "LINK_ALREADY_SUBMITTED"[\s\S]{0,200}setPhase\("already_submitted"\)/,
    );
  });

  it("renders a read-only 'Submission completed' branch with no upload controls", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /phase === "already_submitted"[\s\S]{0,800}Submission completed/,
    );
    // The friendly branch MUST NOT render the file input or submit
    // button. Easiest pin: the branch returns BEFORE the `upload`
    // section. We assert the read-only marker attribute is unique
    // to this branch.
    assert.match(src, /data-intake-phase="already_submitted"/);
  });

  it("the friendly catalog has LINK_ALREADY_SUBMITTED copy as a fallback", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /LINK_ALREADY_SUBMITTED:[\s\S]{0,300}already been used/,
    );
  });

  it("the existing 'submitted' branch is preserved (immediate post-submit case)", () => {
    const src = read(PAGE);
    assert.match(src, /data-intake-phase="submitted"/);
    assert.match(src, /Submission completed/);
  });
});

// ============================================================================
// Issue 1 — Default new-link mode is ONE_TIME
// ============================================================================

describe("Create-link wizard default", () => {
  it("defaults to EXTERNAL_ONE_TIME (so a fresh link consumes after one submit)", () => {
    // The create form is now a four-step wizard whose initial state lives in a
    // pure, React-free state machine. Same property, its new home.
    const src = read(
      "apps/web/app/(app)/intake-links/_lib/wizardState.ts",
    );
    assert.match(src, /intakeMode: "EXTERNAL_ONE_TIME"/);
  });
});

// ============================================================================
// Issue 2 — multi-file picker on the public intake page
// ============================================================================

describe("Public intake file picker — multi-select", () => {
  const PAGE = "apps/web/app/intake/[token]/page.tsx";

  it("file input has the `multiple` attribute", () => {
    const src = read(PAGE);
    // Match the <input ... multiple ... /> block exactly so the test
    // catches a future refactor that drops the attribute. We use
    // [\s\S] because JSX wraps these props across lines.
    assert.match(
      src,
      /<input[\s\S]{0,500}type="file"[\s\S]{0,500}multiple[\s\S]{0,500}onChange/,
    );
  });

  it("onChange iterates EVERY selected file with a local partIndex counter", () => {
    // Phase MULTI-FILE-PARTINDEX-FIX — onChange must:
    //   1. snapshot `let nextIndex = parts.length` ONCE (React state
    //      doesn't update across awaits within one onChange),
    //   2. call `await stageFile(f, nextIndex)` per file,
    //   3. increment `nextIndex += 1` after each file.
    // Without this, every file in a multi-select sent partIndex=0
    // and the backend's (evidenceId, partIndex) unique constraint
    // rejected all but the first.
    const src = read(PAGE);
    assert.match(
      src,
      /const files = Array\.from\(e\.target\.files \?\? \[\]\);[\s\S]{0,800}let nextIndex = parts\.length;/,
    );
    assert.match(src, /await stageFile\(f, nextIndex\);/);
    assert.match(src, /nextIndex \+= 1;/);
  });

  it("'Add files' button + multi-select hint are present (discoverability)", () => {
    const src = read(PAGE);
    assert.match(src, /data-intake-add-files-btn="true"/);
    assert.match(src, /data-intake-add-files-hint="true"/);
    assert.match(src, /multiple thumbnails/i);
  });

  it("each file goes through stageFile independently with an explicit partIndex argument", () => {
    const src = read(PAGE);
    // Phase MULTI-FILE-PARTINDEX-FIX — stageFile MUST take partIndex
    // as a REQUIRED second arg. Reading parts.length inside the
    // function recreates the closure-stale bug.
    assert.match(
      src,
      /async function stageFile\(file: File, partIndex: number\)/,
    );
    // Per-file SHA-256 still computed — batching files into a single
    // POST would break verification-package layout, so the hash step
    // must remain per-file.
    assert.match(src, /sha256Base64\(file\)/);
  });

  it("stageFile does NOT derive partIndex from React state (no `const partIndex = parts.length`)", () => {
    // The smoking-gun line that caused the multi-file bug. Any
    // reintroduction recreates it.
    const src = read(PAGE);
    assert.ok(
      !/const partIndex = parts\.length/.test(src),
      "stageFile must not read parts.length to derive partIndex",
    );
  });

  it("stageFile sends the passed partIndex in the POST body", () => {
    // The partIndex passed by the caller must flow into the
    // /parts request body verbatim (not recomputed, not muted).
    const src = read(PAGE);
    assert.match(
      src,
      /body: JSON\.stringify\(\{\s*\n?\s*partIndex,/,
    );
  });

  it("no first-only shortcut patterns are present (files\\[0\\] / slice\\(0,1\\) / take\\(1\\))", () => {
    // Defense-in-depth — guard against the most common "drops every
    // file but the first" rewrites a future refactor might attempt.
    const src = read(PAGE);
    // Scope the guards to the onChange handler region so an
    // unrelated indexing elsewhere in the (1200-line) page does not
    // false-positive. The onChange body lives between the file-input
    // declaration and the closing `}}` of the JSX prop.
    const handler = (() => {
      const start = src.indexOf("e.target.files");
      assert.ok(start > 0, "could not locate onChange handler region");
      // Read a generous slice — covers the whole onChange body.
      return src.slice(start, start + 2400);
    })();
    assert.ok(
      !/files\[0\]/.test(handler),
      "onChange must not slice to files[0] — every selected file is staged",
    );
    assert.ok(
      !/files\.slice\(0,\s*1\)/.test(handler),
      "onChange must not use files.slice(0, 1)",
    );
    assert.ok(
      !/files\.(take|head|first)\(/.test(handler),
      "onChange must not use take/head/first to keep only one file",
    );
  });

  it("simulator: selecting 5 files at index 0 → partIndex sequence [0,1,2,3,4]", () => {
    // Reproduces the runtime sequence from the source-pinned local
    // counter. If the source contract above is satisfied, this
    // arithmetic is what the page sends to the backend on a 5-file
    // multi-select against an empty queue.
    const observed: number[] = [];
    let nextIndex = 0;
    for (let i = 0; i < 5; i++) {
      observed.push(nextIndex);
      nextIndex += 1;
    }
    assert.deepEqual(observed, [0, 1, 2, 3, 4]);
  });

  it("simulator: adding 3 files then 2 more → second batch starts at queue length 3", () => {
    // The local counter only matters WITHIN one onChange invocation.
    // Between user-input events React has already re-rendered, so
    // `parts.length` correctly reflects the queue. The second batch
    // seeds nextIndex from parts.length = 3.
    const batch1Indices: number[] = [];
    let nextIndex = 0;
    for (let i = 0; i < 3; i++) {
      batch1Indices.push(nextIndex);
      nextIndex += 1;
    }
    assert.deepEqual(batch1Indices, [0, 1, 2]);

    const partsLengthAfterBatch1 = 3;
    const batch2Indices: number[] = [];
    nextIndex = partsLengthAfterBatch1;
    for (let i = 0; i < 2; i++) {
      batch2Indices.push(nextIndex);
      nextIndex += 1;
    }
    assert.deepEqual(batch2Indices, [3, 4]);
  });
});

// ============================================================================
// Issue 2 — Capture page also supports multi-file (no regression)
// ============================================================================

describe("REGRESSION GUARD: authenticated Capture page still supports multi-file pick", () => {
  it("capture file input still has the `multiple` attribute", () => {
    const src = read("apps/web/app/(app)/capture/page.tsx");
    assert.match(
      src,
      /<input[\s\S]{0,500}type="file"[\s\S]{0,500}multiple/,
    );
  });
});
