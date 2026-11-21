/**
 * PRO-W2C2-02 — READ-ONLY ACTIVATION PREVIEW for IDENTITY_RUNTIME_SCHEDULED_ENFORCEMENT.
 *
 * In `src/`, so it ships compiled in the API image. Run it as a one-off container
 * of the deployed image, with the switch still OFF:
 *
 *   node dist/scripts/identity-runtime-enforcement-preview.js
 *
 * It reports which sessions would be auto-quarantined, which trusted devices
 * would be decayed, quarantined or revoked (and, because decay is cumulative per
 * run, how soon at the 5-minute cadence), and which idle sessions would be
 * revoked, if the switch were turned on now. It decides with the functions the
 * sweep uses (`previewScheduledIdentityRuntimeEnforcement`), so it cannot
 * describe a different set. Every statement runs on a connection Postgres holds
 * read-only, and the script refuses to start unless Postgres says so.
 *
 * Prints workspace, session and device ids, scores and counts. No name, email,
 * user id, IP or device fingerprint. Exit 0: complete. Exit 2: the run failed.
 * Exit 3: done, but the scan was truncated by its bounds.
 */
import "../env.js";

async function main(): Promise<number> {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  process.env.DATABASE_URL = url.toString();

  // After the URL is set: `db.js` connects with what it finds on import.
  const { prisma } = await import("../db.js");
  const { previewScheduledIdentityRuntimeEnforcement } = await import(
    "../services/access-control/identity-runtime-scheduled.service.js"
  );

  const readOnly = await prisma.$queryRaw<Array<{ transaction_read_only: string }>>`SHOW transaction_read_only`;
  if (readOnly[0]?.transaction_read_only !== "on") {
    console.error("preview_refused connection_is_writable");
    return 2;
  }

  const preview = await previewScheduledIdentityRuntimeEnforcement({}, prisma);
  for (const item of preview.items) console.log(JSON.stringify(item));
  console.log(
    JSON.stringify({
      summary: "IDENTITY_RUNTIME_SCHEDULED_ENFORCEMENT",
      currently: preview.enforcementCurrentlyOn ? "on" : "off (dormant)",
      generatedAtUtc: preview.generatedAtUtc,
      teamsScanned: preview.teamsScanned,
      truncated: preview.truncated,
      ...preview.totals,
    }),
  );
  return preview.truncated ? 3 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: { code?: string; name?: string } | null) => {
    console.error("preview_failed", err?.code ?? err?.name ?? "unknown");
    process.exit(2);
  });
