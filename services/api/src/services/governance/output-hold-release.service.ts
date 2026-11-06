/**
 * REPORT-004 — RELEASE: issue a held record's first outputs, once, when the
 * workspace output policy allows them.
 *
 * Called after the things that can change the answer: a workspace governance
 * policy update (every held record of that workspace), and a review decision
 * that approves the record (requireReviewBefore*). An explicit Generate goes
 * through `requestReportGeneration`, which lifts the hold the same way.
 *
 * EXACTLY ONCE. `tryLiftOutputHold` clears the hold with one conditional write,
 * so of any number of concurrent releases one wins; the winner's request is
 * keyed `REPORT:<id>:v0` by the shared writer, so even a repeat collapses onto
 * one row. A failure to issue after the lift is the ordinary first-issuance
 * case the worker's reconciliation already owns (the record is no longer held).
 */
import { workspaceEvidenceWhere } from "@proovra/shared-runtime";

import { prisma } from "../../db.js";
import { requestReportGeneration } from "../reports/report-generation-authority.service.js";
import { tryLiftOutputHold } from "./output-hold.service.js";

export async function releaseHeldOutputs(evidenceId: string): Promise<"released" | "still_held" | "not_held"> {
  const lift = await tryLiftOutputHold(evidenceId);
  if (lift !== "lifted") return lift;
  await requestReportGeneration({
    evidenceId,
    // The deferred completion fan-out: the first pair the completion would have
    // requested had the policy allowed it then.
    purpose: "evidence_completed",
    requestedByMachineId: "api.output-hold-release",
  });
  return "released";
}

/** Bounded: one page of a workspace's held records per call, oldest first. */
const RELEASE_PAGE = 200;

export async function releaseHeldOutputsForWorkspace(teamId: string): Promise<{ released: number; stillHeld: number }> {
  const held = await prisma.evidence.findMany({
    // The canonical workspace scope (a Personal record may carry a null team).
    where: { AND: [await workspaceEvidenceWhere(teamId, prisma), { outputsHeldAtUtc: { not: null } }] },
    select: { id: true },
    orderBy: [{ outputsHeldAtUtc: "asc" }, { id: "asc" }],
    take: RELEASE_PAGE,
  });
  let released = 0;
  let stillHeld = 0;
  for (const { id } of held) {
    const outcome = await releaseHeldOutputs(id).catch(() => "still_held" as const);
    if (outcome === "released") released += 1;
    else if (outcome === "still_held") stillHeld += 1;
  }
  return { released, stillHeld };
}
