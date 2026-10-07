/**
 * REPORT & VERIFICATION-PACKAGE TRUTH — helpers over the disposable stack.
 *
 * Every helper acts through a product authority wherever one exists. Two
 * fixtures stand in for parties the disposable stack does not have, and say so:
 *
 *   * publishAndShare — the owner's interactive step-up approval for
 *     publishing and minting a share link; the product's own services
 *     (publishPublicVerify, createVerificationLink) run inside the API image.
 *   * provisionVerifiedOrganization — the sales-led Enterprise provisioning
 *     authority (inside the API image, against the stack database) and the
 *     organization-verification decision (one column).
 *
 * There is NO Bitcoin-chain fixture (2026-10-07): the stack has no trusted
 * Bitcoin verifier, and a fixture that WRITES a verified result proves nothing
 * about the chain. Anchoring stays PRESENT_NOT_INDEPENDENTLY_VERIFIED here, and
 * real chain verification is an external-proof item, not a passed journey.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { validatePackageConsistency, type PackageConsistencyFinding } from "@proovra/shared";

import { readZipEntries, sql, stackExec } from "./_stack";

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function nodeIn(service: "api" | "worker", script: string): string {
  return stackExec(service, ["node", "--input-type=module", "-e", script]);
}

/** FIXTURE (owner step-up): publish the record and mint a STANDARD share link; returns the token. */
export function publishAndShare(evidenceId: string, teamId: string, ownerUserId: string): string {
  const out = nodeIn(
    "api",
    `const pub = await import("/app/services/api/dist/services/governance/publication.service.js");
     const share = await import("/app/services/api/dist/services/governance/verification-share.service.js");
     await pub.publishPublicVerify({ evidenceId: ${JSON.stringify(evidenceId)}, teamId: ${JSON.stringify(teamId)}, actorUserId: ${JSON.stringify(ownerUserId)}, reason: "truth journey" });
     const record = await share.loadRecordForShare(${JSON.stringify(evidenceId)});
     const r = await share.createVerificationLink({ record, actorUserId: ${JSON.stringify(ownerUserId)}, audience: "truth journey", expiresInDays: 7, projection: "STANDARD", maxUses: null });
     console.log("TOKEN=" + r.token); process.exit(0);`,
  );
  const m = out.match(/TOKEN=(\S+)/);
  if (!m) throw new Error(`publishAndShare: no token in ${out}`);
  return m[1]!;
}

/** FIXTURE (sales-led provisioning + verification decision): a VERIFIED organization workspace. */
export function provisionVerifiedOrganization(ownerEmail: string): { organizationId: string; workspaceId: string } {
  const out = nodeIn(
    "api",
    `const { prisma } = await import("/app/services/api/dist/db.js");
     const ent = await import("/app/services/api/dist/services/enterprise-provisioning.service.js");
     const owner = await prisma.user.findFirst({ where: { email: ${JSON.stringify(ownerEmail.toLowerCase())} }, select: { id: true } });
     const r = await ent.provisionEnterpriseCustomer({ organizationName: "Truth Journey Verified Org", ownerEmail: ${JSON.stringify(ownerEmail)}, actorUserId: owner.id });
     console.log("ORG=" + JSON.stringify({ organizationId: r.organizationId, workspaceId: r.workspaceId })); process.exit(0);`,
  );
  const m = out.match(/ORG=(\{.*\})/);
  if (!m) throw new Error(`provisionVerifiedOrganization: ${out}`);
  const org = JSON.parse(m[1]!) as { organizationId: string; workspaceId: string };
  sql(`UPDATE teams SET verification_state = 'VERIFIED' WHERE id = $1`, [org.workspaceId]);
  return org;
}

export type ExtractedPackage = {
  zip: Buffer;
  entries: Map<string, Buffer>;
  texts: Map<string, string>;
  json: (path: string) => Record<string, unknown>;
  dir: string;
};

/** Extract a package to a temp folder (for the README commands) and index it. */
export function extractPackage(zip: Buffer, dir: string): ExtractedPackage {
  const entries = readZipEntries(zip) as Map<string, Buffer>;
  const texts = new Map<string, string>();
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of entries) {
    const p = join(dir, name);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, bytes);
    if (/\.(json|txt|md|sig|pem)$/.test(name)) texts.set(name, bytes.toString("utf8"));
  }
  return {
    zip,
    entries,
    texts,
    dir,
    json: (path) => {
      const t = texts.get(path);
      if (!t) throw new Error(`${path} is not in the package`);
      return JSON.parse(t) as Record<string, unknown>;
    },
  };
}

export function consistencyFindings(pkg: ExtractedPackage): PackageConsistencyFinding[] {
  const manifest = pkg.json("package-manifest.json");
  const seal = pkg.json("package-seal.json");
  return validatePackageConsistency({
    texts: new Map([...pkg.texts].filter(([k]) => /\.(json|txt|md)$/.test(k))),
    paths: [...pkg.entries.keys()],
    expect: {
      packageId: String(manifest.packageId),
      evidenceId: String(manifest.evidenceId),
      reportVersion: Number(manifest.reportVersion),
      disclosureProfile: manifest.disclosureProfile as "FULL_FORENSIC" | "EXTERNAL_DISCLOSURE",
      evidenceFileSha256: (seal.fileSha256 as string | null) ?? null,
    },
  });
}

/** Run one shell command (bash) in a folder; returns stdout, throws with output on failure. */
export function sh(dir: string, command: string): string {
  const run = spawnSync("bash", ["-c", command], { cwd: dir, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`\`${command}\` failed (${run.status}): ${run.stderr || run.stdout}`);
  return run.stdout;
}

/** Every line of the README's COMMANDS block that is a command (not a comment). */
export function readmeCommands(readme: string): string[] {
  const start = readme.indexOf("COMMANDS (copy and paste");
  const end = readme.indexOf("TIMESTAMP VERIFICATION LEVELS", start);
  return readme
    .slice(start, end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("COMMANDS") && !l.startsWith("Linux") && !/^(Every file|command;|package-seal\.json and)/.test(l));
}
