/**
 * PRO-N1-06 / PRO-I1Z-01 — the one-off redaction of intake bearer links stored
 * in communication_messages.body_preview, on live PostgreSQL 16.
 *
 * Proves, against the real schema and through the real CLI entry point:
 *   - the dry run reports exactly the token-bearing rows (ids + set hash) and
 *     writes nothing;
 *   - apply replaces ONLY the bearer token (and a secret query value on that
 *     intake URL) with the fixed marker, keeps every other character, clears
 *     body_resendable on those rows, and leaves updated_at alone;
 *   - non-target rows and other tables (notification_deliveries) are untouched;
 *   - a second run finds 0 (idempotent);
 *   - a set that changed since the validated dry run is refused, as are
 *     missing approval / backup id / database fingerprint, and nothing is written;
 *   - no token value ever appears in stdout or stderr.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  APPLY_APPROVAL_ENV,
  APPLY_APPROVAL_VALUE,
  databaseFingerprint,
  redactIntakeBearer,
  runRedactStoredBearerPreviewsCli,
  setHashOf,
} from "../src/scripts/redact-stored-bearer-previews.js";
import type { IntegrationHarness } from "./integration-harness.js";

describe("redact-stored-bearer-previews (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  const tok = () => randomBytes(32).toString("base64url"); // 43 chars, like a real intake token
  const T1tok = tok();
  const T2tok = tok();
  const T2qtok = tok();
  const T3tok = tok();
  const T4tok = tok();
  const NDtok = tok();
  const allTokens = [T1tok, T2tok, T2qtok, T3tok, T4tok, NDtok];
  const longWord = "ContributorReference_ABCDEFGHIJKLMNOPQRSTUVWX"; // the old over-eager sanitizer redacted any 24+ char word

  const T1before = `PROOVRA: Acme asks for evidence. Upload: https://app.proovra.com/intake/${T1tok} (ref ${longWord})`;
  const T1after = `PROOVRA: Acme asks for evidence. Upload: https://app.proovra.com/intake/${"[secure-link]"} (ref ${longWord})`;
  const T2before = `Secure upload link: /intake/${T2tok}?lang=de&token=${T2qtok}#top — expires in 7 days`;
  const T2after = `Secure upload link: /intake/[secure-link]?lang=de&token=[secure-token]#top — expires in 7 days`;
  const T3before = `Please use https://proovra.com/intake/${T3tok}. Thank you, ${longWord}.`;
  const T3after = `Please use https://proovra.com/intake/[secure-link]. Thank you, ${longWord}.`;
  const N1 = "Need help? See https://proovra.com/intake/help for instructions.";
  const N2 = "Upload: https://proovra.com/intake/[secure-link] (already redacted)";
  const N3 = `No link here, just a reference ${longWord} and token=abcdefabcdefabcdef`;
  const NDbefore = `Secure upload link: https://proovra.com/intake/${NDtok}`;

  const ids = { T1: "", T2: "", T3: "", T4: "", N1: "", N2: "", N3: "", ND: "" };
  const DB = () => databaseFingerprint(process.env.DATABASE_URL);

  async function message(body: string, resendable: boolean): Promise<string> {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO communication_messages
        (team_id, channel, purpose, provider, recipient_hash, recipient_preview, status, body_preview, body_resendable,
         created_at, updated_at)
      VALUES (${harness.fixtures.teamA.teamId}::uuid, 'SMS', 'EVIDENCE_REQUEST', 'TWILIO', ${randomUUID().replace(/-/g, "")},
              '+••• 1234', 'DELIVERED', ${body}, ${resendable}, '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z')
      RETURNING id::text AS id`;
    return rows[0]!.id;
  }

  async function snapshot(id: string) {
    const rows = await prisma.$queryRaw<Array<{ body_preview: string | null; body_resendable: boolean; updated_at: Date; status: string }>>`
      SELECT body_preview, body_resendable, updated_at, status::text AS status FROM communication_messages WHERE id = ${id}::uuid`;
    return rows[0]!;
  }

  async function cli(argv: string[], env: Record<string, string | undefined> = {}) {
    let out = "";
    let err = "";
    const code = await runRedactStoredBearerPreviewsCli({
      argv,
      env: { DATABASE_URL: process.env.DATABASE_URL, ...env },
      client: prisma,
      out: (s) => (out += s),
      err: (s) => (err += s),
    });
    for (const t of allTokens) {
      expect(out.includes(t), "a token reached stdout").toBe(false);
      expect(err.includes(t), "a token reached stderr").toBe(false);
    }
    return { code, out, err, json: code === 0 && out ? JSON.parse(out) : null };
  }

  const approved = { [APPLY_APPROVAL_ENV]: APPLY_APPROVAL_VALUE };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ids.T1 = await message(T1before, true);
    ids.T2 = await message(T2before, false);
    ids.T3 = await message(T3before, true);
    ids.N1 = await message(N1, true);
    ids.N2 = await message(N2, false);
    ids.N3 = await message(N3, true);
    const nd = await prisma.notificationDelivery.create({
      data: {
        teamId: harness.fixtures.teamA.teamId,
        eventType: "evidence_request.sent",
        channel: "EMAIL",
        provider: "RESEND",
        recipient: "recipient@example.test",
        templateKey: "evidence_request",
        renderedPreview: NDbefore,
        status: "SENT" as never,
      },
      select: { id: true },
    });
    ids.ND = nd.id;
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("the redactor replaces only the bearer token and is idempotent", () => {
    expect(redactIntakeBearer(T1before).after).toBe(T1after);
    expect(redactIntakeBearer(T2before).after).toBe(T2after);
    expect(redactIntakeBearer(T3before).after).toBe(T3after);
    expect(redactIntakeBearer(T1after).after).toBe(T1after);
    expect(redactIntakeBearer(N1).after).toBe(N1);
    expect(redactIntakeBearer(N2).after).toBe(N2);
    expect(redactIntakeBearer(N3).after).toBe(N3);
  });

  it("dry run reports exactly the token-bearing rows with a set hash, writes nothing and prints no token", async () => {
    const before = await Promise.all([ids.T1, ids.T2, ids.T3, ids.N1, ids.N2, ids.N3].map(snapshot));
    const r = await cli(["--samples=3"]);
    expect(r.code).toBe(0);
    expect(r.json.mode).toBe("DRY_RUN");
    expect(r.json.readOnlyTransaction).toBe(true);
    const expected = [ids.T1, ids.T2, ids.T3].sort();
    expect(r.json.ids).toEqual(expected);
    expect(r.json.affectedCount).toBe(3);
    expect(r.json.setHash).toBe(setHashOf(expected));
    // CI runs every suite on one database, so other suites may leave
    // token-free "/intake/" text behind: the scan count is checked against an
    // independent count of the same predicate, and must cover this suite's five.
    const scanned = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM communication_messages WHERE body_preview LIKE '%/intake/%'`;
    expect(r.json.scannedWithIntakePath).toBe(Number(scanned[0]!.n));
    expect(r.json.scannedWithIntakePath).toBeGreaterThanOrEqual(5); // T1 T2 T3 N1 N2 contain "/intake/"
    expect(r.json.resendableToClear).toBe(2); // T1, T3
    expect(r.json.notificationDeliveriesMatchingReadOnly).toBe(1); // counted, never written
    expect(r.json.database).toBe(DB());
    expect(r.json.redactedSamples.map((s: { after: string }) => s.after).sort()).toEqual([T1after, T2after, T3after].sort());
    const after = await Promise.all([ids.T1, ids.T2, ids.T3, ids.N1, ids.N2, ids.N3].map(snapshot));
    expect(after).toEqual(before);
  });

  it("apply is refused without approval, backup id, matching database, or with a set that changed — and writes nothing", async () => {
    const dry = (await cli([])).json;
    const good = [`--expect-count=${dry.affectedCount}`, `--expect-set-hash=${dry.setHash}`, `--expect-database=${dry.database}`];

    const noApproval = await cli(["--apply", "--backup-id=pg-2026-11-21T1800Z", ...good]);
    expect(noApproval.code).toBe(2);
    expect(noApproval.err).toContain(APPLY_APPROVAL_ENV);

    const noBackup = await cli(["--apply", ...good], approved);
    expect(noBackup.code).toBe(2);
    expect(noBackup.err).toContain("--backup-id");

    const wrongDb = await cli(["--apply", "--backup-id=pg-2026-11-21T1800Z", `--expect-count=${dry.affectedCount}`, `--expect-set-hash=${dry.setHash}`, "--expect-database=0123456789abcdef"], approved);
    expect(wrongDb.code).toBe(2);
    expect(wrongDb.err).toContain("not the validated");

    const unknownFlag = await cli(["--apply", "--all"], approved);
    expect(unknownFlag.code).toBe(2);
    expect(unknownFlag.err).toContain("unknown argument");

    // The set GROWS after validation: one more token-bearing row appears.
    ids.T4 = await message(`Upload here: https://proovra.com/intake/${T4tok}`, true);
    const grown = await cli(["--apply", "--backup-id=pg-2026-11-21T1800Z", ...good], approved);
    expect(grown.code).toBe(2);
    expect(grown.err).toContain("SET_CHANGED");

    // Same count, different members: also refused.
    const swapped = await cli(
      ["--apply", "--backup-id=pg-2026-11-21T1800Z", `--expect-count=${dry.affectedCount + 1}`, `--expect-set-hash=${dry.setHash}`, `--expect-database=${dry.database}`],
      approved,
    );
    expect(swapped.code).toBe(2);
    expect(swapped.err).toContain("SET_CHANGED");

    // Nothing was written by any refused run.
    expect((await snapshot(ids.T1)).body_preview).toBe(T1before);
    expect((await snapshot(ids.T1)).body_resendable).toBe(true);
    expect((await snapshot(ids.T4)).body_preview).toContain(T4tok);
  });

  it("apply strips only the bearer portion of the validated set; non-target rows and other tables are untouched", async () => {
    const untouchedBefore = await Promise.all([ids.N1, ids.N2, ids.N3].map(snapshot));
    const targetBefore = await snapshot(ids.T1);
    const ndBefore = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: ids.ND } });
    const teamBefore = await prisma.team.findUniqueOrThrow({ where: { id: harness.fixtures.teamA.teamId } });

    const dry = (await cli([])).json;
    expect(dry.ids).toEqual([ids.T1, ids.T2, ids.T3, ids.T4].sort());
    const r = await cli(
      ["--apply", "--backup-id=pg-2026-11-21T1800Z", `--expect-count=${dry.affectedCount}`, `--expect-set-hash=${dry.setHash}`, `--expect-database=${dry.database}`],
      approved,
    );
    expect(r.code).toBe(0);
    expect(r.json.mode).toBe("APPLY");
    expect(r.json.redacted).toBe(4);
    expect(r.json.resendableCleared).toBe(3); // T1 T3 T4
    expect(r.json.backupId).toBe("pg-2026-11-21T1800Z");
    expect(r.json.ids).toEqual(dry.ids);

    const t1 = await snapshot(ids.T1);
    expect(t1.body_preview).toBe(T1after);
    expect(t1.body_resendable).toBe(false);
    expect(t1.updated_at.getTime()).toBe(targetBefore.updated_at.getTime());
    expect(t1.status).toBe(targetBefore.status);
    expect((await snapshot(ids.T2)).body_preview).toBe(T2after);
    expect((await snapshot(ids.T3)).body_preview).toBe(T3after);
    expect((await snapshot(ids.T4)).body_preview).toBe("Upload here: https://proovra.com/intake/[secure-link]");

    expect(await Promise.all([ids.N1, ids.N2, ids.N3].map(snapshot))).toEqual(untouchedBefore);
    expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: ids.ND } })).toEqual(ndBefore);
    expect(await prisma.team.findUniqueOrThrow({ where: { id: harness.fixtures.teamA.teamId } })).toEqual(teamBefore);
    expect(await prisma.communicationMessage.count({ where: { id: { in: Object.values(ids).filter(Boolean) } } })).toBe(7); // no row deleted
  });

  it("is idempotent: a second dry run finds 0 and a second apply changes nothing", async () => {
    const dry = await cli([]);
    expect(dry.code).toBe(0);
    expect(dry.json.affectedCount).toBe(0);
    expect(dry.json.ids).toEqual([]);
    expect(dry.json.setHash).toBe(setHashOf([]));
    const again = await cli(
      ["--apply", "--backup-id=pg-2026-11-21T1800Z", "--expect-count=0", `--expect-set-hash=${setHashOf([])}`, `--expect-database=${DB()}`],
      approved,
    );
    expect(again.code).toBe(0);
    expect(again.json.redacted).toBe(0);
    expect((await snapshot(ids.T1)).body_preview).toBe(T1after);
  });
});
