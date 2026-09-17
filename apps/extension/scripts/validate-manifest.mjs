/**
 * MV3 manifest lint. Enforces the least-privilege permission contract and the
 * "no remote code" / strict-CSP rules the store review requires. Runs against
 * the source manifest (public/manifest.json).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, "..", "public", "manifest.json"), "utf8"));

const problems = [];

if (manifest.manifest_version !== 3) problems.push("manifest_version must be 3");

const ALLOWED_PERMISSIONS = new Set(["activeTab", "scripting", "storage", "identity"]);
for (const p of manifest.permissions ?? []) {
  if (!ALLOWED_PERMISSIONS.has(p)) problems.push(`disallowed permission: ${p}`);
}
const FORBIDDEN = ["cookies", "webRequest", "webRequestBlocking", "history", "bookmarks", "clipboardRead", "debugger", "nativeMessaging", "tabs", "<all_urls>"];
for (const p of [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])]) {
  if (FORBIDDEN.includes(p)) problems.push(`forbidden permission requested: ${p}`);
}
if ((manifest.host_permissions ?? []).length > 0) {
  problems.push("host_permissions must be empty (activeTab is used instead)");
}

const csp = manifest.content_security_policy?.extension_pages ?? "";
if (!/script-src 'self'/.test(csp)) problems.push("CSP must set script-src 'self' (no remote code)");
if (/http:|https:|unsafe-eval|unsafe-inline/.test(csp)) problems.push("CSP must not allow remote or unsafe code");
if (!manifest.background?.service_worker) problems.push("background.service_worker is required");
if (manifest.background?.type !== "module") problems.push("background must be an ES module");

if (problems.length > 0) {
  console.error("MV3 manifest lint FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("MV3 manifest lint OK — least privilege, strict CSP, no remote code.");
