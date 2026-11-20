// Configuration is loaded EXPLICITLY (PHASE 12 POINT 7), never by side effect.
import "../src/env.js";

/**
 * PRO-G1-02 — one-off re-wrap of stored webhook signing secrets.
 *
 *   Dry run (default — read-only; prints COUNTS only, never a secret):
 *     pnpm --filter proovra-api exec tsx scripts/rewrap-webhook-signing-secrets.ts
 *   Apply:
 *     pnpm --filter proovra-api exec tsx scripts/rewrap-webhook-signing-secrets.ts --apply
 *
 * WHAT IT DOES
 *   - automation_webhook_destinations.encrypted_secret: `e3.2:` (XOR keystream)
 *     -> `e3.3:` (AES-256-GCM, fresh nonce, channel AAD). The plaintext is the
 *     one the e3.2 envelope decodes to, so receivers keep verifying with the
 *     secret they already hold. No customer rotation.
 *   - webhook_endpoints.secret (lifecycle): a raw value -> `e3.3:`.
 *
 * RULES
 *   - Idempotent: rows already `e3.3:` are skipped; a second run changes nothing.
 *   - Each write is conditional on the value read (compare-and-swap), so a row
 *     rotated meanwhile is left alone and counted as `changed_meanwhile`.
 *   - Every new envelope is opened again BEFORE it is written; a row whose
 *     round trip does not reproduce the plaintext is not touched.
 *   - An `e3.2:` value that does not decode to a plausible secret (wrong
 *     AUTH_JWT_SECRET) is counted `unreadable` and left as it is.
 *   - Output is counts only: no secret, envelope or row content is printed.
 *
 * ROLLBACK LIMITS: the re-wrap is not reversible to `e3.2:` (that envelope was
 * the defect). Keep a database backup taken before --apply; restoring the two
 * columns from it restores the previous state. The API and Worker read both the
 * old and the new forms, so a rolled-back row still signs.
 *
 * KEY: AUTH_JWT_SECRET of the target environment (the API and the Worker derive
 * the same wrap key from it). Never run against a database whose environment
 * this process does not hold the key of.
 */

import { prisma } from "../src/db.js";
import { decryptLegacyXorEnvelope, decryptStoredSecret } from "../src/services/automation/automation-webhook.service.js";
import {
  readLifecycleSigningSecret,
  wrapLifecycleSigningSecret,
} from "../src/services/packaging/webhooks/webhook-platform.service.js";
import {
  isWrappedWebhookSigningSecret,
  unwrapWebhookSigningSecret,
  wrapWebhookSigningSecret,
} from "@proovra/shared-runtime/outbound";
import { getSecret } from "../src/config/runtime-secrets.js";
import { initSecretsManager, stopSecretsAuthority } from "../src/config/secrets-manager.js";

const APPLY = process.argv.includes("--apply");

/**
 * ROLLOUT-HANDOFF D5 — the key must come from the SAME authority the running
 * API and Worker read (Secrets Manager when the deployment declares it, else
 * the environment). Without hydration `getSecret` falls back to the env value,
 * and a deployment whose AUTH_JWT_SECRET lives in the bundle would re-wrap
 * every row under a key neither service holds. In `required` mode a failed
 * hydration throws here, before any row is read. Bounded log fields only.
 */
const secretsLog = {
  info: (obj: Record<string, unknown>, msg: string) => console.error(JSON.stringify({ msg, ...obj })),
  warn: (obj: Record<string, unknown>, msg: string) => console.error(JSON.stringify({ msg, ...obj })),
};

type Tally = { scanned: number; alreadyWrapped: number; rewrapped: number; wouldRewrap: number; unreadable: number; changedMeanwhile: number };
const tally = (): Tally => ({ scanned: 0, alreadyWrapped: 0, rewrapped: 0, wouldRewrap: 0, unreadable: 0, changedMeanwhile: 0 });

function keyMaterial(): string {
  const k = getSecret("AUTH_JWT_SECRET");
  if (!k) throw new Error("AUTH_JWT_SECRET is required to re-wrap webhook signing secrets");
  return k;
}

async function automation(): Promise<Tally> {
  const t = tally();
  const rows = await prisma.automationWebhookDestination.findMany({ select: { id: true, encryptedSecret: true } });
  for (const row of rows) {
    t.scanned++;
    const stored = row.encryptedSecret;
    if (isWrappedWebhookSigningSecret(stored)) { t.alreadyWrapped++; continue; }
    const plaintext = decryptLegacyXorEnvelope(stored);
    // A secret is 43 base64url characters; anything else means the wrong key.
    if (!plaintext || !/^[A-Za-z0-9_-]{20,128}$/.test(plaintext)) { t.unreadable++; continue; }
    const next = wrapWebhookSigningSecret(plaintext, keyMaterial(), "automation-webhook");
    if (unwrapWebhookSigningSecret(next, [keyMaterial()], "automation-webhook") !== plaintext || decryptStoredSecret(next) !== plaintext) {
      t.unreadable++;
      continue;
    }
    if (!APPLY) { t.wouldRewrap++; continue; }
    const r = await prisma.automationWebhookDestination.updateMany({ where: { id: row.id, encryptedSecret: stored }, data: { encryptedSecret: next } });
    if (r.count === 1) t.rewrapped++;
    else t.changedMeanwhile++;
  }
  return t;
}

async function lifecycle(): Promise<Tally> {
  const t = tally();
  const rows = await prisma.lifecycleWebhookEndpoint.findMany({ select: { id: true, secret: true } });
  for (const row of rows) {
    t.scanned++;
    const stored = row.secret;
    if (isWrappedWebhookSigningSecret(stored)) { t.alreadyWrapped++; continue; }
    if (!stored) { t.unreadable++; continue; }
    const next = wrapLifecycleSigningSecret(stored);
    if (readLifecycleSigningSecret(next) !== stored) { t.unreadable++; continue; }
    if (!APPLY) { t.wouldRewrap++; continue; }
    const r = await prisma.lifecycleWebhookEndpoint.updateMany({ where: { id: row.id, secret: stored }, data: { secret: next } });
    if (r.count === 1) t.rewrapped++;
    else t.changedMeanwhile++;
  }
  return t;
}

async function main(): Promise<void> {
  await initSecretsManager(secretsLog);
  keyMaterial();
  const result = { mode: APPLY ? "apply" : "dry-run", automation: await automation(), lifecycle: await lifecycle() };
  // Counts only.
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : "rewrap_failed");
    process.exitCode = 1;
  })
  .finally(() => {
    stopSecretsAuthority();
    return prisma.$disconnect();
  });
