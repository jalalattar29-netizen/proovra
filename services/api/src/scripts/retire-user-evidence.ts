/**
 * RETIRE ONE USER'S EVIDENCE — OPERATOR CLI (2026-10-20).
 *
 *   node dist/scripts/retire-user-evidence.js --email=<address>
 *   node dist/scripts/retire-user-evidence.js --email=<address> --apply --confirm-email=<address>
 *
 * DRY RUN BY DEFAULT. Without --apply it reads and prints; it writes nothing.
 * --apply is refused unless --confirm-email repeats the target address exactly.
 *
 * WHAT IT TOUCHES: only Evidence rows whose `createdByUserId` is EXACTLY the
 * user that address resolves to — never a record the user merely owns,
 * uploaded through someone else's session, or can see in a workspace.
 *
 * WHAT IT DOES: moves each such record to Trash through the ONE lifecycle
 * authority (`applyEvidenceLifecycleAction`, action TRASH, acting as that
 * user). That is the same recoverable soft-trash the product's Delete performs:
 * a legal hold refuses it, a locked or destroyed record refuses it, retention
 * and Object Lock continue to protect the bytes, and custody records the move.
 * It never deletes a row or an object, never touches an issued report,
 * package or custody event, and never bypasses the authority's refusals.
 *
 * AMBIGUITY: an address that names more than one account is refused.
 *
 * IDEMPOTENT: a record already in Trash is reported ALREADY_TRASHED and left
 * alone; a re-run after a partial run finishes the rest.
 */
import { pathToFileURL } from "node:url";

import type { PrismaClient } from "@prisma/client";

export type RetirementTarget = {
  id: string;
  lifecycleState: string;
  deletedAt: Date | null;
  destroyedAtUtc: Date | null;
};

export type RetirementPlan = {
  email: string;
  userId: string | null;
  records: Array<RetirementTarget & { planned: "TRASH" | "ALREADY_TRASHED" | "SKIP_DESTROYED" }>;
};

export type RetirementOutcome = {
  evidenceId: string;
  outcome: "TRASHED" | "ALREADY_TRASHED" | "SKIP_DESTROYED" | "REFUSED";
  code?: string;
  blockReason?: string;
};

function plannedFor(r: RetirementTarget): "TRASH" | "ALREADY_TRASHED" | "SKIP_DESTROYED" {
  if (r.destroyedAtUtc || r.lifecycleState === "DESTROYED") return "SKIP_DESTROYED";
  if (r.lifecycleState === "TRASHED") return "ALREADY_TRASHED";
  return "TRASH";
}

/** Read-only: who the address is, and every record that user CREATED. */
export async function planRetirement(input: { email: string; client: PrismaClient }): Promise<RetirementPlan> {
  // An address is not a unique account key (one per sign-in provider): an
  // address that names more than one account is refused, never guessed.
  const users = await input.client.user.findMany({ where: { email: input.email }, select: { id: true }, take: 2 });
  if (users.length === 0) return { email: input.email, userId: null, records: [] };
  if (users.length > 1) throw new Error("refused: the address matches more than one account; nothing was planned");
  const user = users[0]!;
  const rows = await input.client.evidence.findMany({
    where: { createdByUserId: user.id },
    select: { id: true, lifecycleState: true, deletedAt: true, destroyedAtUtc: true },
    orderBy: { id: "asc" },
  });
  return {
    email: input.email,
    userId: user.id,
    records: rows.map((r) => ({ ...r, lifecycleState: String(r.lifecycleState), planned: plannedFor({ ...r, lifecycleState: String(r.lifecycleState) }) })),
  };
}

/** Writes, through the lifecycle authority only. Never called without the confirmation. */
export async function applyRetirement(input: {
  email: string;
  confirmEmail: string;
  client: PrismaClient;
  now?: Date;
}): Promise<RetirementOutcome[]> {
  if (input.confirmEmail !== input.email) {
    throw new Error("refused: --confirm-email must repeat the target address exactly");
  }
  const plan = await planRetirement({ email: input.email, client: input.client });
  if (!plan.userId) return [];
  const { applyEvidenceLifecycleAction } = await import("../services/evidence/evidence-lifecycle.service.js");
  const out: RetirementOutcome[] = [];
  for (const r of plan.records) {
    if (r.planned !== "TRASH") {
      out.push({ evidenceId: r.id, outcome: r.planned });
      continue;
    }
    const res = await applyEvidenceLifecycleAction({
      evidenceId: r.id,
      actorUserId: plan.userId,
      action: "TRASH",
      source: "single",
      client: input.client,
      now: input.now,
    });
    if (res.ok) out.push({ evidenceId: r.id, outcome: res.changed ? "TRASHED" : "ALREADY_TRASHED" });
    else out.push({ evidenceId: r.id, outcome: "REFUSED", code: res.code, blockReason: res.blockReason });
  }
  return out;
}

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  const next = at >= 0 ? argv[at + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

async function main(): Promise<void> {
  const email = arg("email");
  if (!email) {
    console.error("usage: retire-user-evidence --email=<address> [--apply --confirm-email=<address>]");
    process.exitCode = 2;
    return;
  }
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../db.js");
  try {
    const plan = await planRetirement({ email, client: prisma });
    const counts = plan.records.reduce<Record<string, number>>((a, r) => ((a[r.planned] = (a[r.planned] ?? 0) + 1), a), {});
    console.log(JSON.stringify({ mode: apply ? "APPLY" : "DRY-RUN", userFound: plan.userId !== null, records: plan.records.length, planned: counts }, null, 2));
    if (!apply) {
      for (const r of plan.records) console.log(`${r.id}\t${r.lifecycleState}\t${r.planned}`);
      console.log("DRY-RUN: nothing was written. Re-run with --apply --confirm-email=<the same address> to move these records to Trash.");
      return;
    }
    const confirm = arg("confirm-email");
    if (confirm !== email) {
      console.error("refused: --apply requires --confirm-email repeating the target address exactly. Nothing was written.");
      process.exitCode = 2;
      return;
    }
    const outcomes = await applyRetirement({ email, confirmEmail: confirm, client: prisma });
    for (const o of outcomes) console.log(`${o.evidenceId}\t${o.outcome}${o.code ? `\t${o.code}` : ""}${o.blockReason ? `\t${o.blockReason}` : ""}`);
    const refused = outcomes.filter((o) => o.outcome === "REFUSED").length;
    if (refused > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
