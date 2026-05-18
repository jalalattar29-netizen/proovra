import test from "node:test";
import assert from "node:assert/strict";

// Phase 11 — Security hardening shared-types contract tests.
//
// Coverage:
//   - magic-bytes sniffing (signatures, RIFF disambiguation, executables)
//   - dangerous extension / MIME blocklist
//   - double-extension detection
//   - classifier outcomes: block / warn / allow
//   - URL validation against SSRF (private networks, IPv4-mapped IPv6)
//   - event catalog membership

import {
  FILE_SECURITY_SCAN_STATUSES,
  SECURITY_EVENT_SEVERITIES,
  SECURITY_EVENT_TYPES,
  classifyFileValidation,
  hasDoubleExtension,
  isDangerousExtension,
  isDangerousMimeType,
  sniffFileType,
  validateWebhookUrl,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Magic-bytes sniffing
// -----------------------------------------------------------------------------

function bytes(...arr) {
  return new Uint8Array(arr);
}

test("sniffFileType — PNG", () => {
  const r = sniffFileType(
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0),
  );
  assert.equal(r.mime, "image/png");
  assert.equal(r.executable, false);
});

test("sniffFileType — JPEG", () => {
  const r = sniffFileType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0));
  assert.equal(r.mime, "image/jpeg");
});

test("sniffFileType — PDF", () => {
  const r = sniffFileType(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34));
  assert.equal(r.mime, "application/pdf");
});

test("sniffFileType — ZIP", () => {
  const r = sniffFileType(bytes(0x50, 0x4b, 0x03, 0x04, 0, 0));
  assert.equal(r.mime, "application/zip");
});

test("sniffFileType — Windows EXE is executable=true", () => {
  const r = sniffFileType(bytes(0x4d, 0x5a, 0x90, 0, 0, 0));
  assert.equal(r.mime, "application/x-msdownload");
  assert.equal(r.executable, true);
});

test("sniffFileType — ELF binary is executable=true", () => {
  const r = sniffFileType(bytes(0x7f, 0x45, 0x4c, 0x46, 0, 0));
  assert.equal(r.mime, "application/x-elf");
  assert.equal(r.executable, true);
});

test("sniffFileType — Mach-O binary (LE 64) is executable=true", () => {
  const r = sniffFileType(bytes(0xcf, 0xfa, 0xed, 0xfe, 0, 0));
  assert.equal(r.mime, "application/x-mach-binary");
  assert.equal(r.executable, true);
});

test("sniffFileType — Java class is executable=true", () => {
  const r = sniffFileType(bytes(0xca, 0xfe, 0xba, 0xbe, 0, 0));
  assert.equal(r.executable, true);
});

test("sniffFileType — RIFF disambiguation: WAV", () => {
  const r = sniffFileType(
    bytes(
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0,
      0,
      0,
      0, // size (don't care)
      0x57,
      0x41,
      0x56,
      0x45, // "WAVE"
    ),
  );
  assert.equal(r.mime, "audio/wav");
});

test("sniffFileType — RIFF disambiguation: WebP", () => {
  const r = sniffFileType(
    bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50),
  );
  assert.equal(r.mime, "image/webp");
});

test("sniffFileType — unknown bytes returns null", () => {
  const r = sniffFileType(bytes(0x00, 0x00, 0x00, 0x00));
  assert.equal(r.mime, null);
  assert.equal(r.executable, false);
});

// -----------------------------------------------------------------------------
// Dangerous extension / MIME / double extension
// -----------------------------------------------------------------------------

test("isDangerousExtension — common executable extensions", () => {
  for (const name of ["foo.exe", "bar.bat", "x.cmd", "y.scr", "evil.msi"]) {
    assert.equal(isDangerousExtension(name), true, name);
  }
});

test("isDangerousExtension — benign extensions are not flagged", () => {
  for (const name of ["picture.jpg", "scan.pdf", "video.mp4", "audio.wav"]) {
    assert.equal(isDangerousExtension(name), false, name);
  }
});

test("isDangerousMimeType — Windows PE", () => {
  assert.equal(isDangerousMimeType("application/x-msdownload"), true);
  assert.equal(isDangerousMimeType("application/vnd.microsoft.portable-executable"), true);
});

test("isDangerousMimeType — image/png is benign", () => {
  assert.equal(isDangerousMimeType("image/png"), false);
});

test("hasDoubleExtension — picks up report.pdf.exe", () => {
  assert.equal(hasDoubleExtension("report.pdf.exe"), true);
  assert.equal(hasDoubleExtension("photo.jpg.exe"), true);
  assert.equal(hasDoubleExtension("audio.mp3.zip"), true);
});

test("hasDoubleExtension — benign double extensions are not flagged", () => {
  assert.equal(hasDoubleExtension("report.v2.pdf"), false);
  assert.equal(hasDoubleExtension("photo.thumb.jpg"), false);
});

// -----------------------------------------------------------------------------
// Classifier — combined outcomes
// -----------------------------------------------------------------------------

test("classifyFileValidation — PE renamed to .jpg is BLOCKED", () => {
  const result = classifyFileValidation({
    claimedMime: "image/jpeg",
    fileName: "innocent.jpg",
    head: bytes(0x4d, 0x5a, 0x90, 0, 0, 0),
  });
  assert.equal(result.mismatch, "block");
  assert.equal(result.executable, true);
});

test("classifyFileValidation — double-extension blocks", () => {
  const result = classifyFileValidation({
    claimedMime: "application/pdf",
    fileName: "report.pdf.exe",
    head: bytes(0x25, 0x50, 0x44, 0x46, 0x2d),
  });
  assert.equal(result.mismatch, "block");
  assert.equal(result.doubleExtension, true);
});

test("classifyFileValidation — claimed image/png + actual PDF bytes warns", () => {
  const result = classifyFileValidation({
    claimedMime: "image/png",
    fileName: "page.pdf",
    head: bytes(0x25, 0x50, 0x44, 0x46, 0x2d),
  });
  assert.equal(result.mismatch, "warn");
});

test("classifyFileValidation — matching MIME family is allow", () => {
  const result = classifyFileValidation({
    claimedMime: "image/jpeg",
    fileName: "photo.jpg",
    head: bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0),
  });
  assert.equal(result.mismatch, "none");
});

test("classifyFileValidation — empty head with dangerous extension still blocks", () => {
  const result = classifyFileValidation({
    claimedMime: "image/jpeg",
    fileName: "innocent.exe",
    head: bytes(),
  });
  assert.equal(result.mismatch, "block");
});

// -----------------------------------------------------------------------------
// URL validation — SSRF
// -----------------------------------------------------------------------------

test("validateWebhookUrl — rejects IPv4-mapped IPv6 loopback", () => {
  const r = validateWebhookUrl("https://[::ffff:127.0.0.1]/hook");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "private_network_blocked");
});

test("validateWebhookUrl — rejects 0.0.0.0", () => {
  const r = validateWebhookUrl("https://0.0.0.0/hook");
  assert.equal(r.ok, false);
});

test("validateWebhookUrl — rejects CGNAT range 100.64.0.0/10", () => {
  const r = validateWebhookUrl("https://100.64.1.2/hook");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "private_network_blocked");
});

test("validateWebhookUrl — accepts a normal HTTPS hostname", () => {
  const r = validateWebhookUrl("https://hooks.example.com/proovra");
  assert.equal(r.ok, true);
});

// -----------------------------------------------------------------------------
// Catalogs
// -----------------------------------------------------------------------------

test("FILE_SECURITY_SCAN_STATUSES has the five canonical statuses", () => {
  assert.deepEqual([...FILE_SECURITY_SCAN_STATUSES].sort(), [
    "CLEAN",
    "FAILED",
    "PENDING",
    "SKIPPED",
    "SUSPICIOUS",
  ]);
});

test("SECURITY_EVENT_SEVERITIES is INFO/WARNING/HIGH", () => {
  assert.deepEqual([...SECURITY_EVENT_SEVERITIES].sort(), [
    "HIGH",
    "INFO",
    "WARNING",
  ]);
});

test("SECURITY_EVENT_TYPES contains expected canonical events", () => {
  for (const t of [
    "executable_upload_blocked",
    "mime_mismatch",
    "double_extension_detected",
    "suspicious_archive",
    "archive_limit_exceeded",
    "webhook_unsafe_redirect",
    "webhook_target_blocked",
    "scanner_unavailable",
  ]) {
    assert.ok(
      SECURITY_EVENT_TYPES.includes(t),
      `expected ${t} in SECURITY_EVENT_TYPES`,
    );
  }
});
