/**
 * PROOVRA Phase 3A Closure — Bulk detection decisions.
 *
 * Bounded helper that lets a reviewer accept / reject a list of
 * detections in one call. Each row is processed via the existing
 * `recordDetectionDecision` so the same state machine + audit hooks
 * apply — bulk is just a loop with per-row outcome reporting.
 *
 * Hard rules:
 *   * Bounded ≤ 100 detections per call.
 *   * A single failure NEVER aborts the batch.
 *   * Bounded per-row outcomes mirror the per-row vocabulary of
 *     bulk invitations: ACCEPTED / REJECTED / DEFERRED / NOT_FOUND /
 *     POLICY_DENIED / FAILED.
 */

import type { PrismaClient } from "@prisma/client";

import {
  REDACTION_DECISION_STATES,
  type RedactionDecisionState,
  type RedactionDenialReason,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { recordDetectionDecision } from "./redaction-decision.service.js";

export const REDACTION_BULK_DECISION_MAX_ROWS = 100;

export type BulkDecisionRow = {
  detectionId: string;
  decisionState: Extract<
    RedactionDecisionState,
    "ACCEPTED" | "REJECTED" | "DEFERRED"
  >;
  rationale?: string;
};

export type BulkDecisionOutcome = {
  detectionId: string;
  outcome:
    | "ACCEPTED"
    | "REJECTED"
    | "DEFERRED"
    | "NOT_FOUND"
    | "POLICY_DENIED"
    | "FAILED";
  denial: string | null;
  promotedRegionId: string | null;
};

export type BulkDecisionInput = {
  prisma?: PrismaClient;
  teamId: string;
  decidedByUserId: string;
  rows: ReadonlyArray<BulkDecisionRow>;
};

export type BulkDecisionResult =
  | { ok: true; outcomes: BulkDecisionOutcome[] }
  | { ok: false; denial: RedactionDenialReason };

export async function bulkRecordDetectionDecisions(
  input: BulkDecisionInput,
): Promise<BulkDecisionResult> {
  if (input.rows.length === 0) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.rows.length > REDACTION_BULK_DECISION_MAX_ROWS) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const outcomes: BulkDecisionOutcome[] = [];
  for (const row of input.rows) {
    if (
      !(REDACTION_DECISION_STATES as ReadonlyArray<string>).includes(
        row.decisionState,
      )
    ) {
      outcomes.push({
        detectionId: row.detectionId,
        outcome: "POLICY_DENIED",
        denial: "POLICY_REJECTED",
        promotedRegionId: null,
      });
      continue;
    }
    const res = await recordDetectionDecision({
      prisma,
      teamId: input.teamId,
      detectionId: row.detectionId,
      decisionState: row.decisionState,
      rationale: row.rationale ?? null,
      decidedByUserId: input.decidedByUserId,
    });
    if (!res.ok) {
      outcomes.push({
        detectionId: row.detectionId,
        outcome:
          res.denial === "DETECTION_NOT_FOUND"
            ? "NOT_FOUND"
            : res.denial === "POLICY_REJECTED" ||
              res.denial === "VERSION_LOCKED"
            ? "POLICY_DENIED"
            : "FAILED",
        denial: res.denial,
        promotedRegionId: null,
      });
      continue;
    }
    outcomes.push({
      detectionId: row.detectionId,
      outcome: row.decisionState,
      denial: null,
      promotedRegionId: res.promotedRegionId,
    });
  }
  return { ok: true, outcomes };
}
