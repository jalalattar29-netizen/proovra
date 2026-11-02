/**
 * THE RECORD BEHIND A REDACTION ID.
 *
 * `installRecordReachGuard` covers routes that name a record. Redaction's project,
 * version, region, detection, derivative and track routes name the redaction row
 * instead, so a member off a restricted case's list could read and work a redaction
 * of a record the Evidence route conceals from them. Each of those routes is listed
 * here with the row its `:id` names and the answer that row gives when it does not
 * exist, so a closed record is indistinguishable from a missing one.
 *
 * The rule itself stays `case-visibility.ts`, through `evidenceClosedTo`.
 * `record-reach-guard.contract.test.ts` fails on a redaction route with a record-row
 * `:id` that is not listed.
 */
import type { FastifyRequest } from "fastify";

import { prisma } from "../../db.js";
import { evidenceClosedTo } from "../access/record-reach.js";

type RowKind = "project" | "version" | "region" | "detection" | "derivative" | "track";
type ClosedAnswer = { status: number; body: unknown };
type Entry = { row: RowKind; answer: ClosedAnswer };

const refused = (status: number, denial: string): ClosedAnswer => ({ status, body: { denial } });
const VERSION_GONE = refused(409, "VERSION_NOT_FOUND");
const DERIVATIVE_GONE = refused(404, "DERIVATIVE_NOT_READY");

export const REDACTION_RECORD_ROUTES: Readonly<Record<string, Entry>> = {
  "GET /v1/redaction/projects/:id": { row: "project", answer: refused(404, "PROJECT_NOT_FOUND") },
  "GET /v1/redaction/projects/:id/activity": { row: "project", answer: { status: 200, body: { activity: [] } } },
  "POST /v1/redaction/projects/:id/versions": { row: "project", answer: refused(409, "PROJECT_NOT_FOUND") },
  "POST /v1/redaction/versions/:id/submit": { row: "version", answer: VERSION_GONE },
  "POST /v1/redaction/versions/:id/approve": { row: "version", answer: VERSION_GONE },
  "POST /v1/redaction/versions/:id/publish": { row: "version", answer: VERSION_GONE },
  "POST /v1/redaction/versions/:id/regions": { row: "version", answer: VERSION_GONE },
  "POST /v1/redaction/versions/:id/detect": { row: "version", answer: VERSION_GONE },
  "GET /v1/redaction/versions/:id/detections": { row: "version", answer: { status: 200, body: { detections: [] } } },
  "POST /v1/redaction/versions/:id/decisions/bulk": { row: "version", answer: VERSION_GONE },
  "POST /v1/redaction/versions/:id/derivative": { row: "version", answer: VERSION_GONE },
  "GET /v1/redaction/versions/:id/derivative": { row: "version", answer: DERIVATIVE_GONE },
  "DELETE /v1/redaction/regions/:id": { row: "region", answer: refused(409, "REGION_INVALID") },
  "POST /v1/redaction/detections/:id/decision": { row: "detection", answer: refused(409, "DETECTION_NOT_FOUND") },
  "GET /v1/redaction/derivatives/:id": { row: "derivative", answer: DERIVATIVE_GONE },
  "GET /v1/redaction/derivatives/:id/download-url": { row: "derivative", answer: DERIVATIVE_GONE },
  "POST /v1/redaction/derivatives/:id/quarantine": { row: "derivative", answer: DERIVATIVE_GONE },
  "POST /v1/redaction/video-tracks/:id/decision": { row: "track", answer: VERSION_GONE },
  "POST /v1/redaction/video-tracks/:id/split": { row: "track", answer: VERSION_GONE },
};

async function evidenceBehind(row: RowKind, id: string): Promise<string | null> {
  const viaVersion = { version: { select: { project: { select: { evidenceId: true } } } } };
  switch (row) {
    case "project":
      return (await prisma.redactionProject.findUnique({ where: { id }, select: { evidenceId: true } }))?.evidenceId ?? null;
    case "version":
      return (
        (await prisma.redactionVersion.findUnique({ where: { id }, select: { project: { select: { evidenceId: true } } } }))
          ?.project.evidenceId ?? null
      );
    case "region":
      return (await prisma.redactionRegion.findUnique({ where: { id }, select: viaVersion }))?.version.project.evidenceId ?? null;
    case "detection":
      return (await prisma.redactionDetection.findUnique({ where: { id }, select: viaVersion }))?.version.project.evidenceId ?? null;
    case "derivative":
      return (await prisma.redactionDerivative.findUnique({ where: { id }, select: viaVersion }))?.version.project.evidenceId ?? null;
    case "track":
      return (await prisma.videoTrack.findUnique({ where: { id }, select: { evidenceId: true } }))?.evidenceId ?? null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The answer for a closed record, or null when the route may go on. */
export async function closedRedactionAnswer(req: FastifyRequest, userId: string): Promise<ClosedAnswer | null> {
  const entry = REDACTION_RECORD_ROUTES[`${req.method} ${req.routeOptions.url}`];
  if (!entry) return null;
  const id = (req.params as { id?: string }).id;
  if (!id || !UUID.test(id)) return null;
  const evidenceId = await evidenceBehind(entry.row, id);
  if (!evidenceId) return null;
  return (await evidenceClosedTo(evidenceId, userId)) ? entry.answer : null;
}
