/**
 * Intake-link client-signals — server-side heuristic + wire contract.
 *
 * This file pins THREE separate guarantees:
 *
 *   1. Behavioural — the screenshot heuristic detects every brief-
 *      named locale pattern (English/German/French/Spanish) AND does
 *      NOT false-flag camera / WhatsApp filenames.
 *   2. Privacy — the folder-path sanitiser refuses absolute OS
 *      paths, traversal tokens, and anything that smells like a
 *      local filesystem. Top-level folder name only.
 *   3. Wire — the intake-link part-create endpoint accepts
 *      `webkitRelativePath` and the submit endpoint accepts
 *      `deviceTime`; orchestration persists clientSignals via the
 *      shared helper and writes Evidence.deviceTimeIso after
 *      completeEvidence.
 *
 * Tests run under vitest (services/api/test/* convention) — they
 * import the shared helpers directly because the shared package
 * compiles to ESM and the API test harness already resolves it.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  buildIntakeClientSignals,
  extractSafeTopLevelFolderName,
  isScreenshotLikeFileName,
  sanitizeClientDeviceTimeIso,
  sanitizeClientTimezone,
  sanitizeClientTimezoneOffsetMinutes,
} from "@proovra/shared";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

// ============================================================================
// Screenshot heuristic — recognises real screenshots
// ============================================================================

describe("isScreenshotLikeFileName — locale-aware DETECTION", () => {
  const positives: Array<[string, string]> = [
    ["English explicit", "Screenshot 2025-01-15 at 14.30.00.png"],
    ["English no space", "screenshot.png"],
    ["English with space", "screen shot 2025-01-15.png"],
    ["English with dash", "screen-shot-2025.png"],
    ["English capture", "Screen Capture 2025.png"],
    ["English capture no space", "screencapture.png"],
    ["English screencap shorthand", "screencap-001.png"],
    ["English recording", "Screen Recording 2025-01-15.mp4"],
    ["English recording compact", "screenrecording.mp4"],
    ["English record short", "screenrec_001.mp4"],
    ["German Bildschirmfoto", "Bildschirmfoto 2025-01-15 um 14.30.30.png"],
    ["German Bildschirmaufnahme", "Bildschirmaufnahme 2025-01-15.mov"],
    ["French capture d'écran", "Capture d'écran 2025-01-15.png"],
    ["French capture d ecran", "capture d ecran 2025.png"],
    ["Spanish captura de pantalla", "Captura de pantalla 2025-01-15.png"],
  ];
  for (const [label, name] of positives) {
    it(`detects ${label}: "${name}"`, () => {
      assert.equal(isScreenshotLikeFileName(name), true);
    });
  }
});

// ============================================================================
// Screenshot heuristic — does NOT false-flag camera / WhatsApp / generic
// ============================================================================

describe("isScreenshotLikeFileName — NEVER flags normal camera/WhatsApp/document names", () => {
  const negatives: Array<[string, string]> = [
    ["generic iOS camera", "IMG_0001.jpg"],
    ["generic iOS upper", "IMG_4521.JPG"],
    ["DSLR Nikon", "DSC_0001.JPG"],
    ["DSLR Canon", "IMG_4521.CR2"],
    ["WhatsApp Android image", "IMG-20250115-WA0001.jpg"],
    ["WhatsApp Android video", "VID-20250115-WA0001.mp4"],
    ["WhatsApp iOS image", "WhatsApp Image 2025-01-15 at 14.30.00.jpeg"],
    ["WhatsApp iOS video", "WhatsApp Video 2025-01-15 at 14.30.00.mp4"],
    ["Pixel default", "20250115_143030.jpg"],
    ["Pixel modern", "PXL_20250115_143030.jpg"],
    ["Generic PDF", "Invoice-2025-01-15.pdf"],
    ["Generic doc", "Contract.docx"],
    ["Receipt scan", "receipt-2025-01-15.pdf"],
    ["Empty string", ""],
    ["Whitespace only", "   "],
  ];
  for (const [label, name] of negatives) {
    it(`does NOT flag ${label}: "${name}"`, () => {
      assert.equal(isScreenshotLikeFileName(name), false);
    });
  }
});

// ============================================================================
// Folder-path safety — only safe top-level names, never absolute paths
// ============================================================================

describe("extractSafeTopLevelFolderName — privacy guard", () => {
  it("returns the top-level folder name from a relative path", () => {
    assert.equal(
      extractSafeTopLevelFolderName("VacationPhotos/IMG_0001.jpg"),
      "VacationPhotos",
    );
  });
  it("never returns subfolder names", () => {
    assert.equal(
      extractSafeTopLevelFolderName("Photos/2025/Vacation/IMG_0001.jpg"),
      "Photos",
    );
  });
  it("rejects POSIX absolute paths (no /Users/... ever leaves)", () => {
    assert.equal(extractSafeTopLevelFolderName("/Users/alice/photos/x.jpg"), null);
    assert.equal(extractSafeTopLevelFolderName("/home/bob/secret/x.jpg"), null);
    assert.equal(extractSafeTopLevelFolderName("/var/log/auth.log"), null);
  });
  it("rejects Windows drive letters (C:\\, D:/, ...)", () => {
    assert.equal(extractSafeTopLevelFolderName("C:\\Users\\alice\\x.jpg"), null);
    assert.equal(extractSafeTopLevelFolderName("D:/Photos/x.jpg"), null);
  });
  it("rejects UNC paths (\\\\server\\share)", () => {
    assert.equal(extractSafeTopLevelFolderName("\\\\fileserver\\share\\x.jpg"), null);
  });
  it("rejects path-traversal tokens", () => {
    assert.equal(extractSafeTopLevelFolderName("../etc/passwd"), null);
    assert.equal(extractSafeTopLevelFolderName("foo/../../bar"), null);
  });
  it("returns null when there is no separator (single-file upload)", () => {
    assert.equal(extractSafeTopLevelFolderName("file.jpg"), null);
  });
  it("returns null on empty / null / undefined / non-string", () => {
    assert.equal(extractSafeTopLevelFolderName(""), null);
    assert.equal(extractSafeTopLevelFolderName(null), null);
    assert.equal(extractSafeTopLevelFolderName(undefined), null);
    assert.equal(extractSafeTopLevelFolderName(42 as unknown as string), null);
  });
  it("caps name at 80 characters (no audit-row bloat)", () => {
    const long = "a".repeat(200) + "/file.jpg";
    const out = extractSafeTopLevelFolderName(long);
    assert.ok(out !== null);
    assert.ok(out!.length <= 80);
  });
});

// ============================================================================
// buildIntakeClientSignals — composed contract
// ============================================================================

describe("buildIntakeClientSignals — composed shape per intake-link policy", () => {
  it("always computes screenshotLike from the filename (never trusts client booleans)", () => {
    const out = buildIntakeClientSignals({
      originalFileName: "Screenshot 2025.png",
      webkitRelativePath: null,
    });
    assert.equal(out.screenshotLike, true);
    assert.ok(!("folderPathPresent" in out));
    assert.ok(!("topLevelFolderName" in out));
  });
  it("emits folder context only when a safe top-level name resolves", () => {
    const out = buildIntakeClientSignals({
      originalFileName: "IMG_0001.jpg",
      webkitRelativePath: "Vacation 2025/IMG_0001.jpg",
    });
    assert.equal(out.screenshotLike, false);
    assert.equal(out.folderPathPresent, true);
    assert.equal(out.topLevelFolderName, "Vacation 2025");
  });
  it("never emits folder context when the path looks like an OS absolute path", () => {
    const out = buildIntakeClientSignals({
      originalFileName: "IMG_0001.jpg",
      webkitRelativePath: "/Users/alice/Vacation/IMG_0001.jpg",
    });
    assert.ok(!("folderPathPresent" in out));
    assert.ok(!("topLevelFolderName" in out));
  });
});

// ============================================================================
// Device-time sanitisers
// ============================================================================

describe("sanitizeClientDeviceTimeIso", () => {
  const NOW = new Date("2026-06-20T12:00:00.000Z");
  it("accepts a well-formed ISO inside the clock-skew window", () => {
    assert.equal(
      sanitizeClientDeviceTimeIso("2026-06-20T11:59:00.000Z", NOW),
      "2026-06-20T11:59:00.000Z",
    );
  });
  it("rejects strings longer than 64 chars", () => {
    assert.equal(sanitizeClientDeviceTimeIso("a".repeat(65), NOW), null);
  });
  it("rejects garbage", () => {
    assert.equal(sanitizeClientDeviceTimeIso("not-a-date", NOW), null);
    assert.equal(sanitizeClientDeviceTimeIso("", NOW), null);
    assert.equal(sanitizeClientDeviceTimeIso(null, NOW), null);
    assert.equal(sanitizeClientDeviceTimeIso(undefined, NOW), null);
  });
  it("rejects timestamps more than 7 days in the future (clock skew)", () => {
    assert.equal(
      sanitizeClientDeviceTimeIso("2030-01-01T00:00:00.000Z", NOW),
      null,
    );
  });
  it("rejects negative epoch", () => {
    assert.equal(sanitizeClientDeviceTimeIso("1969-12-31T23:59:00.000Z", NOW), null);
  });
});

describe("sanitizeClientTimezone", () => {
  it("accepts IANA identifiers", () => {
    assert.equal(sanitizeClientTimezone("Europe/London"), "Europe/London");
    assert.equal(sanitizeClientTimezone("America/New_York"), "America/New_York");
    assert.equal(sanitizeClientTimezone("Etc/GMT+5"), "Etc/GMT+5");
  });
  it("rejects values with disallowed characters", () => {
    assert.equal(sanitizeClientTimezone("Europe/London;DROP TABLE"), null);
    assert.equal(sanitizeClientTimezone("<script>"), null);
    assert.equal(sanitizeClientTimezone(""), null);
    assert.equal(sanitizeClientTimezone(null), null);
  });
});

describe("sanitizeClientTimezoneOffsetMinutes", () => {
  it("accepts realistic offsets", () => {
    assert.equal(sanitizeClientTimezoneOffsetMinutes(0), 0);
    assert.equal(sanitizeClientTimezoneOffsetMinutes(-480), -480); // PST
    assert.equal(sanitizeClientTimezoneOffsetMinutes(540), 540); // JST
  });
  it("rejects absurd values", () => {
    assert.equal(sanitizeClientTimezoneOffsetMinutes(9999), null);
    assert.equal(sanitizeClientTimezoneOffsetMinutes(-9999), null);
    assert.equal(sanitizeClientTimezoneOffsetMinutes(NaN), null);
    assert.equal(sanitizeClientTimezoneOffsetMinutes(null), null);
  });
});

// ============================================================================
// Wire pins — route + orchestration accept the new fields
// ============================================================================

describe("Intake-link routes + orchestration wire the new signals", () => {
  it("part-create Zod schema accepts webkitRelativePath", () => {
    const src = read("services/api/src/routes/external-intake.routes.ts");
    assert.match(
      src,
      /webkitRelativePath: z\.string\(\)\.max\(1024\)\.nullable\(\)\.optional\(\)/,
    );
  });
  it("part-create route threads webkitRelativePath into addExternalEvidencePart", () => {
    const src = read("services/api/src/routes/external-intake.routes.ts");
    assert.match(
      src,
      /webkitRelativePath:\s*body\.webkitRelativePath\s*\?\?\s*null/,
    );
  });
  it("submit Zod schema accepts deviceTime block", () => {
    const src = read("services/api/src/routes/external-intake.routes.ts");
    assert.match(src, /const SubmitDeviceTimeBody = z/);
    assert.match(src, /deviceTime: SubmitDeviceTimeBody/);
    assert.match(src, /deviceTimeIso: z\.string\(\)\.max\(64\)\.optional\(\)/);
  });
  it("submit handler forwards deviceTime to submitExternalIntake", () => {
    const src = read("services/api/src/routes/external-intake.routes.ts");
    assert.match(
      src,
      /submitExternalIntake\(\{[\s\S]{0,300}deviceTime,/,
    );
  });
  it("addExternalEvidencePart writes server-computed clientSignals", () => {
    const src = read("services/api/src/services/external-intake-orchestration.service.ts");
    assert.match(src, /buildIntakeClientSignals\(\{/);
    assert.match(src, /clientSignals: clientSignals as Prisma\.InputJsonValue/);
  });
  it("submitExternalIntake sanitises deviceTime + writes Evidence.deviceTimeIso ONLY on success", () => {
    const src = read("services/api/src/services/external-intake-orchestration.service.ts");
    assert.match(src, /sanitizeClientDeviceTimeIso\(/);
    assert.match(src, /sanitizeClientTimezone\(/);
    assert.match(src, /sanitizeClientTimezoneOffsetMinutes\(/);
    // Conditional write only if sanitiser accepts the value.
    assert.match(
      src,
      /if \(cleanDeviceTimeIso\)[\s\S]{0,200}data: \{ deviceTimeIso: cleanDeviceTimeIso \}/,
    );
  });
});

// ============================================================================
// Wire pins — public intake page sends the new signals
// ============================================================================

describe("Public intake page wires the contributor-side context", () => {
  it("part create body includes webkitRelativePath (null when not from folder picker)", () => {
    const src = read("apps/web/app/intake/[token]/page.tsx");
    assert.match(src, /webkitRelativePath: relativePath/);
  });
  it("only reads file.webkitRelativePath — never any absolute path API", () => {
    const src = read("apps/web/app/intake/[token]/page.tsx");
    // The ONLY path source the page may read is webkitRelativePath.
    // No usage of `file.path`, `file.fullPath`, or `File.prototype.name`
    // joined with anything path-like.
    assert.ok(
      !/file\.fullPath|file\.path[^N]/.test(src),
      "no other file path properties may be read from the public page",
    );
  });
  it("submit body includes deviceTime when Intl is available", () => {
    const src = read("apps/web/app/intake/[token]/page.tsx");
    assert.match(src, /const deviceTimeBody = \(\(\) => \{/);
    assert.match(src, /deviceTimeIso: now\.toISOString\(\)/);
    assert.match(src, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
    assert.match(src, /timezoneOffsetMinutes: now\.getTimezoneOffset\(\)/);
  });
  it("submit body only attaches deviceTime when the build succeeded (try/catch)", () => {
    const src = read("apps/web/app/intake/[token]/page.tsx");
    assert.match(src, /if \(deviceTimeBody\) submitBody\.deviceTime = deviceTimeBody;/);
  });
});

// ============================================================================
// Capture regression — the legacy capture path is unchanged
// ============================================================================

describe("REGRESSION GUARD: Capture still uses the existing client-side helper", () => {
  it("capture file-utils still exports isScreenshotLikeFileName + buildSessionItemSignals", () => {
    const src = read("apps/web/app/(app)/capture/_lib/file-utils.ts");
    assert.match(src, /export function isScreenshotLikeFileName/);
    assert.match(src, /export function buildSessionItemSignals/);
    assert.match(src, /screenshotLike: isScreenshotLikeFileName\(file\.name\)/);
  });
  it("authenticated capture submit still sends deviceTimeIso via createEvidence", () => {
    const src = read("services/api/src/services/evidence.service.ts");
    assert.match(src, /deviceTimeIso\?: string/);
  });
});
