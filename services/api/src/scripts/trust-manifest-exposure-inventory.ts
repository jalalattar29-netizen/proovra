/**
 * TRUST-MANIFEST EXPOSURE INVENTORY — READ-ONLY, DRY-RUN ONLY (PRO-G2-01).
 *
 * Lists the ISSUED verification packages whose embedded trust manifests
 * (`intelligence/trust-manifest.json`, `methodology-manifest.json`,
 * `ai-disclosure-manifest.json`, `subprocessor-manifest.json`) the old Worker
 * builder filled with OTHER TEAMS' rows. It replays the rule that builder used
 * (four unscoped reads; see services/trust/legacy-trust-manifest-exposure.ts)
 * for every PUBLISHED package of a team-stamped record generated in the
 * window the bug existed.
 *
 * IT WRITES NOTHING AND HAS NO WRITE MODE. No row, no queue job, no object,
 * no notice, no re-issue, no revocation. Every statement runs inside a
 * `SET TRANSACTION READ ONLY` transaction, so the database refuses a write
 * even if one were added by mistake. It never reads the object store: it does
 * not open a package. Issued artifacts are never rewritten; what to do about
 * the packages it lists is the plan in the WS-OUT handoff, decided by people.
 *
 *   pnpm --filter proovra-api ops:trust-manifest-exposure-inventory -- \
 *     --until=<ISO time the fixed Worker went live> [--since=<ISO>] [--batch=500] \
 *     [--limit=1000000] [--samples=10] [--json]
 *
 *   --until   Packages generated after the fixed Worker (0db8a7c9e) was live are
 *             not affected. WITHOUT IT THE WINDOW RUNS TO NOW and packages built
 *             by the fixed Worker are listed as if affected.
 *   --since   Optional lower bound (when the Phase 4A manifests first shipped).
 *             Packages older than that carry no manifests at all.
 *   --json    One JSON document on stdout with FULL ids, for the people who
 *             carry out the notification plan. Treat that output as restricted.
 *             Without it, ids are shown by their first 8 characters only.
 *
 * It never prints an article title, a subprocessor name or any tenant content.
 *
 * Classes (one per package):
 *   FOREIGN_DISTINCT          other teams' rows were embedded and at least one
 *                             carries content this team does not itself hold
 *                             (another tenant's own article title / subprocessor)
 *   FOREIGN_DUPLICATE_ONLY    other teams' rows were embedded, each repeating
 *                             content this team also holds (the canonical seed)
 *   POSSIBLE_WITHDRAWN_ONLY   nothing still published is foreign; rows withdrawn
 *                             since may have been embedded
 *   NONE                      the old reads returned only this team's rows
 *
 * LIMITS (why this is an inventory, not proof of containment):
 *   - it replays the rule from the rows that exist NOW; a row hard-deleted since
 *     is invisible, and a withdrawn row's end time is not recorded;
 *   - a record moved to another team after the package was built is attributed
 *     to its current team;
 *   - `generated_at_utc` NULL packages (legacy) fall back to `created_at`;
 *   - the complete answer for one package is its own `intelligence/*.json`
 *     (sample check described in the handoff).
 */
import { prisma } from "../db.js";
import type { LegacyExposureClass } from "../services/trust/legacy-trust-manifest-exposure.js";
import { collectLegacyManifestExposureInventory } from "../services/trust/legacy-trust-manifest-exposure-inventory.js";

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function timeArg(name: string): Date | null {
  const raw = arg(name);
  if (raw === null) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`--${name} is not a time: ${raw}`);
  return d;
}
const short = (id: string) => id.slice(0, 8);

async function main(): Promise<void> {
  for (const refused of ["apply", "write", "fix", "execute", "notify", "revoke", "reissue"]) {
    if (process.argv.some((a) => a === `--${refused}` || a.startsWith(`--${refused}=`))) {
      throw new Error(`--${refused} is not supported: this inventory is read-only and has no write mode.`);
    }
  }
  const json = flag("json");
  const batch = Math.max(1, Math.min(Number(arg("batch") ?? 500) || 500, 2000));
  const limit = Math.max(1, Number(arg("limit") ?? 1_000_000) || 1_000_000);
  const samples = Math.max(0, Number(arg("samples") ?? 10) || 0);
  const since = timeArg("since");
  const untilGiven = timeArg("until");
  const until = untilGiven ?? new Date();

  const inventory = await collectLegacyManifestExposureInventory({ since, until, batch, limit });
  const { findings, byExposure: byClass, packagesScanned: scanned } = inventory;

  const holdingTeams = new Map<string, { packages: number; distinct: number }>();
  const sourceTeams = new Map<string, { packages: number; holdingTeams: Set<string> }>();
  const byProfile = new Map<string, number>();
  for (const f of findings) {
    const h = holdingTeams.get(f.teamId) ?? { packages: 0, distinct: 0 };
    h.packages += 1;
    if (f.exposure === "FOREIGN_DISTINCT") h.distinct += 1;
    holdingTeams.set(f.teamId, h);
    byProfile.set(f.disclosureProfile, (byProfile.get(f.disclosureProfile) ?? 0) + 1);
    for (const s of f.sourceTeamIds) {
      const entry = sourceTeams.get(s) ?? { packages: 0, holdingTeams: new Set<string>() };
      entry.packages += 1;
      entry.holdingTeams.add(f.teamId);
      sourceTeams.set(s, entry);
    }
  }

  const window = {
    sinceUtc: since?.toISOString() ?? null,
    untilUtc: until.toISOString(),
    untilWasGiven: untilGiven !== null,
  };
  const summary = {
    readOnly: true,
    window,
    packagesScanned: scanned,
    truncatedAtLimit: inventory.truncatedAtLimit,
    byExposure: byClass,
    affectedPackages: findings.length,
    affectedByProfile: Object.fromEntries(byProfile),
    holdingTeams: holdingTeams.size,
    sourceTeams: sourceTeams.size,
    affectedWithRecordedDownload: findings.filter((f) => f.recordedPackageDownloads > 0).length,
    affectedWithLivePackageLink: findings.filter((f) => f.livePackageLinks > 0).length,
    rowsReplayed: inventory.rowsReplayed,
  };

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          summary,
          holdingTeams: [...holdingTeams].map(([teamId, v]) => ({ teamId, ...v })),
          sourceTeams: [...sourceTeams].map(([teamId, v]) => ({
            teamId,
            packages: v.packages,
            holdingTeamIds: [...v.holdingTeams].sort(),
          })),
          packages: findings,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const out = (line = "") => process.stdout.write(`${line}\n`);
  out("TRUST-MANIFEST EXPOSURE INVENTORY (PRO-G2-01) — read-only; nothing was written, sent, re-issued or revoked.");
  out(`window: ${window.sinceUtc ?? "(no lower bound)"} .. ${window.untilUtc}`);
  if (!window.untilWasGiven) {
    out("WARNING: --until was not given. Packages built by the fixed Worker are inside this window and are listed as if affected.");
  }
  out(`published team packages scanned: ${scanned}${summary.truncatedAtLimit ? " (stopped at --limit)" : ""}`);
  for (const k of Object.keys(byClass) as LegacyExposureClass[]) out(`  ${k.padEnd(24)} ${byClass[k]}`);
  out(`affected packages by profile: ${[...byProfile].map(([p, n]) => `${p}=${n}`).join(", ") || "none"}`);
  out(`teams HOLDING an affected package: ${holdingTeams.size}`);
  out(`teams whose own content reached another team's package (SOURCE teams): ${sourceTeams.size}`);
  out(`affected packages with a recorded download: ${summary.affectedWithRecordedDownload}; with a live package link: ${summary.affectedWithLivePackageLink}`);
  out(`rows replayed: ${inventory.rowsReplayed.articles} articles, ${inventory.rowsReplayed.subprocessors} subprocessors (rows deleted since are not visible)`);
  if (samples > 0 && findings.length > 0) {
    out("");
    out(`samples (first ${Math.min(samples, findings.length)}; ids shortened, use --json for the full list):`);
    const ordered = [...findings].sort((a, b) => (a.exposure === b.exposure ? 0 : a.exposure === "FOREIGN_DISTINCT" ? -1 : 1));
    for (const f of ordered.slice(0, samples)) {
      out(
        `  pkg ${short(f.packageId)} v${f.version} ${f.disclosureProfile} team ${short(f.teamId)} ${f.generatedAtUtc} ${f.exposure}` +
          ` foreign articles ${f.foreignArticleRows} (distinct ${f.distinctForeignArticles}),` +
          ` subprocessors ${f.foreignSubprocessorRows} (distinct ${f.distinctForeignSubprocessors}),` +
          ` withdrawn-possible ${f.possibleWithdrawnForeignRows}, source teams ${f.sourceTeamIds.length},` +
          ` downloads ${f.recordedPackageDownloads}, live links ${f.livePackageLinks}`,
      );
    }
  }
  out("");
  out("This is an inventory, not proof of containment: see the LIMITS in this script's header and the WS-OUT handoff.");
}

main()
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
