/**
 * ADM-013 PHASE 2 — the production diagnostic's safety contract.
 *
 * ===========================================================================
 * WHY A SOURCE-CONTRACT TEST FOR A SCRIPT NOBODY IMPORTS
 * ===========================================================================
 * This script is copied onto a production host and run, by hand, against the
 * live database, by somebody under time pressure. Nothing in CI executes it and
 * nothing at runtime imports it, so the only thing standing between "read-only"
 * as a claim and "read-only" as a fact is a gate that reads the file.
 *
 * The properties below are the ones that cannot be recovered from once they are
 * wrong: a write that reached production, a secret that reached a JSON file
 * somebody forwarded, a profile of the wrong database read as the right one.
 *
 * The script's BEHAVIOUR was verified separately, by executing it against a
 * disposable PostgreSQL 16 database carrying the full canonical migration
 * chain, seeded with the exact shapes it exists to find. Those results are in
 * the commit message. What is here is the invariant that survives edits.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync("scripts/proovra-diagnostic.cjs", "utf8");

/** Comments stripped: a note explaining what it does NOT do is not a call. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("ADM-013 Phase 2 — the diagnostic cannot write", () => {
  it("calls no Prisma mutation, on any model", () => {
    // Enumerated rather than pattern-matched on "write": a new Prisma verb the
    // list does not know about would slip through a fuzzy check, and the list
    // is short enough to be complete.
    // Anchored on `prisma.<model>.<verb>(`, not on `.verb(`: the bare form
    // also matches `createHash("sha256").update(bytes)`, and a gate that
    // cannot tell a hash from a database write is a gate somebody disables.
    for (const verb of [
      "create",
      "createMany",
      "update",
      "updateMany",
      "upsert",
      "delete",
      "deleteMany",
    ]) {
      const call = new RegExp(String.raw`prisma\.\w+\.${verb}\(`);
      expect(CODE, `the diagnostic calls prisma.*.${verb}()`).not.toMatch(call);
    }
    // These take no model prefix, so they are matched directly.
    for (const raw of ["$executeRaw", "$executeRawUnsafe", "$transaction"]) {
      expect(CODE, `the diagnostic calls ${raw}()`).not.toContain(`${raw}(`);
    }
  });

  it("issues no write SQL in any raw query", () => {
    for (const sql of [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bCREATE\s+(TABLE|INDEX|UNIQUE)\b/i,
      /\bDROP\b/i,
      /\bALTER\b/i,
      /\bTRUNCATE\b/i,
      /\bGRANT\b/i,
    ]) {
      expect(CODE, `raw write matching ${sql}`).not.toMatch(sql);
    }
  });

  it("writes no file — the output goes to stdout and the shell redirects it", () => {
    // A file written INSIDE the container is lost on the next deploy, and a
    // file written on the host by the script rather than by the operator's
    // shell lands somewhere nobody chose.
    expect(CODE).not.toMatch(/writeFileSync|createWriteStream|appendFileSync/);
    expect(CODE).toMatch(/process\.stdout\.write/);
  });
});

describe("ADM-013 Phase 2 — the diagnostic selects no secret", () => {
  it("names no credential-shaped field in any select", () => {
    for (const field of [
      "passwordHash",
      "tokenHash",
      "sessionIdHash",
      "deviceIdHash",
      "refreshToken",
      "accessToken",
      "clientSecret",
      "secretCiphertext",
      "apiKeyHash",
      "signingKey",
      "privateKey",
      "webhookSecret",
      "recoveryCode",
      "mfaSecret",
    ]) {
      expect(CODE, `selects ${field}`).not.toContain(field);
    }
  });

  it("reads no evidence content", () => {
    // Not bytes, not the object key, not the filename, not the hash, not GPS.
    // `sha256` is deliberately absent from this list: the script hashes ITSELF
    // so a reader can tell whether the diag.json in front of them came from the
    // script in front of them, and a gate that forbade the string would forbid
    // that. The evidence hash columns are named individually instead.
    for (const field of [
      "storageKey",
      "objectKey",
      "contentHash",
      "sha256Hex",
      "fileHash",
      "originalFilename",
      "gpsLatitude",
      "gpsLongitude",
      "exif",
    ]) {
      expect(CODE, `reads evidence content field ${field}`).not.toContain(field);
    }
  });

  it("never emits a full IP address", () => {
    // The columns hold an already-hashed value, so only PRESENCE is reported.
    // A hash is a join key and exporting one buys nothing.
    expect(CODE).toMatch(/originRecorded/);
    expect(CODE).not.toMatch(/ipPreview/);
    // The /24 + /48 reducer stays available for any column that does hold a
    // raw address, and is defined so a future reader reaches for it rather
    // than for the raw value.
    expect(SRC).toMatch(/function ipPrefix/);
    expect(SRC).toMatch(/\/24/);
    expect(SRC).toMatch(/\/48/);
  });

  it("emits no raw user or workspace id", () => {
    // Every id goes through a per-run HMAC. Same token within a run, so two
    // sections correlate; a different token across runs, so a token in a
    // diag.json somebody kept cannot be joined back to a person.
    expect(SRC).toMatch(/const RUN_SALT = crypto\.randomBytes/);
    expect(SRC).toMatch(/createHmac\("sha256", RUN_SALT\)/);
    // The salt is used ONLY as an HMAC key. Two references — the definition
    // and the one `createHmac` call — and nothing else can reach it, so it
    // cannot be serialised into the output.
    const saltRefs = [...CODE.matchAll(/RUN_SALT/g)];
    expect(
      saltRefs,
      "RUN_SALT is referenced somewhere other than its definition and the HMAC — a leaked salt makes every pseudonym reversible",
    ).toHaveLength(2);
    for (const call of [
      "pseudonym(user.id",
      'pseudonym(m.teamId, "ws")',
      'pseudonym(r.teamId, "ws")',
      'pseudonym(i.teamId, "ws")',
    ]) {
      expect(CODE, `${call} missing`).toContain(call);
    }
  });

  it("reduces an email to its domain", () => {
    expect(CODE).toMatch(/emailDomain\(user\.email\)/);
    // The local part must not reach the OUTPUT. It legitimately appears in a
    // `where` — looking an invite up by address is how the count is taken —
    // so the check is on the emitted object, which is the `account` block.
    const account = CODE.slice(
      CODE.indexOf("      account: {"),
      CODE.indexOf("      memberships:"),
    );
    expect(account.length).toBeGreaterThan(0);
    expect(account).not.toMatch(/user\.email\b(?!\))/);
    expect(account).toMatch(/emailDomain\(user\.email\)/);
  });

  it("does not export incident fingerprints whole", () => {
    // A fingerprint is an internal dedup identity and can name a subsystem, an
    // evidence id or a provider.
    expect(CODE).toMatch(/fingerprintFamily\(/);
    expect(CODE).not.toMatch(/fingerprint: i\.fingerprint/);
  });

  it("strips a connection string out of any error it reports", () => {
    expect(SRC).toMatch(/postgres\(\?:ql\)\?:\\\/\\\/\[\^\\s\]\*/);
    expect(SRC).toMatch(/<redacted-dsn>/);
  });
});

describe("ADM-013 Phase 2 — the diagnostic refuses the wrong database", () => {
  it("requires --expect-database with no default", () => {
    expect(CODE).toMatch(/if \(!EXPECTED_DATABASE\)/);
    // `dw` and `neondb` are both plausible and neither is verified. A default
    // would be a guess presented as a fact.
    expect(CODE).not.toMatch(/EXPECTED_DATABASE\s*=\s*arg\([^)]*\)\s*\?\?/);
  });

  it("compares current_database() BEFORE reading anything", () => {
    const guardAt = CODE.indexOf("SELECT current_database()");
    const firstRead = CODE.indexOf("prisma.operationalIncident");
    expect(guardAt).toBeGreaterThan(0);
    expect(firstRead).toBeGreaterThan(0);
    expect(
      guardAt,
      "a read is issued before the database identity is checked",
    ).toBeLessThan(firstRead);
  });

  it("exits non-zero and prints nothing to stdout when it refuses", () => {
    const block = CODE.slice(
      CODE.indexOf("if (actualDatabase !== EXPECTED_DATABASE)"),
      CODE.indexOf("process.stderr.write(`  connected to"),
    );
    expect(block).toMatch(/process\.exit\(3\)/);
    expect(block).not.toMatch(/process\.stdout\.write/);
  });
});

describe("ADM-013 Phase 2 — the output is usable and honest", () => {
  it("declares its version, its own source hash and the database it read", () => {
    expect(CODE).toMatch(/DIAGNOSTIC_VERSION/);
    expect(CODE).toMatch(/sourceSha256: sourceHash\(\)/);
    expect(CODE).toMatch(/database: actualDatabase/);
    // The commit sha is not available inside a production image — it carries
    // no .git — so the self-hash is the fact that actually exists.
    expect(SRC).toMatch(/createHash\("sha256"\)[\s\S]*?readFileSync\(__filename\)/);
  });

  it("keeps every human-readable line off stdout", () => {
    // `> diag.json` must capture valid JSON even when a section fails, so
    // progress, warnings and refusals all go to stderr.
    const stdoutWrites = [...CODE.matchAll(/process\.stdout\.write\(/g)];
    expect(stdoutWrites).toHaveLength(1);
  });

  it("records a failed section as failed, never as empty and never as zero", () => {
    expect(CODE).toMatch(/ok: false/);
    expect(SRC).toMatch(
      /Its absence is NOT a zero/,
    );
    expect(CODE).toMatch(/sectionsFailed/);
    expect(CODE).toMatch(/complete: failedSections\.length === 0/);
  });

  it("serialises BigInt rather than aborting on it", () => {
    // Postgres COUNT(*) arrives as a BigInt through some paths, and BigInt is
    // not JSON-serialisable. Converting in the replacer rather than at every
    // call site means one forgotten cast cannot lose the whole run at the last
    // step, after every query has already been paid for.
    expect(CODE).toMatch(/typeof value === "bigint" \? Number\(value\)/);
  });

  it("resolves the traced account exactly, or not at all", () => {
    // Matching on a display name is how a trace ends up describing the wrong
    // person.
    expect(CODE).toMatch(/looksLikeId/);
    expect(CODE).toMatch(/candidates\.length !== 1/);
    expect(CODE).not.toMatch(/name: \{ contains/);
    expect(CODE).not.toMatch(/email: \{ contains/);
  });

  it("asserts no causation from the traced account", () => {
    expect(SRC).toMatch(/asserts no causation/);
    // The two fields that let a reader RULE OUT the account: a scanner wrote
    // the row, and the same condition exists for tenants the account has never
    // touched.
    expect(CODE).toMatch(/openedBySystem: i\.openedBySystem/);
    expect(CODE).toMatch(/alsoOpenInThisManyWorkspaces/);
  });

  it("states that overlapping evidence cohorts overlap, and checks its own arithmetic", () => {
    expect(CODE).toMatch(/distinctAffectedEvidence/);
    expect(CODE).toMatch(/arithmeticCheck/);
    expect(CODE).toMatch(/agrees:/);
    expect(SRC).toContain("OVERLAP by `both`");
    expect(SRC).toContain("double-counts every record in the intersection");
  });

  it("states that incident-backed signals ARE the open incidents", () => {
    expect(CODE).toMatch(/incidentBackedSignals/);
    expect(CODE).toMatch(/distinctAttentionItems: openIncidents \+ additional/);
  });
});

describe("ADM-013 Phase 2 — the operator instructions are complete", () => {
  it("gives a command that prints ONLY current_database()", () => {
    expect(SRC).toMatch(/STEP 1/);
    expect(SRC).toMatch(/select current_database\(\) d/);
    // No assumed name anywhere in the instructions.
    expect(SRC).toMatch(/`dw` and `neondb` are both plausible/);
  });

  it("says the file must reach the HOST before docker cp", () => {
    expect(SRC).toMatch(/STEP 2/);
    expect(SRC).toMatch(/scp .*proovra-diagnostic\.cjs/);
    expect(SRC).toMatch(/docker cp \/tmp\/proovra-diagnostic\.cjs/);
  });

  it("explains where `> diag.json` actually writes", () => {
    expect(SRC).toMatch(/interpreted by the SHELL YOU TYPED IT IN/);
    expect(SRC).toMatch(/lands on the HOST/);
  });

  it("says to remove the copy from the container afterwards", () => {
    expect(SRC).toMatch(/docker exec .* rm -f \/tmp\/proovra-diagnostic\.cjs/);
  });
});
